/**
 * The bound bot account: read from the account file, set aside once the server calls its token stale, the iLink clients
 * that use it, and the long-poll's health since it was loaded, for the Settings page.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { BackgroundWork } from '@deepseek-ai/dsh-service-kit'
import type { ChannelError, ChannelLink, ChannelView } from '@deepseek-ai/dsh-wechat-settings/wechat-view'
import { IlinkClient } from './api.ts'
import { errorText, redact } from './errors.ts'
import type { Config } from './index.ts'
import { readAccountFile, type WechatAccount } from './login.ts'
import { fitText } from './text.ts'
import type { TypingIndicator } from './typing.ts'

/** Deadline of the offline notice sent while the channel stops, and of the restart notice sent with it. */
export const STOP_NOTICE_TIMEOUT_MS = 3000

/** Longest failure text kept for the Settings page. */
const ERROR_TEXT_CHARS = 200

/** The long-poll's health since the current account was loaded. */
interface LongPollHealth {
  lastPollAt: number | undefined
  failures: number
  lastError: ChannelError | undefined
}

/** What {@link AccountLink} needs of the channel. */
export interface AccountLinkDeps {
  /** Absolute path of the account file the login writes. */
  readonly accountFile: string
  readonly config: Pick<Config, 'accountPollMs' | 'requestTimeoutMs'>
  readonly logger: Context['logger']
  /** Aborts when the channel stops. */
  readonly signal: AbortSignal
  /** Keeps the online notice, which runs in the background, for the teardown to wait on. */
  readonly background: BackgroundWork
  /** The typing line, whose ticket belongs to the account it was fetched for. */
  readonly typing: Pick<TypingIndicator, 'forgetTicket'>
}

/** The account the channel uses, whether its token still works, and how the long-poll with it fares. */
export class AccountLink {
  /** Account loaded by the latest file check. */
  private current: WechatAccount | undefined
  /** Last logged account state, so each change is logged once. */
  private accountState = ''
  /** Account state the server was last told is online. */
  private onlineState = ''
  /** Bot token the server declared stale; the loop waits for a different one. */
  private staleToken: string | undefined
  /** The long-poll's health since the current account was loaded, for {@link status}. */
  private health: LongPollHealth = { lastPollAt: undefined, failures: 0, lastError: undefined }

  /** @param deps - the account file, timing, log, and what an account change resets. */
  constructor(private readonly deps: AccountLinkDeps) {}

  /** The account the latest file check loaded, stale or not; undefined without a usable file. */
  get account(): WechatAccount | undefined {
    return this.current
  }

  /**
   * Whether the server declared this account's token stale.
   * @param account - the account to check.
   * @returns true until the account file carries another token.
   */
  isStale(account: WechatAccount): boolean {
    return account.botToken === this.staleToken
  }

  /**
   * Re-read the account file and log each state change once. A change resets the typing ticket and the long-poll's
   * health; an account that became usable is announced to iLink in the background.
   * @returns the account the file holds, or undefined when it holds none.
   */
  loadAccount(): WechatAccount | undefined {
    const { accountFile, config, logger } = this.deps
    const read = readAccountFile(accountFile)
    const state = read.kind === 'ok' ? `ok:${read.account.botId}:${read.account.ownerUserId}:${read.account.boundAt}` : read.kind
    if (state !== this.accountState) {
      this.accountState = state
      if (read.kind === 'missing') {
        logger.info(`wechat: no account at ${accountFile}; run fork/deploy/wechat-login.mjs to bind a bot (re-checking every ${config.accountPollMs / 1000}s)`)
      } else if (read.kind === 'invalid') {
        logger.warn(`wechat: account file ${accountFile} is unusable: ${read.reason}`)
      } else {
        logger.info(`wechat: bot ${read.account.botId} active for owner ${read.account.ownerUserId}`)
      }
      this.deps.typing.forgetTicket()
      this.health = { lastPollAt: undefined, failures: 0, lastError: undefined }
      if (read.kind === 'missing') this.onlineState = ''
    }
    this.current = read.kind === 'ok' ? read.account : undefined
    if (read.kind === 'ok' && state !== this.onlineState) {
      this.onlineState = state
      this.deps.background.track(this.notifyLifecycle('start'))
    }
    return this.current
  }

