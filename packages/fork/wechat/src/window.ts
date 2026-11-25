/**
 * Sending through the owner's reply window. iLink lets a bot answer only with the `context_token` of the owner's latest
 * message, a limited number of times and for a limited time. Each send counts against that window, becomes the chat's
 * latest activity, and its text is kept for reading back the owner's quotes.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { WindowClosed, WindowView } from '@deepseek-ai/dsh-wechat-settings/wechat-view'
import { IlinkApiError, ILINK_SEND_REJECTED, isStaleTokenError, ItemType } from './api.ts'
import { errorText, redact } from './errors.ts'
import type { Config } from './index.ts'
import { STOP_NOTICE_TIMEOUT_MS, type AccountLink } from './link.ts'
import type { WechatAccount } from './login.ts'
import type { ActivityRecord, SentKind, wechatDomain, WindowRecord } from './storage.ts'
import { RESTART_CUT_REPLY } from './text.ts'

/** Sent texts kept for reading back quotes, by count and by age. */
const SENT_KEEP = 200
const SENT_KEEP_MS = 30 * 24 * 60 * 60_000
/** How far a quoted message's time may lie outside a send and still match it. */
const QUOTE_MATCH_MS = 15_000

/** A usable reply window and what sending through it needs. */
export interface Target {
  account: WechatAccount
  key: string
  window: WindowRecord
}

/** An open reply window, or why there is none. */
export type WindowState = { open: Target } | { closed: WindowClosed; reason: string }

/**
 * Storage key of an outbox or sent-text row; zero-padded so keys sort like `seq`.
 * @param seq - the row's order.
 * @returns the key.
 */
export function seqKey(seq: number): string {
  return String(seq).padStart(12, '0')
}

/**
 * Storage key of the reply window between one bot and its owner.
 * @param account - the bound account.
 * @returns the key.
 */
export function windowKey(account: WechatAccount): string {
  return `${account.botId}/${account.ownerUserId}`
}

/** What {@link ReplyWindow} needs of the channel. */
export interface ReplyWindowDeps {
  readonly link: AccountLink
  readonly config: Pick<Config, 'contextTtlMs' | 'repliesPerToken'>
  readonly logger: Context['logger']
  /** Aborts when the channel stops. */
  readonly signal: AbortSignal
  /** The storage domain once it opened. */
  domain(): Domain<typeof wechatDomain> | undefined
}

/** The owner's reply window and every send through it. */
export class ReplyWindow {
  /** The latest stored reply window, readable after storage closed during teardown. */
  private lastWindow: { key: string; window: WindowRecord } | undefined

  /** @param deps - the account, window limits, log, and storage. */
  constructor(private readonly deps: ReplyWindowDeps) {}

  /**
   * The open reply window, or the code and reason it is closed.
   * @param domain - the open storage domain.
   * @returns the window to send through, or why there is none.
   */
  windowState(domain: Domain<typeof wechatDomain>): WindowState {
    const { link, config } = this.deps
    const account = link.account
    if (account === undefined) return { closed: 'no-account', reason: 'no bound account' }
    if (link.isStale(account)) return { closed: 'stale-token', reason: 'bot token is stale' }
    const key = windowKey(account)
    const window = domain.table('windows').get(key)
    if (window === undefined) return { closed: 'owner-silent', reason: 'the owner has not written yet' }
    if (Date.now() - window.receivedAt > config.contextTtlMs) return { closed: 'expired', reason: 'reply window expired' }
    if (window.exhausted || window.used >= config.repliesPerToken) return { closed: 'used-up', reason: 'reply quota used up' }
    return { open: { account, key, window } }
  }

  /**
   * The open reply window, or why there is none.
   * @param domain - the open storage domain.
   * @returns the window, or the reason as text.
   */
  target(domain: Domain<typeof wechatDomain>): Target | string {
    const state = this.windowState(domain)
    return 'open' in state ? state.open : state.reason
  }

