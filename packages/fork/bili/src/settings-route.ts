/**
 * The Settings route (`/api/bili`): `GET` answers the Settings view, `POST` takes one owner action
 * (the owner's main account, the daily share's switch or an immediate share, or a management action
 * under the manage token) and answers the new view. bili-svc's refusals map to the route's own
 * HTTP statuses, so the browser never sees bili-svc's 401 or 403.
 */
import { parseAction } from './actions.ts'
import { LEDGER_MAX_ROWS, LEDGER_ROWS, ManageError } from './manage.ts'
import type { ManageSettings } from './settings.ts'
import type { DailyShare } from './share.ts'
import type { AccountStatus } from './status.ts'
import type { ActionResult, BiliView } from './view.ts'

/** What the Settings route needs of the account. */
export interface SettingsRouteHost {
  /**
   * The Settings view.
   * @returns the view after `result`, with `ledgerRows` ledger rows.
   */
  view(result: ActionResult | null, ledgerRows: number): Promise<BiliView>
  /** Management actions under the manage token. */
  readonly settings: Pick<ManageSettings, 'hasToken' | 'run'>
  /** bili-svc's status as the agent's own token reads it. */
  readonly status: Pick<AccountStatus, 'accountView' | 'forget'>
  /** The daily share's switch and immediate share. */
  readonly share: Pick<DailyShare, 'setEnabled' | 'sendNow'>
  /** Store the owner's main account (UID). */
  setOwner(mid: number): Promise<void>
  /** Name of the credential holding the manage token. */
  readonly manageTokenEnv: string
}

/** The HTTP status the Settings route answers for a refused management call; the browser never sees bili-svc's 401/403. */
function manageStatus(error: ManageError): number {
  if (error.status === 404 || error.status === 409) return error.status
  if (error.status === 400 || error.status === 422) return 400
  return 502
}

/** The words of a refused management call: bili-svc's message, else a line for its code. */
function manageMessage(error: ManageError): string {
  if (error.status === 401 || error.code === 'forbidden') return 'bili-svc did not accept the manage token'
  return error.detail === '' ? error.code : error.detail
}

/** The Settings section's route. */
export class SettingsRoute {
  /** @param host - the view, the management actions, the status cache, the daily share, and the owner account. */
  constructor(private readonly host: SettingsRouteHost) {}

  /**
   * Answer one request: `GET` answers the view; `POST` takes one owner action and answers the new view.
   * @param request - the buffered request.
   * @returns the JSON response, never cached.
   */
  async handle(request: Request): Promise<Response> {
    const headers = { 'cache-control': 'no-store' }
    if (request.method !== 'POST') {
      const asked = Number(new URL(request.url).searchParams.get('ledger'))
      const rows = Number.isInteger(asked) && asked > 0 ? Math.min(asked, LEDGER_MAX_ROWS) : LEDGER_ROWS
      return Response.json(await this.host.view(null, rows), { headers })
    }
    if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return Response.json({ error: 'expected application/json' }, { status: 415, headers })
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return Response.json({ error: 'body is not JSON' }, { status: 400, headers })
    }
    const parsed = parseAction(body)
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400, headers })
    const { action } = parsed
    if (action.action === 'owner') {
      const { view } = await this.host.status.accountView()
      if (action.mid === view.mid) return Response.json({ error: 'mid is this account itself, not the owner\'s main account' }, { status: 400, headers })
      await this.host.setOwner(action.mid)
      return Response.json(await this.host.view(null, LEDGER_ROWS), { headers })
    }
    // The daily share is DSH's own: no manage token needed.
    if (action.action === 'share.enabled') {
      await this.host.share.setEnabled(action.enabled)
      return Response.json(await this.host.view({ action: action.action, account: null, outcome: action.enabled ? 'on' : 'off', days: null }, LEDGER_ROWS), { headers })
    }
    if (action.action === 'share.now') {
      const outcome = await this.host.share.sendNow()
      return Response.json(await this.host.view({ action: action.action, account: null, outcome, days: null }, LEDGER_ROWS), { headers })
    }
    if (!await this.host.settings.hasToken()) {
      return Response.json({ error: `the manage token is not set (credential ${this.host.manageTokenEnv})`, code: 'no_token' }, { status: 403, headers })
    }
    try {
      const result = await this.host.settings.run(action, request.signal)
      // The agent's own status answer may predate the change.
      this.host.status.forget()
      return Response.json(await this.host.view(result, action.action === 'ledger' ? action.limit : LEDGER_ROWS), { headers })
    } catch (error: unknown) {
      this.host.status.forget()
      if (!(error instanceof ManageError)) throw error
      return Response.json({ error: manageMessage(error), code: error.code }, { status: manageStatus(error), headers })
    }
  }
}
