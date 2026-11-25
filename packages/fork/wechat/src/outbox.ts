/**
 * The path every text for the owner takes, and the durable outbox behind it. A text is split into messages that go out
 * through the open reply window; a message that cannot go now waits in the outbox with its reason and goes out in a digest
 * when the owner writes again. While the owner sleeps, a reply or note that is not urgent waits for the morning, and an
 * agent may hold a text until a time.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Presence } from '@deepseek-ai/dsh-presence'
import type { BackgroundWork } from '@deepseek-ai/dsh-service-kit'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { Config } from './index.ts'
import type { AccountLink } from './link.ts'
import type { OutboxRecord, SentKind, wechatDomain } from './storage.ts'
import { buildDigest, QUOTA_FOOTER, splitText, WECHAT_MAX_TEXT_BYTES } from './text.ts'
import { seqKey, type ReplyWindow } from './window.ts'

/** Longest wait an agent may ask {@link Outbox.holdDelivery} for. */
const MAX_HOLD_MS = 7 * 86_400_000

/** What {@link Outbox.deliver} made of one text: its messages, how many went out now, and why the rest wait. */
export interface DeliverReport {
  /** Messages the text was split into. */
  readonly parts: number
  /** Messages sent through the open reply window. */
  readonly sent: number
  /** Why each message that did not go out now waits (outbox reason, or `owner asleep`). */
  readonly queued: readonly string[]
  /** True when the owner is asleep and the text was held for the morning. */
  readonly held: boolean
}

/** What {@link Outbox.holdDelivery} did: how many messages it queued, or why it queued none. */
export type HoldResult =
  | { held: number; until?: number; wakes: boolean }
  | { notHeld: string }

/** What {@link Outbox} needs of the channel. */
export interface OutboxDeps {
  /** The storage domain, once open. */
  readonly ready: Promise<Domain<typeof wechatDomain>>
  readonly link: AccountLink
  readonly window: ReplyWindow
  /** Serializes every storage change and keeps the hold timer's work for the teardown. */
  readonly background: BackgroundWork
  readonly config: Pick<Config, 'awakeAfterMessageMs' | 'chat' | 'maxMessageChars' | 'maxReplyParts' | 'outboxLimit' | 'repliesPerToken'>
  readonly logger: Context['logger']
  /** The storage domain once it opened. */
  domain(): Domain<typeof wechatDomain> | undefined
  /** `ctx.presence` while it is mounted. */
  presence(): Pick<Presence, 'isAsleep'> | undefined
  /** Whether the channel is stopping. */
  stopping(): boolean
}

/** The delivery path, the outbox, and the holds for the owner's sleep and for a time. */
export class Outbox {
  /** Fires when the earliest text an agent asked to hold comes due. */
  private holdTimer: NodeJS.Timeout | undefined

  /** @param deps - storage, the reply window, limits, presence, and log. */
  constructor(private readonly deps: OutboxDeps) {}

  /**
   * Texts waiting for the owner's next message, oldest first.
   * @returns snapshot of the outbox.
   */
  rows(): OutboxRecord[] {
    const table = this.deps.domain()?.table('outbox')
    return table === undefined ? [] : [...table.entries()].map(([, row]) => row).sort((a, b) => a.seq - b.seq)
  }

  /**
   * Texts held for the owner's sleep.
   * @returns how many outbox rows wait for the owner to wake.
   */
  heldCount(): number {
    return this.rows().filter(row => row.deferred === true).length
  }

  /**
   * Split one text into messages and send or queue each in order; while the owner sleeps, a text that is
   * not urgent is queued for the morning instead (the log names its kind and count, never its text).
   * @param raw - the text for the owner.
   * @param kind - what the text is.
   * @param options - `urgent` passes the owner's sleep; `events` names the bus events of a note, for the log.
   * @returns how many messages went out and why the rest wait.
   */
  deliver(
    raw: string, kind: SentKind, options: { urgent?: boolean; events?: readonly string[] | undefined } = {},
  ): Promise<DeliverReport> {
    // An unpaired surrogate (a cut emoji in model output) makes sendmessage fail with ret -1.
    const text = raw.toWellFormed()
    return this.deps.background.serialize(async (): Promise<DeliverReport> => {
      const domain = await this.deps.ready
      const parts = this.split(text)
      if (this.holdsBack(domain, kind, options.urgent === true)) {
        for (const part of parts) await this.enqueue(domain, part, 'owner asleep', true)
        const events = options.events === undefined || options.events.length === 0 ? '' : `, events ${options.events.join(' ')}`
        this.deps.logger.info(`wechat: held ${parts.length} ${kind} message(s) while the owner sleeps${events}; ${this.heldCount()} held`)
        return { parts: parts.length, sent: 0, queued: parts.map(() => 'owner asleep'), held: true }
      }
      let sent = 0
      const queued: string[] = []
      for (const part of parts) {
        const outcome = await this.deliverPart(domain, part, kind)
        if (outcome === 'sent') sent += 1
        else queued.push(outcome)
      }
      return { parts: parts.length, sent, queued, held: false }
    })
  }