  /**
   * The stored reply window of the bound account, open or not.
   * @returns the record, or undefined before the owner wrote or while storage is closed.
   */
  stored(): WindowRecord | undefined {
    const account = this.deps.link.account
    return account === undefined ? undefined : this.deps.domain()?.table('windows').get(windowKey(account))
  }

  /**
   * When the owner last wrote, and when and what the bot last sent the owner.
   * @returns the record, or undefined without a bound account or before any traffic.
   */
  activity(): ActivityRecord | undefined {
    const account = this.deps.link.account
    return account === undefined ? undefined : this.deps.domain()?.table('activity').get(account.ownerUserId)
  }

  /**
   * The reply window for the Settings page and for `wechat_send`'s quota check.
   * @returns whether it is open, why not, and its replies left and end.
   */
  status(): WindowView {
    const { config } = this.deps
    const domain = this.deps.domain()
    const stored = this.stored()
    const state = domain === undefined ? { closed: 'no-account' as const } : this.windowState(domain)
    return {
      open: 'open' in state,
      closed: 'open' in state ? null : state.closed,
      repliesLeft: stored === undefined ? null : stored.exhausted ? 0 : Math.max(0, config.repliesPerToken - stored.used),
      repliesPerToken: config.repliesPerToken,
      expiresAt: stored === undefined ? null : stored.receivedAt + config.contextTtlMs,
    }
  }

  /**
   * Send one text message and count it against the window.
   * @param domain - the open storage domain.
   * @param target - the open window.
   * @param text - the message text.
   * @param kind - what the message is, for the chat activity.
   * @returns `sent`, or why it was not sent.
   */
  transmit(domain: Domain<typeof wechatDomain>, target: Target, text: string, kind: SentKind): Promise<string> {
    return this.transmitItem(domain, target, { type: ItemType.TEXT, text_item: { text } }, `${text.length} chars`, kind)
  }

  /**
   * Send one message item, count it against the window, and record it as the chat's latest.
   * @param domain - the open storage domain.
   * @param target - the open window.
   * @param item - the iLink message item.
   * @param label - what the item is, for the log.
   * @param kind - what the message is, for the chat activity.
   * @returns `sent`, or why it was not sent.
   */
  async transmitItem(
    domain: Domain<typeof wechatDomain>, target: Target, item: Record<string, unknown>, label: string, kind: SentKind,
  ): Promise<string> {
    const { link, config, logger } = this.deps
    const client = link.client(target.account)
    const text = (item as { text_item?: { text?: unknown } }).text_item?.text
    const startedAt = Date.now()
    try {
      await client.sendItem(target.account.ownerUserId, item, target.window.token, this.deps.signal)
    } catch (error: unknown) {
      if (error instanceof IlinkApiError && error.ret === ILINK_SEND_REJECTED) {
        await this.putWindow(domain, target.key, { ...target.window, exhausted: true })
        // Size and slot count tell a too-long message from a used-up window, which iLink reports alike.
        const size = typeof text === 'string' ? `${Array.from(text).length} chars, ${Buffer.byteLength(text, 'utf8')} bytes` : label
        logger.info(`wechat: WeChat rejected a send (ret -2) of ${size}, after ${target.window.used}/${config.repliesPerToken} sends with this token; the reply window stays closed until the owner writes again`)
        return 'rejected by WeChat (ret -2)'
      }
      if (isStaleTokenError(error)) {
        link.markStale(target.account)
        return 'bot token is stale'
      }
      logger.warn(`wechat: send failed: ${redact(errorText(error), target.account)}`)
      link.noteError('send', error, target.account)
      return 'send failed'
    }
    const used = target.window.used + 1
    await this.putWindow(domain, target.key, { ...target.window, used })
    link.recover('send')
    await this.recordActivity(domain, target.account.ownerUserId, { sentAt: Date.now(), sent: kind })
    if (typeof text === 'string') await this.rememberSent(domain, text, startedAt)
    logger.info(`wechat: sent ${label} (${used}/${config.repliesPerToken} of this window)`)
    return 'sent'
  }