  /**
   * Stop using a token the server rejected as stale until the account file carries another.
   * @param account - the account whose token the server rejected.
   */
  markStale(account: WechatAccount): void {
    if (this.staleToken === account.botToken) return
    this.staleToken = account.botToken
    this.deps.logger.error(`wechat: the token of bot ${account.botId} is stale (errcode -14); run fork/deploy/wechat-login.mjs again. Re-checking ${this.deps.accountFile} every ${this.deps.config.accountPollMs / 1000}s`)
  }

  /**
   * Remember the latest failure for {@link status}, with the account's token removed from the text.
   * @param where - the kind of call that failed.
   * @param error - what it threw.
   * @param account - the account it used, whose token is removed.
   * @param failures - the long-poll's failure streak, when a long-poll failed.
   */
  noteError(where: ChannelError['where'], error: unknown, account: WechatAccount, failures?: number): void {
    const text = redact(errorText(error), account).replaceAll(/\s+/gu, ' ').trim()
    this.health = {
      ...this.health,
      ...failures === undefined ? {} : { failures },
      lastError: { at: Date.now(), where, text: fitText(text, ERROR_TEXT_CHARS) },
    }
  }

  /**
   * A call of kind `where` worked again: the failure it left in {@link status} is stale and goes, a failure of the other kind stays.
   * A good poll also resets the failure streak.
   * @param where - the kind of call that worked.
   * @param update - the time of the poll that came back.
   */
  recover(where: ChannelError['where'], update: { lastPollAt?: number } = {}): void {
    const stale = this.health.lastError?.where === where
    this.health = {
      ...this.health,
      ...update,
      ...where === 'poll' ? { failures: 0 } : {},
      ...stale ? { lastError: undefined } : {},
    }
    if (stale) this.deps.logger.info(`wechat: ${where} works again; cleared its last error from the status`)
  }

  /**
   * The bound account, unless there is none or its token went stale.
   * @returns the account to send with.
   * @throws when there is no bound account or its token is stale.
   */
  usableAccount(): WechatAccount {
    const account = this.current
    if (account === undefined) throw new Error('no bound account')
    if (this.isStale(account)) throw new Error('bot token is stale')
    return account
  }

  /**
   * A client for one account with the configured request deadline.
   * @param account - the account whose base URL and token the client uses.
   * @param timeoutMs - deadline of each request.
   * @returns the client.
   */
  client(account: WechatAccount, timeoutMs = this.deps.config.requestTimeoutMs): IlinkClient {
    return new IlinkClient({ baseUrl: account.baseUrl, token: account.botToken, timeoutMs })
  }

  /**
   * Tell iLink the bot went online or offline; a failure is logged and ignored.
   * @param phase - `start` when an account became usable, `stop` while the channel stops.
   */
  async notifyLifecycle(phase: 'start' | 'stop'): Promise<void> {
    let account: WechatAccount
    try {
      account = this.usableAccount()
    } catch {
      return
    }
    try {
      if (phase === 'start') await this.client(account).notifyStart(this.deps.signal)
      else await this.client(account, STOP_NOTICE_TIMEOUT_MS).notifyStop()
      this.deps.logger.debug(`wechat: notify${phase} sent`)
    } catch (error: unknown) {
      this.deps.logger.warn(`wechat: notify${phase} failed: ${errorText(error)}`)
    }
  }

  /**
   * The long-poll's part of the Settings page's channel health.
   * @returns where the long-poll stands, its failure streak, and its latest failure.
   */
  status(): Pick<ChannelView, 'link' | 'lastPollAt' | 'failures' | 'lastError'> {
    const account = this.current
    let link: ChannelLink
    if (account === undefined) link = 'idle'
    else if (this.isStale(account)) link = 'stale'
    else if (this.health.failures > 0) link = 'retrying'
    else link = this.health.lastPollAt === undefined ? 'starting' : 'connected'
    return {
      link,
      lastPollAt: this.health.lastPollAt ?? null,
      failures: this.health.failures,
      lastError: this.health.lastError ?? null,
    }
  }
}