  /** Split a text into messages that leave room for the quota footer. */
  private split(text: string): string[] {
    const { config } = this.deps
    const chars = config.maxMessageChars - Array.from(QUOTA_FOOTER).length
    const bytes = WECHAT_MAX_TEXT_BYTES - Buffer.byteLength(QUOTA_FOOTER, 'utf8')
    return splitText(text, chars, config.maxReplyParts, bytes)
  }

  /** Send one message through the open window, or queue it with the reason it cannot go now; returns `sent` or that reason. */
  private async deliverPart(domain: Domain<typeof wechatDomain>, text: string, kind: SentKind): Promise<string> {
    const target = this.deps.window.target(domain)
    if (typeof target === 'string') {
      await this.enqueue(domain, text, target)
      return target
    }
    const last = target.window.used + 1 >= this.deps.config.repliesPerToken
    const outcome = await this.deps.window.transmit(domain, target, last ? `${text}${QUOTA_FOOTER}` : text, kind)
    if (outcome !== 'sent') await this.enqueue(domain, text, outcome)
    return outcome
  }

  /**
   * Whether a text of this kind waits for the morning: the owner sleeps, the text is a reply or a note that is
   * not urgent, and the owner has not written lately.
   */
  private holdsBack(domain: Domain<typeof wechatDomain>, kind: SentKind, urgent: boolean): boolean {
    if (urgent || (kind !== 'reply' && kind !== 'note')) return false
    if (this.deps.presence()?.isAsleep() !== true) return false
    const account = this.deps.link.account
    const ownerAt = account === undefined ? undefined : domain.table('activity').get(account.ownerUserId)?.ownerAt
    return ownerAt === undefined || Date.now() - ownerAt >= this.deps.config.awakeAfterMessageMs
  }

  /**
   * Whether a reply would wait for the morning, as {@link deliver} decides it.
   * @param urgent - the answer passes the owner's sleep.
   * @returns true when the owner sleeps and the answer is held.
   */
  holdsReply(urgent: boolean): Promise<boolean> {
    return this.deps.background.serialize(async () => this.holdsBack(await this.deps.ready, 'reply', urgent))
  }

  /**
   * Hold a text the agent asked to defer. It goes to the owner inside a digest when `until` comes, or as soon as the owner wakes if that
   * is first; the owner's own messages do not release it earlier. Without `until` the owner has to be asleep now, since a text with no
   * time and no sleep to wait for would never be due.
   * @param raw - the text for the owner.
   * @param until - Unix epoch milliseconds, at most a week away.
   * @returns how many messages were queued, or why none were.
   */
  async holdDelivery(raw: string, until?: number): Promise<HoldResult> {
    const text = raw.toWellFormed().trim()
    if (text === '') return { notHeld: 'the text is empty' }
    const now = Date.now()
    if (until !== undefined && until <= now) return { notHeld: 'until is not in the future' }
    if (until !== undefined && until - now > MAX_HOLD_MS) return { notHeld: 'until is more than 7 days away' }
    const wakes = this.deps.presence()?.isAsleep() === true
    if (until === undefined && !wakes) return { notHeld: 'the owner is awake: put the text in your answer, or give a time with until' }
    return this.deps.background.serialize(async (): Promise<HoldResult> => {
      const domain = await this.deps.ready
      const parts = this.split(text)
      for (const part of parts) await this.enqueue(domain, part, 'the agent asked to defer it', true, until)
      this.armHold()
      const when = until === undefined ? 'until the owner wakes' : `until ${new Date(until).toISOString()}`
      this.deps.logger.info(`wechat: held ${parts.length} message(s) the agent asked to defer, ${when}`)
      return { held: parts.length, ...until === undefined ? {} : { until }, wakes }
    })
  }