  /** Keep one sent text for {@link recallSent}: the newest {@link SENT_KEEP} within {@link SENT_KEEP_MS}. */
  private async rememberSent(domain: Domain<typeof wechatDomain>, text: string, sentAt: number): Promise<void> {
    const table = domain.table('sent')
    const now = Date.now()
    const rows = [...table.entries()].map(([, row]) => row).sort((a, b) => a.seq - b.seq)
    const seq = (rows.at(-1)?.seq ?? 0) + 1
    await table.put(seqKey(seq), { seq, text, sentAt, doneAt: now })
    const stale = rows.filter((row, index) => now - row.doneAt > SENT_KEEP_MS || index < rows.length + 1 - SENT_KEEP)
    for (const row of stale) await table.delete(seqKey(row.seq))
  }

  /**
   * The text the bot sent closest to `at`, within {@link QUOTE_MATCH_MS}: iLink gives a quoted bot
   * message only its time. Follows xmanrui/dsh-im (MIT), `state-store.mjs` `recentOutboundTextFor`.
   * @param domain - the open storage domain.
   * @param at - the quoted message's time, in Unix epoch milliseconds.
   * @returns the text, or undefined when no send lies close enough.
   */
  recallSent(domain: Domain<typeof wechatDomain>, at: number): string | undefined {
    let best: { text: string; distance: number } | undefined
    for (const [, row] of domain.table('sent').entries()) {
      const distance = at < row.sentAt ? row.sentAt - at : at > row.doneAt ? at - row.doneAt : 0
      if (distance <= QUOTE_MATCH_MS && (best === undefined || distance < best.distance)) best = { text: row.text, distance }
    }
    if (best !== undefined) this.deps.logger.info('wechat: read back the text of a quoted bot message')
    return best?.text
  }

  /**
   * Store a reply window and keep a copy for teardown.
   * @param domain - the open storage domain.
   * @param key - the window's {@link windowKey}.
   * @param window - the record to store.
   */
  async putWindow(domain: Domain<typeof wechatDomain>, key: string, window: WindowRecord): Promise<void> {
    await domain.table('windows').put(key, window)
    this.lastWindow = { key, window }
  }

  /**
   * Merge one change into the owner's chat activity.
   * @param domain - the open storage domain.
   * @param ownerUserId - the owner whose chat it is.
   * @param change - the fields to replace.
   */
  async recordActivity(domain: Domain<typeof wechatDomain>, ownerUserId: string, change: ActivityRecord): Promise<void> {
    const activity = domain.table('activity')
    await activity.put(ownerUserId, { ...activity.get(ownerUserId), ...change })
  }

  /**
   * Tell the owner a restart cut off the running chat turn. Runs during teardown, after storage may
   * have closed, so it sends straight through the last known window and records nothing; a stale
   * count only makes a later send meet `ret -2`, which already queues the text.
   * @param running - the chat Sessions whose turn the restart cuts, for the log.
   */
  async sendRestartNotice(running: readonly string[]): Promise<void> {
    const { link, config, logger } = this.deps
    const account = link.account
    const cached = this.lastWindow
    const usable = account !== undefined && !link.isStale(account) && cached !== undefined
      && cached.key === windowKey(account)
      && !cached.window.exhausted && cached.window.used < config.repliesPerToken
      && Date.now() - cached.window.receivedAt <= config.contextTtlMs
    logger.info(`wechat: stopping during a chat turn (${running.join(', ')}); ${usable ? 'telling the owner' : 'no open window to tell the owner'}`)
    if (!usable) return
    try {
      const item = { type: ItemType.TEXT, text_item: { text: RESTART_CUT_REPLY } }
      await link.client(account, STOP_NOTICE_TIMEOUT_MS).sendItem(account.ownerUserId, item, cached.window.token)
    } catch (error: unknown) {
      logger.warn(`wechat: could not tell the owner about the restart: ${errorText(error)}`)
    }
  }
}
