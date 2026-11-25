/**
 * bili-svc's status as the agent's own token reads it: the status answer and the Reply Gate's
 * comment speaker, each reused for a short time, the agent's account card, and the account's own mid.
 */
import { navInfo } from './api.ts'
import { errorText, type RemoteBiliClient, type ServiceAccount, type ServiceStatus } from './client.ts'
import { SESSION_STATES, type AccountView, type SessionState } from './view.ts'

/** A bili-svc status answer is reused for this long. */
const STATUS_TTL_MS = 10_000
/** The Reply Gate's speaker routes change by hand, so they are reused for this long. */
const ROUTES_TTL_MS = 60_000

/** What the status reader needs of the account. */
export interface AccountStatusHost {
  /** The agent's bili-svc client. */
  readonly client: Pick<RemoteBiliClient, 'call' | 'status' | 'replyRoutes'>
  /** bili-svc's id of the agent's account. */
  readonly account: string
  /** Aborted when the account stops. */
  readonly signal: AbortSignal
  /** Debug log line. */
  debug(message: string): void
}

/** The agent's account in a status answer, with its gate and the answer; `status` is undefined when bili-svc did not answer. */
export interface AccountRead {
  readonly view: AccountView
  readonly gate: ServiceStatus['gate']
  readonly status: ServiceStatus | undefined
}

/** The account bili-svc answers for: the configured id, else the first with a working session. */
function pickAccount(accounts: readonly ServiceAccount[], id: string): ServiceAccount | undefined {
  return accounts.find(account => account.id === id) ?? accounts.find(account => account.session === 'ok')
}

/** bili-svc's status and the agent's account in it, read with the agent's own token. */
export class AccountStatus {
  /** The last status answer of bili-svc, reused for {@link STATUS_TTL_MS}. */
  private statusCache: { at: number; value: Promise<ServiceStatus> } | undefined
  /** The comment speaker's account id, reused for {@link ROUTES_TTL_MS}. */
  private routesCache: { at: number; id: Promise<string | null> } | undefined

  /** @param host - the client, the account id, the stop signal, and the debug log. */
  constructor(private readonly host: AccountStatusHost) {}

  /**
   * bili-svc's status, shared by callers within {@link STATUS_TTL_MS}; a failed answer is not reused.
   * @returns the status answer.
   */
  status(): Promise<ServiceStatus> {
    const now = Date.now()
    if (this.statusCache !== undefined && now - this.statusCache.at < STATUS_TTL_MS) return this.statusCache.value
    const value = this.host.client.status(this.host.signal)
    this.statusCache = { at: now, value }
    value.catch(() => { if (this.statusCache?.value === value) this.statusCache = undefined })
    return value
  }

  /** Drop the reused status answer, which may predate a management action. */
  forget(): void {
    this.statusCache = undefined
  }

  /**
   * The account that speaks for comments through the Reply Gate, shared by callers within {@link ROUTES_TTL_MS}.
   * @returns its id, or null when the routes cannot be read.
   */
  commentSpeaker(): Promise<string | null> {
    const now = Date.now()
    if (this.routesCache !== undefined && now - this.routesCache.at < ROUTES_TTL_MS) return this.routesCache.id
    const id = this.host.client.replyRoutes(this.host.signal).then(routes => routes.comment || null, (error: unknown): null => {
      this.host.debug(`bili: the reply routes were not read: ${errorText(error)}`)
      return null
    })
    this.routesCache = { at: now, id }
    return id
  }

  /**
   * The agent's account as bili-svc lists it, or why it cannot be read.
   * @returns the account card, the gate, and the status answer; an unreachable card when bili-svc did not answer.
   */
  async accountView(): Promise<AccountRead> {
    const checkedAt = Date.now()
    let status: ServiceStatus
    try {
      status = await this.status()
    } catch (error: unknown) {
      return { view: { account: this.host.account, session: 'unreachable', error: errorText(error), checkedAt }, gate: undefined, status: undefined }
    }
    return { view: this.accountOf(status, checkedAt), gate: status.gate, status }
  }

  /**
   * The agent's account in a status answer: the configured id, else the first with a working session.
   * @param status - the accounts of a status answer.
   * @param checkedAt - when the answer was read, Unix epoch milliseconds.
   * @returns the account card; unreachable when the answer lists no such account.
   */
  accountOf(status: { readonly accounts: readonly ServiceAccount[] }, checkedAt: number): AccountView {
    const id = this.host.account
    const account = pickAccount(status.accounts, id)
    if (account === undefined) return { account: id, session: 'unreachable', error: `bili-svc lists no account ${id}`, checkedAt }
    const session: SessionState = (SESSION_STATES as readonly string[]).includes(account.session) ? account.session as SessionState : 'missing'
    return {
      account: account.id, session, checkedAt,
      ...(account.mid > 0 ? { mid: account.mid } : {}),
      ...(account.display === '' ? {} : { uname: account.display }),
    }
  }

  /**
   * The account's own mid, which some reads and actions need; bili-svc lists it.
   * @returns the mid.
   * @throws {Error} when bili-svc cannot be asked, its session is not `ok`, or Bilibili says the account is signed out.
   */
  async selfMid(): Promise<number> {
    const { view } = await this.accountView()
    /* v8 ignore next -- an unreachable view always carries its error text, so `?? 'no answer'` is only a type fallback. */
    if (view.session !== 'ok') throw new Error(view.session === 'unreachable' ? `bili-svc cannot be asked about the account: ${view.error ?? 'no answer'}` : `the Bilibili session in bili-svc is ${view.session}; bili-svc owns the login, and the owner renews it there`)
    if (view.mid !== undefined) return view.mid
    const nav = await navInfo(this.host.client)
    if (!nav.isLogin || nav.mid === undefined) throw new Error('Bilibili says the account is signed out; bili-svc owns the login, and the owner renews it there')
    return nav.mid
  }
}
