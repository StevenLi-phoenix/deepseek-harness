/**
 * The QR login the Settings page drives: one login at a time, started and polled over HTTP, with
 * the same core as the terminal command ({@link loginWithQr}, then {@link saveLogin}). The
 * page learns the phase, the code to scan, and the failure kind; the credentials stay in the
 * Host, which writes them to the account file and never answers with them.
 */
import { randomUUID } from 'node:crypto'
import { encode } from 'uqr'
import { LoginError, loginWithQr, saveLogin, type LoginFailure, type LoginOptions, type WechatAccount } from './login.ts'
import type { LoginFailureView, LoginPhase, LoginQr, LoginSnapshot } from './view.ts'

/** Transport and pacing of the login, replaceable in tests. */
export type LoginTransport = Pick<LoginOptions, 'fetch' | 'baseUrl' | 'pollDelayMs' | 'statusTimeoutMs' | 'maxFailures' | 'maxQrCodes'>

/** What the sessions need of their surroundings. */
export interface LoginSessionsOptions {
  /** Account file the confirmed login is written to. */
  accountFile: string
  /** Called once the account file holds the new account. */
  onBound(account: WechatAccount): void
  /** Log sink; lines never carry a token or a QR payload. */
  logger: { info(message: string): void; warn(message: string): void }
  /** Overall deadline of one login in milliseconds; default 8 minutes. */
  timeoutMs?: number
  /** Login transport overrides. */
  login?: LoginTransport
  /** Clock, replaceable in tests. */
  now?: () => number
}

/** One login and where it stands. */
interface Entry {
  readonly key: string
  readonly controller: AbortController
  readonly startedAt: number
  phase: LoginPhase
  qr: LoginQr | null
  codeRetry: boolean
  failure: LoginFailureView | null
  /** The number the login is waiting for, while the phase is `needs-code`. */
  waiter: { resolve(code: string): void; reject(reason: unknown): void } | undefined
  timer: NodeJS.Timeout | undefined
}

/** Phases a login ends in. */
const SETTLED: readonly LoginPhase[] = ['expired', 'done', 'failed']

/** Human-readable error text. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** @returns what an aborted signal stopped for: a login error here, or an error made from whatever else was given. */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new LoginError(String(reason), 'cancelled')
}

/** The modules of a QR code for a link, as the page draws them. */
function qrModules(url: string, attempt: number): LoginQr {
  const { size, data } = encode(url, { border: 0 })
  return { url, attempt, size, rows: data.map(row => row.map(dark => (dark ? '1' : '0')).join('')) }
}

/** Login endings the page words itself; every other ending reads as `other`. */
const WORDED: ReadonlySet<LoginFailure> = new Set(['verify-blocked', 'bound-elsewhere', 'timeout', 'poll-failed', 'cancelled'])

/** How a failed login's ending reads on the page. */
function failureView(code: LoginFailure | undefined): LoginFailureView {
  return code !== undefined && WORDED.has(code) ? code as LoginFailureView : 'other'
}

/**
 * The owner's QR logins started from Settings. Starting a login ends the one before it; the entry
 * of the latest login is kept after it settles, so a poll that arrives late still hears how it ended.
 */
export class LoginSessions {
  private current: Entry | undefined
  private disposed = false

  /** @param options - account file, bound hook, log sink, and test overrides. */
  constructor(private readonly options: LoginSessionsOptions) {}

  /** Whether a login is open (started and neither bound nor ended). */
  get active(): boolean {
    return this.current !== undefined && !SETTLED.includes(this.current.phase)
  }

  /**
   * Begin a login, ending any earlier one, and wait for the first code.
   * @returns the login with its first QR code, or already failed when the code could not be fetched.
   */
  async start(): Promise<LoginSnapshot> {
    this.cancelCurrent('a new login started')
    const now = this.options.now ?? Date.now
    const entry: Entry = {
      key: randomUUID(), controller: new AbortController(), startedAt: now(),
      phase: 'waiting', qr: null, codeRetry: false, failure: null, waiter: undefined, timer: undefined,
    }
    this.current = entry
    const timeoutMs = this.options.timeoutMs ?? 480_000
    entry.timer = setTimeout(() => { entry.controller.abort(new LoginError('timed out waiting for the QR code to be scanned and confirmed', 'timeout')) }, timeoutMs)
    entry.timer.unref()
    let firstCode: () => void = () => {}
    const first = new Promise<void>((resolve) => { firstCode = resolve })
    this.options.logger.info('lsy-wechat: settings login started')
    const run = this.run(entry, firstCode)
    await Promise.race([first, run])
    return this.snapshot(entry)
  }

  /**
   * Read a login.
   * @param key - the key `start` answered.
   * @returns the login, or undefined when the key names none (an older login, or none).
   */
  poll(key: string): LoginSnapshot | undefined {
    return this.current?.key === key ? this.snapshot(this.current) : undefined
  }

