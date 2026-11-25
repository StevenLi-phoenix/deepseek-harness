/**
 * The long-poll: fetches the owner's messages with `ilink/bot/getupdates` while the plugin is active, waits for a usable
 * account file between attempts, and backs off after failures.
 */

import type { Context } from '@deepseek-ai/cordis'
import { pause, type WakeSlot } from '@deepseek-ai/dsh-service-kit'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { IlinkClient, isStaleTokenError, type WeixinMessage } from './api.ts'
import { errorText, redact } from './errors.ts'
import type { Config } from './index.ts'
import type { AccountLink } from './link.ts'
import type { WechatAccount } from './login.ts'
import type { wechatDomain } from './storage.ts'

/** First retry delay after a failed long-poll; doubles up to {@link MAX_RETRY_MS}. */
const FIRST_RETRY_MS = 2000
const MAX_RETRY_MS = 60_000

/** What {@link LongPoll} needs of the channel. */
export interface LongPollDeps {
  readonly link: AccountLink
  readonly config: Pick<Config, 'accountPollMs' | 'longPollTimeoutMs'>
  readonly logger: Context['logger']
  /** Aborts when the channel stops. */
  readonly signal: AbortSignal
  /** Whether the channel is stopping. */
  stopping(): boolean
  /** Accept one fetched message; the loop awaits each before the next. */
  handleMessage(domain: Domain<typeof wechatDomain>, account: WechatAccount, message: WeixinMessage): Promise<void>
}

/** The long-poll loop of one channel. */
export class LongPoll {
  /** The running long-poll's controller; {@link reloadAccount} aborts it. */
  private pollAbort: AbortController | undefined
  /** Ends the current wait for the account file or the retry delay. */
  private readonly waiting: WakeSlot = { wake: undefined }

  /** @param deps - the account, timing, log, and the handler of each message. */
  constructor(private readonly deps: LongPollDeps) {}

  /**
   * Read the account file again now instead of at the next check: ends the wait for a file, cuts the
   * running long-poll (which belongs to the old account), and skips a retry delay.
   * @param reason - what changed, for the log.
   */
  reloadAccount(reason: string): void {
    this.deps.logger.info(`wechat: reading the account file again (${reason})`)
    this.pollAbort?.abort(new Error(`wechat: account reload (${reason})`))
    this.waiting.wake?.()
  }

  /** Resolve after `ms`, or as soon as the channel stops or {@link reloadAccount} is called. */
  private pause(ms: number): Promise<void> {
    return pause(ms, this.deps.signal, this.waiting)
  }

  /**
   * Long-poll until the channel stops; waits for a usable account file between attempts.
   * @param domain - the open storage domain, which holds the cursor of each bot.
   * @returns settlement once the channel stopped.
   */
  async run(domain: Domain<typeof wechatDomain>): Promise<void> {
    const { link, config, logger } = this.deps
    let failures = 0
    let timeoutMs = config.longPollTimeoutMs
    while (!this.deps.stopping()) {
      const account = link.loadAccount()
      if (account === undefined || link.isStale(account)) {
        await this.pause(config.accountPollMs)
        continue
      }
      // Created with no await since the account was read, so a reload either precedes the read or aborts this poll.
      const poll = new AbortController()
      this.pollAbort = poll
      try {
        const client = new IlinkClient({ baseUrl: account.baseUrl, token: account.botToken })
        const cursor = domain.table('cursors').get(account.botId)
        const updates = await client.getUpdates(cursor?.buf ?? '', timeoutMs, AbortSignal.any([this.deps.signal, poll.signal]))
        failures = 0
        link.recover('poll', { lastPollAt: Date.now() })
        timeoutMs = updates.nextTimeoutMs ?? config.longPollTimeoutMs
        if (updates.malformed > 0) logger.warn(`wechat: dropped ${updates.malformed} malformed message(s)`)
        // At-most-once: the cursor moves before handling, so a crash in between drops messages rather than repeating prompts.
        if (updates.buf !== undefined && updates.buf !== cursor?.buf) await domain.table('cursors').put(account.botId, { buf: updates.buf })
        for (const message of updates.messages) await this.deps.handleMessage(domain, account, message)
      } catch (error: unknown) {
        // Teardown aborts a getUpdates in flight; that failure ends the loop.
        if (this.deps.stopping()) return
        if (poll.signal.aborted) {
          // A reload cut the long-poll: read the account file again at once.
          failures = 0
          continue
        }
        if (isStaleTokenError(error)) {
          link.markStale(account)
          continue
        }
        failures += 1
        link.noteError('poll', error, account, failures)
        const wait = Math.min(FIRST_RETRY_MS * 2 ** (failures - 1), MAX_RETRY_MS)
        logger.warn(`wechat: long-poll failed (${failures} in a row): ${redact(errorText(error), account)}; retrying in ${wait / 1000}s`)
        await this.pause(wait)
      }
    }
  }
}
