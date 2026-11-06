/**
 * What the Settings route does through bili-svc's management API: reading the accounts, gate, and
 * ledger, and running the owner's actions (QR sign-in, session refresh and check, logout, gate
 * mode, brake release). QR sign-ins live here: the key and URL stay on the Host and the browser
 * receives the code's modules only. Each action is logged with its account and outcome, never a
 * token, key, or URL.
 */
import { LEDGER_ROWS, ManageError, qrModules, type ManageClient, type ManageStatus } from './manage.ts'
import type { ActionResult, BiliAction, LedgerView, LoginState, LoginView } from './view.ts'

/** How long a finished sign-in (done, expired, failed) stays in the view. */
const FINISHED_MS = 8000

/** The actions that need bili-svc's management API. */
export type ManageActionBody = Exclude<BiliAction, { action: 'owner' }>

/** One QR sign-in as the Host keeps it. */
interface LoginAttempt {
  /** bili-svc's key of the code; never leaves the Host. */
  readonly key: string
  state: LoginState
  qr: readonly string[] | null
  readonly expiresAt: number
  message: string | null
  /** When it finished, or null while it waits. */
  finishedAt: number | null
}

/** What this class needs from its owner. */
export interface SettingsHooks {
  /** The management client. */
  readonly manage: ManageClient
  /** Info log line. */
  info(message: string): void
  /** Warn log line. */
  warn(message: string): void
  /** Clock, replaceable in tests. */
  now(): number
}

/** What a management read answers. */
export interface ManageSnapshot {
  readonly status: ManageStatus
  readonly ledger: LedgerView | null
}

/** Reads and actions of the Settings route that go through bili-svc's management API. */
export class ManageSettings {
  private readonly attempts = new Map<string, LoginAttempt>()

  /** @param hooks - the client, logging, and clock. */
  constructor(private readonly hooks: SettingsHooks) {}

  /**
   * Whether a manage token is set.
   * @returns true when the client has a non-empty token.
   */
  hasToken(): Promise<boolean> {
    return this.hooks.manage.hasToken()
  }

  /**
   * Read the status and the recent ledger together. A ledger that fails does not hide the status.
   * @param limit - ledger rows wanted.
   * @param signal - cancellation.
   * @throws {ManageError} when the status cannot be read.
   * @returns the status and the ledger; the ledger is null when it could not be read.
   */
  async read(limit: number = LEDGER_ROWS, signal?: AbortSignal): Promise<ManageSnapshot> {
    const [status, ledger] = await Promise.all([
      this.hooks.manage.status(signal),
      this.hooks.manage.ledger(limit, signal).catch((error: unknown): null => {
        this.hooks.warn(`bili: manage ledger not read: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }),
    ])
    return { status, ledger }
  }

  /**
   * QR sign-ins in progress or just finished, with local expiry applied.
   * @returns one view per account, expired attempts marked and finished ones dropped after they have been shown.
   */
  logins(): LoginView[] {
    const now = this.hooks.now()
    const views: LoginView[] = []
    for (const [account, attempt] of this.attempts) {
      if (attempt.finishedAt === null && now > attempt.expiresAt) this.finish(attempt, 'expired', null)
      if (attempt.finishedAt !== null && now - attempt.finishedAt > FINISHED_MS) {
        this.attempts.delete(account)
        continue
      }
      views.push({ account, state: attempt.state, qr: attempt.qr, expiresAt: attempt.expiresAt, message: attempt.message })
    }
    return views
  }

  /**
   * Run one action and log it.
   * @param action - a validated action.
   * @param signal - cancellation.
   * @returns what it did, for the answer's `result`.
   * @throws {ManageError} when bili-svc refused or did not answer.
   */
  async run(action: ManageActionBody, signal?: AbortSignal): Promise<ActionResult> {
    const started = this.hooks.now()
    const account = 'account' in action ? action.account : null
    try {
      const done = await this.perform(action, signal)
      this.hooks.info(`bili: manage ${action.action}${account === null ? '' : ` account=${account}`} → ${done.outcome} (${this.hooks.now() - started} ms)`)
      return { action: action.action, account, outcome: done.outcome, days: done.days ?? null }
    } catch (error: unknown) {
      const code = error instanceof ManageError ? error.code : 'error'
      this.hooks.warn(`bili: manage ${action.action}${account === null ? '' : ` account=${account}`} failed: ${code} (${this.hooks.now() - started} ms)`)
      throw error
    }
  }

  /** The action's work; answers a short outcome word (and the days left, for a check). */
  private async perform(action: ManageActionBody, signal: AbortSignal | undefined): Promise<{ outcome: string; days?: number | null }> {
    const { manage } = this.hooks
    switch (action.action) {
      case 'gate.mode':
        return { outcome: (await manage.setMode(action.mode, signal)).mode || action.mode }
      case 'brake.release':
        return { outcome: (await manage.releaseBrake(signal)).released ? 'released' : 'none' }
      case 'login.start': {
        const start = await manage.loginStart(action.account, signal)
        this.attempts.set(action.account, {
          key: start.key, state: 'waiting', qr: qrModules(start.url), expiresAt: start.expiresAt, message: null, finishedAt: null,
        })
        return { outcome: 'started' }
      }
      case 'login.poll': {
        const attempt = this.attempts.get(action.account)
        if (attempt === undefined) throw new ManageError('login/qr', 409, 'no_login', 'no sign-in is in progress for this account')
        if (attempt.finishedAt !== null) return { outcome: attempt.state }
        const poll = await manage.loginPoll(action.account, attempt.key, signal)
        if (poll.state === 'waiting' || poll.state === 'scanned') attempt.state = poll.state
        else this.finish(attempt, poll.state, poll.message)
        return { outcome: poll.state }
      }
      case 'login.cancel':
        this.attempts.delete(action.account)
        return { outcome: 'cancelled' }
      case 'session.refresh':
        return { outcome: (await manage.refresh(action.account, signal)).refreshed ? 'refreshed' : 'unchanged' }
      case 'session.check':
        return await manage.check(action.account, signal)
      case 'logout':
        await manage.logout(action.account, signal)
        this.attempts.delete(action.account)
        return { outcome: 'logged-out' }
      case 'ledger':
        return { outcome: 'ok' }
      default:
        return assertNever(action)
    }
  }

  /** Mark an attempt finished: the code is dropped, the state stays visible for a few seconds. */
  private finish(attempt: LoginAttempt, state: LoginState, message: string | null): void {
    attempt.state = state
    attempt.qr = null
    attempt.message = message
    attempt.finishedAt = this.hooks.now()
  }
}

/** Fail at compile time when an action has no case. */
function assertNever(value: never): never {
  throw new Error(`unhandled action ${JSON.stringify(value)}`)
}
