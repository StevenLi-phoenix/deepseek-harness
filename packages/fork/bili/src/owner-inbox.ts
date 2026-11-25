/**
 * The owner-message check: no model is involved. It reads the owner's conversation when something
 * is unread (the first look only records a baseline), queues new messages durably, checks every
 * minute while the owner is messaging, and hands queued messages to the account's Session, oldest
 * first, while the Session is idle. It also stores the owner's main account set in Settings.
 */
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { ownerMessages, unreadMessages, type OwnerMessage } from './api.ts'
import { errorText, type BiliCaller } from './client.ts'
import type { biliDomain } from './storage.ts'
import { ownerPrompt } from './text.ts'
import { formatStamp } from './time.ts'

/** Owner-message ids remembered. */
const MAX_SEEN = 500
/** Owner messages waiting for a turn; the oldest are dropped first. */
const MAX_PENDING = 100
/** Owner messages handed over per turn. */
const MAX_TURN_ITEMS = 20
/** After a message from the owner, messages are checked this often ... */
const FAST_POLL_MS = 60_000
/** ... for this long after the latest one. */
const CONVERSATION_MS = 900_000

/** What the owner-message check needs of the account. */
export interface OwnerInboxHost {
  readonly ready: Promise<Domain<typeof biliDomain>>
  readonly client: BiliCaller
  /** Storage work, one piece at a time. */
  serialize<T>(work: () => Promise<T>): Promise<T>
  /** Keep background work alive until the account's teardown drains it; its failure is logged. */
  track(work: Promise<void>): void
  /** The owner's main account, or undefined while unset (nothing is checked). */
  ownerMid(): number | undefined
  /**
   * Prompt the account's Session with the owner's messages unless it is busy.
   * @returns whether the prompt went in.
   */
  prompt(text: string): Promise<boolean>
  /**
   * Run `work` once after `ms`.
   * @returns a disposer that cancels it.
   */
  timeout(work: () => void, ms: number): () => void
  /** Whether the account is stopping, so no further check is armed. */
  stopping(): boolean
  /** Whether the owner is asleep, as far as presence knows. */
  ownerAsleep(): boolean
  /** IANA time zone of prompt and log times. */
  readonly timeZone: string
  logger: { info(message: string): void; warn(message: string): void }
}

/** The owner's messages: the check, the durable queue, the conversation window, and the hand-over to the Session. */
export class OwnerInbox {
  /** The owner's conversation keeps the fast message check until then. */
  private conversationUntil = 0
  /** The next fast message check, while the owner is messaging. */
  private fastPoll: (() => void) | undefined
  /** A message check is running; another one waits for the next tick. */
  private polling = false

  /** @param host - storage, the client, the owner account, prompting, timers, and the logger. */
  constructor(private readonly host: OwnerInboxHost) {}

  /**
   * Drop queued items of the retired reply and mention wakes, and their cursors.
   * @param domain - the open `bili` storage domain.
   */
  async dropRetired(domain: Domain<typeof biliDomain>): Promise<void> {
    const dropped = await this.host.serialize(async () => {
      let count = 0
      for (const [key, row] of [...domain.table('pending').entries()]) {
        if (row.kind === 'dm') continue
        await domain.table('pending').delete(key)
        count += 1
      }
      await domain.table('inbox').delete('reply')
      await domain.table('inbox').delete('at')
      return count
    })
    if (dropped > 0) this.host.logger.info(`bili: dropped ${dropped} queued reply or mention item(s): replies to strangers are bili-svc's (the up preset) now`)
  }

  /** Cancel the next fast check; the account is stopping. */
  stop(): void {
    this.fastPoll?.()
  }

  /**
   * Why the daily share should wait now: the owner sleeps, is messaging the account, or has messages queued.
   * @param now - Unix epoch milliseconds.
   * @param domain - the open `bili` storage domain.
   * @returns the reason, or undefined when nothing holds the share.
   */
  holdReason(now: number, domain: Domain<typeof biliDomain>): string | undefined {
    if (this.host.ownerAsleep()) return 'the owner is asleep'
    if (this.conversationUntil > now) return 'the owner is messaging the account'
    if (domain.table('pending').size > 0) return 'the owner\'s messages are waiting for an answer'
    return undefined
  }

  /** Check the owner's messages (no model involved) and prompt the Session for new ones. */
  async poll(): Promise<void> {
    const ownerMid = this.host.ownerMid()
    if (ownerMid === undefined || this.polling) return
    this.polling = true
    try {
      try {
        await this.collect(ownerMid)
      } catch (error: unknown) {
        this.host.logger.warn(`bili: the owner-message check failed: ${errorText(error)}`)
        return
      }
      await this.deliver()
    } finally {
      this.polling = false
    }
  }

