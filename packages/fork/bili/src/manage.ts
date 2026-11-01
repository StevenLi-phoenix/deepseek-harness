/**
 * The Settings route's own door to bili-svc: its management API (`/v1/manage/*` and the full
 * `GET /v1/status`), under a token of scope `manage` that is separate from the agent's. Only
 * the Settings route in `index.ts` constructs this client; no agent tool, and nothing reachable
 * from `ctx.bili`'s public methods, holds it (`tests/remote-client.spec.ts` fails if a tool
 * package names a management route or this client). Answers are parsed into the view types
 * field by field and every text is bounded, because bili-svc relays third-party words (a draft,
 * a verdict, Bilibili's refusal reasons). A QR sign-in's key and URL pass through here and
 * stay out of logs; the URL leaves only as a QR image.
 */
import { encode } from 'uqr'
import { parseJson } from './client.ts'
import { clean } from './text.ts'
import type { BrakeView, GateMode, LedgerRow, LedgerView, LoginState, RefreshMode, UsageCounts } from './view.ts'
import { LOGIN_STATES, REFRESH_MODES, SESSION_STATES, type SessionState } from './view.ts'

/** Credential name used when the configuration names none. */
export const DEFAULT_MANAGE_CREDENTIAL = 'BILI_SVC_TOKEN_MANAGE'
/** Deadline of a management read or a gate change. */
export const MANAGE_TIMEOUT_MS = 30_000
/** Deadline of a session refresh or check, which call Bilibili. */
export const SESSION_TIMEOUT_MS = 60_000
/** Ledger rows the view carries. */
export const LEDGER_ROWS = 20
/** Most ledger rows one request asks for. */
export const LEDGER_MAX_ROWS = 100
/** Largest answer read. */
const MAX_BODY_CHARS = 4 * 1024 * 1024
/** Counters kept of the ledger summary. */
const MAX_SUMMARY = 24

/**
 * bili-svc refused or could not complete a management call. Never carries request data, the
 * token, or a QR key.
 */
export class ManageError extends Error {
  /**
   * @param route - the management route, without ids or keys.
   * @param status - HTTP status; 0 when no answer came.
   * @param code - bili-svc's `error` code (`mode_refused`, `not_owner`, …) or a local one (`no_token`, `transport`).
   * @param detail - bili-svc's `message`, bounded.
   */
  constructor(readonly route: string, readonly status: number, readonly code: string, readonly detail: string) {
    super(detail === '' ? `${route}: ${code}` : `${route}: ${code} (${detail})`)
    this.name = 'ManageError'
  }
}

/** One account as the full `GET /v1/status` lists it. */
export interface ManageAccountRow {
  readonly id: string
  readonly mid: number
  readonly display: string
  readonly session: SessionState
  readonly refreshMode: RefreshMode | null
  readonly login: boolean
  readonly refreshedAt: number | null
  readonly importedAt: number | null
  readonly deadReason: string | null
}

/** The gate as a manage or admin token sees it. */
export interface ManageGate {
  readonly mode: string
  readonly readonly: boolean
  readonly brake: BrakeView | null
  readonly used: UsageCounts | null
  readonly caps: UsageCounts | null
}

/** What the full `GET /v1/status` answers, as far as Settings reads it. */
export interface ManageStatus {
  readonly accounts: readonly ManageAccountRow[]
  readonly gate: ManageGate | null
}

/** A started QR sign-in: the key stays on the Host. */
export interface QrStart {
  readonly key: string
  readonly url: string
  readonly expiresAt: number
}

/** Where a QR sign-in stands. */
export interface QrPoll {
  readonly state: LoginState
  readonly message: string | null
}

/** What the client needs from its owner. */
export interface ManageHooks {
  /** bili-svc's base URL. */
  readonly baseUrl: string
  /** The manage token, read per call; undefined while the credential is not set. */
  token(): Promise<string | undefined>
  /** Debug log line; never request data, the token, or a QR key. */
  debug(message: string): void
}