  /**
   * Hand the login the number WeChat shows on the phone.
   * @param key - the key `start` answered.
   * @param code - the number, already validated.
   * @returns the login after the hand-over; undefined when the key names none; `not-waiting` when the login asked for no number.
   */
  code(key: string, code: string): LoginSnapshot | 'not-waiting' | undefined {
    const entry = this.current
    if (entry?.key !== key) return undefined
    const waiter = entry.waiter
    if (entry.phase !== 'needs-code' || waiter === undefined) return 'not-waiting'
    entry.waiter = undefined
    entry.phase = 'scanned'
    waiter.resolve(code)
    this.options.logger.info('lsy-wechat: settings login: verification number handed over')
    return this.snapshot(entry)
  }

  /**
   * End a login the owner walked away from.
   * @param key - the key `start` answered.
   * @returns whether the key named an open login.
   */
  cancel(key: string): boolean {
    const entry = this.current
    if (entry?.key !== key || SETTLED.includes(entry.phase)) return false
    this.cancelCurrent('cancelled from Settings')
    return true
  }

  /**
   * End the open login, if any.
   * @param why - what ended it, for the log.
   */
  end(why: string): void {
    this.cancelCurrent(why)
  }

  /** End the open login while the channel stops. */
  dispose(): void {
    this.disposed = true
    this.cancelCurrent('the channel is stopping')
  }

  /** The login in the shape the page reads. */
  private snapshot(entry: Entry): LoginSnapshot {
    return { key: entry.key, phase: entry.phase, qr: entry.qr, codeRetry: entry.codeRetry, failure: entry.failure }
  }

  /** Abort the open login; its run settles itself as cancelled. */
  private cancelCurrent(why: string): void {
    const entry = this.current
    if (entry === undefined || SETTLED.includes(entry.phase)) return
    this.options.logger.info(`lsy-wechat: settings login ended (${why})`)
    entry.controller.abort(new LoginError(why, 'cancelled'))
    // At once, so a poll right after the cancel already reads the ending.
    this.settle(entry, 'failed', 'cancelled')
  }

  /** Mark an entry settled and release what it holds. */
  private settle(entry: Entry, phase: 'expired' | 'done' | 'failed', failure: LoginFailureView | null): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = undefined
    entry.waiter = undefined
    entry.phase = phase
    entry.qr = null
    entry.failure = failure
  }

  /** Drive one login to its end. */
  private async run(entry: Entry, firstCode: () => void): Promise<void> {
    const { signal } = entry.controller
    const started = (this.options.now ?? Date.now)()
    try {
      const result = await loginWithQr({
        ...this.options.login,
        signal,
        ...this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs },
        showQrCode: (url, attempt) => {
          entry.qr = qrModules(url, attempt)
          entry.phase = 'waiting'
          entry.codeRetry = false
          this.options.logger.info(`lsy-wechat: settings login: QR code ${attempt} ready`)
          firstCode()
        },
        onScanned: () => {
          entry.phase = 'scanned'
          this.options.logger.info('lsy-wechat: settings login: QR code scanned')
        },
        readVerifyCode: retry => new Promise<string>((resolve, reject) => {
          entry.phase = 'needs-code'
          entry.codeRetry = retry
          entry.waiter = { resolve, reject }
          if (signal.aborted) reject(abortError(signal))
          else signal.addEventListener('abort', () => { reject(abortError(signal)) }, { once: true })
          this.options.logger.info(`lsy-wechat: settings login: WeChat asks for the verification number${retry ? ' again' : ''}`)
        }),
      })
      // A login ended while its last status call was in flight must not bind.
      signal.throwIfAborted()
      let account: WechatAccount
      try {
        account = await saveLogin(this.options.accountFile, result)
      } catch (error: unknown) {
        this.settle(entry, 'failed', 'save-failed')
        this.options.logger.warn(`lsy-wechat: settings login confirmed but the account file was not written (${(error as NodeJS.ErrnoException).code ?? 'error'})`)
        return
      }
      this.settle(entry, 'done', null)
      this.options.logger.info(`lsy-wechat: settings login bound bot ${account.botId} (${(this.options.now ?? Date.now)() - started} ms)`)
      this.options.onBound(account)
    } catch (error: unknown) {
      const code = error instanceof LoginError ? error.code : undefined
      if (code === 'expired') this.settle(entry, 'expired', null)
      else this.settle(entry, 'failed', failureView(code))
      // No token exists before the scan is confirmed, so neither kind of error text can hold one.
      const line = `lsy-wechat: settings login did not bind (${code ?? 'error'}: ${errorText(error)})`
      if (code === 'cancelled' || this.disposed) this.options.logger.info(line)
      else this.options.logger.warn(line)
    } finally {
      firstCode()
    }
  }
}