  /**
   * Record owner messages the model has read so no turn repeats them.
   * @param items - the owner's messages a read showed.
   */
  async markSeen(items: readonly OwnerMessage[]): Promise<void> {
    await this.host.serialize(async () => {
      const domain = await this.host.ready
      const seen = new Set(domain.table('inbox').get('dm')?.seen ?? [])
      for (const item of items) {
        seen.add(item.id)
        await domain.table('pending').delete(`dm:${item.id}`)
      }
      await domain.table('inbox').put('dm', { seen: [...seen].slice(-MAX_SEEN) })
    })
  }

  /**
   * Store the owner's main account. A different UID drops the owner-message baseline, so the next
   * check records the new conversation's history instead of answering it.
   * @param mid - the owner's main account (UID).
   */
  async setOwner(mid: number): Promise<void> {
    const changed = await this.host.serialize(async () => {
      const domain = await this.host.ready
      const before = this.host.ownerMid()
      await domain.table('owner').put('main', { mid, updatedAt: Date.now() })
      if (before !== mid) await domain.table('inbox').delete('dm')
      return before !== mid
    })
    this.host.logger.info(`bili: the owner ${changed ? 'set a new' : 'saved the same'} main account UID`)
  }

  /** Fetch what changed and queue new owner messages; the first look only records a baseline. */
  private async collect(ownerMid: number): Promise<void> {
    const domain = await this.host.ready
    const baselined = domain.table('inbox').get('dm') !== undefined
    if (baselined && (await unreadMessages(this.host.client)) === 0) return
    await this.queue(await ownerMessages(this.host.client, ownerMid))
  }

  /** Queue unseen owner messages. */
  private async queue(items: readonly OwnerMessage[]): Promise<void> {
    await this.host.serialize(async () => {
      const domain = await this.host.ready
      const row = domain.table('inbox').get('dm')
      const seen = new Set(row?.seen ?? [])
      let queued = 0
      for (const item of items) {
        if (seen.has(item.id)) continue
        seen.add(item.id)
        if (row === undefined) continue
        await domain.table('pending').put(`dm:${item.id}`, { kind: 'dm', id: item.id, at: item.at, item: { kind: 'message from the owner\'s account', text: item.text } })
        queued += 1
      }
      await domain.table('inbox').put('dm', { seen: [...seen].slice(-MAX_SEEN) })
      const pending = domain.table('pending')
      const excess = [...pending.entries()].sort(([, a], [, b]) => a.at - b.at).slice(0, Math.max(0, pending.size - MAX_PENDING))
      for (const [key] of excess) await pending.delete(key)
      if (row === undefined) this.host.logger.info(`bili: owner-message baseline: ${items.length} message(s) already there`)
      else if (queued > 0) {
        this.host.logger.info(`bili: ${queued} new message(s) from the owner`)
        this.ownerSpoke(Date.now())
      }
    })
  }

  /**
   * The owner sent a message: check messages every minute until 15 minutes
   * after the latest one, so a conversation does not wait for the 10-minute check.
   */
  private ownerSpoke(now: number): void {
    const quiet = this.conversationUntil <= now
    this.conversationUntil = now + CONVERSATION_MS
    if (quiet) this.host.logger.info(`bili: the owner is messaging; checking messages every 60 s until ${formatStamp(this.conversationUntil, this.host.timeZone)} (extended by each new message)`)
    if (this.fastPoll === undefined) this.armFastPoll()
  }

  /** Arm the next fast check, or end the conversation window. */
  private armFastPoll(): void {
    if (this.host.stopping()) return
    if (Date.now() >= this.conversationUntil) {
      this.fastPoll = undefined
      this.host.logger.info('bili: the owner\'s conversation went quiet; back to the regular message check')
      return
    }
    this.fastPoll = this.host.timeout(() => {
      this.host.track(this.poll().finally(() => { this.armFastPoll() }))
    }, FAST_POLL_MS)
  }

  /** Hand queued owner messages to the Session, oldest first. */
  private async deliver(): Promise<void> {
    const domain = await this.host.ready
    const pending = [...domain.table('pending').entries()]
      .filter(([, row]) => row.kind === 'dm')
      .map(([key, row]) => ({ key, row }))
      .sort((a, b) => a.row.at - b.row.at)
    if (pending.length === 0) return
    const batch = pending.slice(0, MAX_TURN_ITEMS)
    const prompt = ownerPrompt({ now: Date.now(), timeZone: this.host.timeZone, items: batch.map(({ row }) => row.item) })
    let prompted = false
    try {
      prompted = await this.host.prompt(prompt)
    } catch (error: unknown) {
      this.host.logger.warn(`bili: prompting the Session with the owner's messages failed: ${errorText(error)}`)
    }
    if (!prompted) return
    await this.host.serialize(async () => {
      for (const { key } of batch) await domain.table('pending').delete(key)
    })
  }
}