/** A finite number, or undefined. */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** A plain object, or an empty one. */
function obj(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * An instant as Unix epoch milliseconds. bili-svc reports epoch seconds; a value too large to be
 * seconds is taken as milliseconds already.
 * @param value - raw field.
 * @returns milliseconds, or null.
 */
export function instant(value: unknown): number | null {
  const n = num(value)
  if (n === undefined || n <= 0) return null
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n)
}

/** Text of a field: a bounded string, or JSON of an object, bounded. */
function text(value: unknown, max: number): string {
  if (typeof value === 'string' || typeof value === 'number') return clean(value, max)
  if (typeof value === 'object' && value !== null) return clean(JSON.stringify(value), max)
  return ''
}

/** Day counters, or null when the field is not two numbers. */
function counts(value: unknown): UsageCounts | null {
  const row = obj(value)
  const comment = num(row['comment'])
  const dm = num(row['dm'])
  return comment === undefined || dm === undefined ? null : { comment, dm }
}

/**
 * Parse the full status.
 * @param answer - the parsed JSON body.
 * @returns accounts with renewal facts, and the gate with its brake.
 */
export function parseManageStatus(answer: Record<string, unknown>): ManageStatus {
  const accounts = (Array.isArray(answer['accounts']) ? answer['accounts'] as unknown[] : []).flatMap((raw): ManageAccountRow[] => {
    const row = obj(raw)
    const id = clean(row['id'], 64)
    if (id === '') return []
    const session = clean(row['session'], 20)
    const mode = clean(row['refresh_mode'], 20)
    const reason = text(row['dead_reason'], 200)
    return [{
      id,
      mid: num(row['mid']) ?? 0,
      display: clean(row['display'], 40),
      session: (SESSION_STATES as readonly string[]).includes(session) ? session as SessionState : 'missing',
      refreshMode: (REFRESH_MODES as readonly string[]).includes(mode) ? mode as RefreshMode : null,
      login: row['login'] === true,
      refreshedAt: instant(row['refreshed_at']),
      importedAt: instant(row['imported_at']),
      deadReason: reason === '' ? null : reason,
    }]
  })
  const raw = answer['gate']
  if (typeof raw !== 'object' || raw === null) return { accounts, gate: null }
  const gate = obj(raw)
  const brakeRaw = obj(gate['brake'])
  const brake: BrakeView | null = typeof gate['brake'] === 'object' && gate['brake'] !== null
    ? { reason: text(brakeRaw['reason'], 80), detail: text(brakeRaw['detail'], 240), ts: instant(brakeRaw['ts']) }
    : null
  return {
    accounts,
    gate: {
      mode: clean(gate['mode'], 40),
      readonly: gate['readonly'] === true,
      brake,
      used: counts(gate['used_today']),
      caps: counts(gate['daily_caps']),
    },
  }
}

/**
 * Parse a ledger answer.
 * @param answer - the parsed JSON body (`{ledger, summary}`).
 * @returns bounded rows, newest first as bili-svc sent them, and flat summary counters.
 */
export function parseLedger(answer: Record<string, unknown>): LedgerView {
  const rows = (Array.isArray(answer['ledger']) ? answer['ledger'] as unknown[] : []).slice(0, LEDGER_MAX_ROWS).map((raw): LedgerRow => {
    const row = obj(raw)
    return {
      ts: instant(row['ts']),
      kind: text(row['kind'], 40),
      target: text(row['target'], 80),
      state: text(row['state'], 40),
      reason: text(row['reason'], 160),
      caller: text(row['caller'], 40),
      draft: text(row['draft'], 240),
      verdict: text(row['verdict'], 240),
    }
  })
  const summary: Record<string, string | number> = {}
  const put = (key: string, value: unknown, depth: number): void => {
    if (Object.keys(summary).length >= MAX_SUMMARY) return
    const n = num(value)
    if (n !== undefined) summary[clean(key, 60)] = n
    else if (typeof value === 'string') summary[clean(key, 60)] = clean(value, 60)
    else if (depth < 3 && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) put(`${key}.${inner}`, innerValue, depth + 1)
    }
  }
  for (const [key, value] of Object.entries(obj(answer['summary']))) put(key, value, 1)
  return { rows, summary }
}