  /**
   * Send what the outbox can send now as digests, and let the texts that remain wait for the next
   * reply window as ordinary outbox texts.
   * @param why - what asked for it, for the log.
   * @returns how many texts went out.
   */
  releaseDeferred(why: string): Promise<number> {
    return this.deps.background.serialize(async () => {
      const domain = await this.deps.ready
      const held = this.heldCount()
      if (held === 0) return 0
      // A text held until a time goes with the wake when that comes first.
      for (const row of this.rows()) {
        if (row.releaseAt !== undefined) await domain.table('outbox').put(seqKey(row.seq), { seq: row.seq, text: row.text, queuedAt: row.queuedAt, deferred: true })
      }
      const sent = await this.flushOutbox(domain)
      let kept = 0
      for (const row of this.rows()) {
        if (row.deferred !== true) continue
        kept += 1
        await domain.table('outbox').put(seqKey(row.seq), { seq: row.seq, text: row.text, queuedAt: row.queuedAt })
      }
      this.deps.logger.info(`wechat: ${why}; ${held} held text(s): ${sent} sent, ${kept} left for the next reply window`)
      this.armHold()
      return sent
    })
  }

  /** Arm the one timer for the earliest text an agent asked to hold until a time. */
  armHold(): void {
    this.clearHold()
    if (this.deps.stopping()) return
    const times = this.rows().flatMap(row => row.releaseAt === undefined ? [] : [row.releaseAt])
    if (times.length === 0) return
    this.holdTimer = setTimeout(() => {
      this.holdTimer = undefined
      this.deps.background.track(this.releaseDue().then(() => undefined))
    }, Math.max(0, Math.min(...times) - Date.now()))
  }

  /** Cancel the timer of {@link armHold}. */
  clearHold(): void {
    if (this.holdTimer !== undefined) clearTimeout(this.holdTimer)
    this.holdTimer = undefined
  }

  /**
   * Send the held texts whose time has come as digests, even while the owner still sleeps (the agent chose the time), and let the
   * ones the reply window cannot take wait as ordinary outbox texts.
   * @returns how many texts went out.
   */
  private releaseDue(): Promise<number> {
    return this.deps.background.serialize(async () => {
      const domain = await this.deps.ready
      const now = Date.now()
      const comes = (row: OutboxRecord): boolean => row.releaseAt !== undefined && row.releaseAt <= now
      const due = this.rows().filter(comes)
      if (due.length === 0) {
        this.armHold()
        return 0
      }
      const sent = await this.flushOutbox(domain, due)
      let kept = 0
      for (const row of this.rows().filter(comes)) {
        kept += 1
        await domain.table('outbox').put(seqKey(row.seq), { seq: row.seq, text: row.text, queuedAt: row.queuedAt })
      }
      this.deps.logger.info(`wechat: ${due.length} deferred text(s) came due: ${sent} sent, ${kept} left for the next reply window`)
      this.armHold()
      return sent
    })
  }

  /** Queue one text; a full outbox drops its oldest texts. */
  private async enqueue(
    domain: Domain<typeof wechatDomain>, text: string, reason: string, deferred = false, releaseAt?: number,
  ): Promise<void> {
    const outbox = domain.table('outbox')
    const rows = this.rows()
    const victims = rows.slice(0, Math.max(0, rows.length - this.deps.config.outboxLimit + 1))
    for (const row of victims) await outbox.delete(seqKey(row.seq))
    if (victims.length > 0) this.deps.logger.warn(`wechat: outbox full; dropped the ${victims.length} oldest text(s)`)
    const seq = (rows.at(-1)?.seq ?? 0) + 1
    const held = { ...deferred ? { deferred } : {}, ...releaseAt === undefined ? {} : { releaseAt } }
    await outbox.put(seqKey(seq), { seq, text, queuedAt: Date.now(), ...held })
    this.deps.logger.info(`wechat: queued ${text.length} chars (${reason}); ${outbox.size} waiting`)
  }

  /**
   * Send queued texts as digests while the window has more than one slot left; the last slot stays for the reply.
   * Run it inside {@link BackgroundWork.serialize}.
   * @param domain - the open storage domain.
   * @param only - the rows to send; by default every row except those held until a later time.
   * @returns how many texts went out.
   */
  async flushOutbox(domain: Domain<typeof wechatDomain>, only?: readonly OutboxRecord[]): Promise<number> {
    const { window, config, logger } = this.deps
    // A text held until a time stays in the outbox until then, whoever else flushes it.
    const now = Date.now()
    let rows = only ?? this.rows().filter(row => row.releaseAt === undefined || row.releaseAt <= now)
    let sent = 0
    while (rows.length > 0) {
      const target = window.target(domain)
      if (typeof target === 'string' || target.window.used + 1 >= config.repliesPerToken) return sent
      const digest = buildDigest(rows, config.maxMessageChars, config.chat.timeZone)
      if (await window.transmit(domain, target, digest.text, 'digest') !== 'sent') return sent
      for (const row of rows.slice(0, digest.count)) await domain.table('outbox').delete(seqKey(row.seq))
      logger.info(`wechat: delivered ${digest.count} queued text(s) as one digest`)
      sent += digest.count
      rows = rows.slice(digest.count)
    }
    return sent
  }
}