/**
 * QR modules as rows of `0`/`1`, so only the picture leaves the Host.
 * @param url - what the code encodes; it carries the sign-in key.
 */
export function qrModules(url: string): string[] {
  return encode(url, { border: 1 }).data.map(row => row.map(dark => (dark ? '1' : '0')).join(''))
}

/** A client of bili-svc's management API. */
export class ManageClient {
  /** @param hooks - base URL, token, logging. */
  constructor(private readonly hooks: ManageHooks) {}

  /** Whether a manage token is set right now. */
  async hasToken(): Promise<boolean> {
    const token = await this.hooks.token()
    return token !== undefined && token !== ''
  }

  /**
   * The full status: accounts with renewal facts, and the gate with its brake.
   * @param signal - cancellation.
   */
  async status(signal?: AbortSignal): Promise<ManageStatus> {
    return parseManageStatus(await this.request('GET', 'status', '/v1/status', undefined, MANAGE_TIMEOUT_MS, signal))
  }

  /**
   * Switch the gate's mode.
   * @param mode - `auto` or `readonly`.
   * @throws {ManageError} `mode_refused` (HTTP 409) while a brake is active and the mode is `auto`.
   */
  async setMode(mode: GateMode, signal?: AbortSignal): Promise<{ mode: string; brake: BrakeView | null }> {
    const answer = await this.request('POST', 'gate/mode', '/v1/manage/gate/mode', { mode }, MANAGE_TIMEOUT_MS, signal)
    return { mode: clean(answer['mode'], 40), brake: parseManageStatus({ gate: { brake: answer['brake'] } }).gate?.brake ?? null }
  }

  /** Release the brake. Answers whether one was set. */
  async releaseBrake(signal?: AbortSignal): Promise<{ released: boolean; mode: string }> {
    const answer = await this.request('POST', 'brake/release', '/v1/manage/brake/release', {}, MANAGE_TIMEOUT_MS, signal)
    return { released: answer['released'] === true, mode: clean(answer['mode'], 40) }
  }

  /**
   * Recent ledger rows.
   * @param limit - rows wanted, at most {@link LEDGER_MAX_ROWS}.
   */
  async ledger(limit: number, signal?: AbortSignal): Promise<LedgerView> {
    const rows = Math.min(Math.max(1, Math.floor(limit)), LEDGER_MAX_ROWS)
    return parseLedger(await this.request('GET', 'ledger', `/v1/manage/ledger?limit=${rows}`, undefined, MANAGE_TIMEOUT_MS, signal))
  }

  /**
   * Start a QR sign-in.
   * @param id - bili-svc account id.
   * @throws {ManageError} `not_owner` (HTTP 409) for an account whose session another service owns.
   */
  async loginStart(id: string, signal?: AbortSignal): Promise<QrStart> {
    const answer = await this.request('POST', 'login/qr', `/v1/manage/accounts/${encodeURIComponent(id)}/login/qr`, {}, MANAGE_TIMEOUT_MS, signal)
    const key = typeof answer['key'] === 'string' ? answer['key'] : ''
    const url = typeof answer['url'] === 'string' ? answer['url'] : ''
    const expiresAt = instant(answer['expires_at'])
    if (key === '' || url === '' || expiresAt === null) throw new ManageError('login/qr', 502, 'bad_answer', 'bili-svc answered no QR code')
    return { key, url, expiresAt }
  }

  /**
   * Where a QR sign-in stands.
   * @param id - bili-svc account id.
   * @param key - the key {@link loginStart} returned.
   */
  async loginPoll(id: string, key: string, signal?: AbortSignal): Promise<QrPoll> {
    const answer = await this.request('GET', 'login/qr', `/v1/manage/accounts/${encodeURIComponent(id)}/login/qr?key=${encodeURIComponent(key)}`, undefined, MANAGE_TIMEOUT_MS, signal)
    const state = clean(answer['state'], 20)
    if (!(LOGIN_STATES as readonly string[]).includes(state)) throw new ManageError('login/qr', 502, 'bad_answer', 'bili-svc answered an unknown QR state')
    const message = text(answer['message'], 200)
    return { state: state as LoginState, message: message === '' ? null : message }
  }

  /**
   * Renew an account's session now.
   * @param id - bili-svc account id.
   * @returns whether it was renewed (false: nothing to renew yet).
   * @throws {ManageError} `refresh_failed` (HTTP 502) with bili-svc's reason.
   */
  async refresh(id: string, signal?: AbortSignal): Promise<{ refreshed: boolean }> {
    const answer = await this.request('POST', 'session/refresh', `/v1/manage/accounts/${encodeURIComponent(id)}/session/refresh`, {}, SESSION_TIMEOUT_MS, signal)
    return { refreshed: answer['refreshed'] === true }
  }

  /**
   * Ask Bilibili whether an account's session still works (bili-svc's `nav` probe, which also renews a session that is due).
   * @param id - bili-svc account id.
   * @returns `valid` or `invalid` by the probe's `isLogin`, and the days left when bili-svc knew.
   */
  async check(id: string, signal?: AbortSignal): Promise<{ outcome: 'valid' | 'invalid'; days: number | null }> {
    const answer = await this.request('POST', 'session/check', `/v1/manage/accounts/${encodeURIComponent(id)}/session/check`, {}, SESSION_TIMEOUT_MS, signal)
    return { outcome: answer['isLogin'] === false ? 'invalid' : 'valid', days: num(answer['expires_in_days']) ?? null }
  }

  /**
   * Sign an account out: bili-svc drops its session.
   * @param id - bili-svc account id; sent again as the confirmation.
   */
  async logout(id: string, signal?: AbortSignal): Promise<void> {
    await this.request('POST', 'logout', `/v1/manage/accounts/${encodeURIComponent(id)}/logout`, { confirm: id }, MANAGE_TIMEOUT_MS, signal)
  }

  /** One request with the token and a deadline; answers the parsed body of a 2xx, throws {@link ManageError} otherwise. */
  private async request(
    method: 'GET' | 'POST', name: string, route: string, body: unknown, timeoutMs: number, signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    const token = await this.hooks.token()
    if (token === undefined || token === '') throw new ManageError(name, 0, 'no_token', 'the manage token is not set')
    signal?.throwIfAborted()
    // A timer of its own, so the deadline follows the host's clock (and a test's fake one).
    const deadline = new AbortController()
    const timer = setTimeout(() => { deadline.abort(new Error('deadline')) }, timeoutMs)
    const started = Date.now()
    let response: Response
    let raw: string
    try {
      response = await fetch(`${this.hooks.baseUrl}${route}`, {
        method,
        headers: { 'authorization': `Bearer ${token}`, 'accept': 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'manual',
        signal: signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal]),
      })
      raw = await response.text()
    } catch (error: unknown) {
      signal?.throwIfAborted()
      throw new ManageError(name, 0, 'transport', deadline.signal.aborted ? `no answer from bili-svc within ${timeoutMs} ms` : `bili-svc is unreachable (${error instanceof Error ? error.name : 'unknown'})`)
    } finally {
      clearTimeout(timer)
    }
    this.hooks.debug(`bili: manage ${name} → bili-svc HTTP ${response.status} (${Date.now() - started} ms)`)
    if (raw.length > MAX_BODY_CHARS) throw new ManageError(name, 502, 'bad_answer', 'bili-svc answer too large')
    let parsed: unknown = {}
    if (raw !== '') {
      try {
        parsed = parseJson(raw)
      } catch {
        throw new ManageError(name, response.status >= 400 ? response.status : 502, 'bad_answer', `bili-svc answer is not JSON (HTTP ${response.status})`)
      }
    }
    const answer = obj(parsed)
    if (response.status >= 200 && response.status < 300) return answer
    const code = clean(answer['error'], 40) || `http_${response.status}`
    throw new ManageError(name, response.status, code, text(answer['message'], 240))
  }
}
