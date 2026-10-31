/**
 * The only way this package reaches Bilibili: bili-svc on the same Mac. Every call names an
 * endpoint of bili-svc's door (`POST /v1/bili/call`) with the account's query and form; bili-svc
 * holds the session (cookies, refresh, device), signs, paces, and owns the ledger, the daily caps,
 * and the risk brake of every action. This client adds only the bearer token
 * (`BILI_SVC_TOKEN_BILI`), a deadline (30 s for reads, 330 s for actions, which may wait minutes
 * for bili-svc's sender slot), and the mapping of bili-svc's `outcome` to this package's errors.
 * No cookie or Bilibili credential ever passes through it.
 */
import { ENDPOINTS, isEndpointName, type Endpoint, type EndpointName } from './endpoints.ts'

/** Default bili-svc address; `BILI_SVC_URL` in the service environment overrides it. */
export const DEFAULT_SERVICE_URL = 'http://127.0.0.1:8097'
/** Credential holding this package's bili-svc bearer token (scopes `bili`, `read`, `reply`). */
export const TOKEN_CREDENTIAL = 'BILI_SVC_TOKEN_BILI'
/** Deadline of a read, and of a status or account call. */
export const READ_TIMEOUT_MS = 30_000
/** Deadline of an action or an owner reply: bili-svc may wait up to 330 s for its sender slot. */
export const ACTION_TIMEOUT_MS = 330_000
/** Largest answer read. */
const MAX_BODY_CHARS = 8 * 1024 * 1024

/** A call this client refused, or bili-svc refused before anything reached Bilibili (no token, HTTP 401/403/404/422). */
export class BiliRefused extends Error {
  /** @param message - why, without request data. */
  constructor(message: string) {
    super(message)
    this.name = 'BiliRefused'
  }
}

/** Bilibili answered with risk control; bili-svc tripped its brake. */
export class BiliRiskError extends Error {
  /**
   * @param endpoint - endpoint name.
   * @param reason - Bilibili's code and words, e.g. `code -352: 风控校验失败`.
   */
  constructor(readonly endpoint: EndpointName, readonly reason: string) {
    super(`${endpoint}: risk control (${reason})`)
    this.name = 'BiliRiskError'
  }
}

/** Bilibili answered with a non-zero business code (bili-svc's `api_error`). */
export class BiliApiError extends Error {
  /**
   * @param endpoint - endpoint name.
   * @param code - the JSON `code`.
   * @param detail - Bilibili's message, bounded.
   */
  constructor(readonly endpoint: EndpointName, readonly code: number, readonly detail: string) {
    super(`${endpoint}: code ${code}${detail === '' ? '' : ` (${detail})`}`)
    this.name = 'BiliApiError'
  }
}

/** Bilibili refused an action until the account verifies a phone number or real name (bili-svc's `verify`). */
export class BiliVerifyError extends BiliApiError {
  /**
   * @param endpoint - endpoint name.
   * @param code - the JSON `code`.
   * @param detail - Bilibili's message, bounded.
   */
  constructor(endpoint: EndpointName, code: number, detail: string) {
    super(endpoint, code, detail)
    this.name = 'BiliVerifyError'
  }
}

/** bili-svc has no usable session for the account (`session_expired`, `session_unavailable`): the owner renews it in bili-svc. */
export class BiliSessionError extends Error {
  /**
   * @param endpoint - endpoint name.
   * @param outcome - bili-svc's outcome.
   * @param detail - its words, bounded.
   */
  constructor(readonly endpoint: EndpointName, readonly outcome: 'session_expired' | 'session_unavailable', readonly detail: string) {
    super(`the Bilibili session in bili-svc is not usable (${outcome}${detail === '' ? '' : `: ${detail}`}); bili-svc owns the login, and the owner renews it there`)
    this.name = 'BiliSessionError'
  }
}

/** bili-svc decided an action without sending it, or after: `refused`, `held`, `already`, or `uncertain`. */
export class BiliOutcomeError extends Error {
  /**
   * @param endpoint - endpoint name.
   * @param outcome - bili-svc's outcome.
   * @param reason - its reason text, bounded.
   */
  constructor(readonly endpoint: EndpointName, readonly outcome: 'refused' | 'held' | 'already' | 'uncertain', readonly reason: string) {
    super(`${endpoint}: ${outcome}${reason === '' ? '' : ` (${reason})`}`)
    this.name = 'BiliOutcomeError'
  }
}

/**
 * The call may or may not have reached bili-svc (and Bilibili): no answer by the deadline, a
 * network failure, a server error, or an answer this client could not read. For an action the
 * outcome is unknown.
 */
export class BiliTransportError extends Error {
  /**
   * @param endpoint - endpoint name, or the bili-svc route.
   * @param detail - what failed, without request data.
   */
  constructor(readonly endpoint: string, detail: string) {
    super(`${endpoint}: ${detail}`)
    this.name = 'BiliTransportError'
  }
}

/** Arguments of one call; bili-svc adds csrf, WBI, and cookies. */
export interface CallOptions {
  query?: Readonly<Record<string, string | number>>
  /** Form body of an action. */
  form?: Readonly<Record<string, string | number>>
  /** JSON body. */
  json?: unknown
  /** Path suffix of a subtitle file. */
  path?: string
  /** Read as a signed-out visitor. */
  anonymous?: boolean
  /** `Referer` of the page that would make the request; bili-svc keeps it only for Bilibili pages. */
  referer?: string
  signal?: AbortSignal
}

/** One answer. */
export interface CallResult {
  /** The endpoint's data, the text of a text endpoint, or the file of a subtitle. */
  data: unknown
  /** The whole answer of bili-svc. */
  body: Record<string, unknown>
}

/** Anything that can call an endpoint: the remote client, or a test double. */
export interface BiliCaller {
  call(name: EndpointName, options?: CallOptions): Promise<CallResult>
}

/** One account as `GET /v1/status` lists it. */
export interface ServiceAccount {
  id: string
  mid: number
  display: string
  /** `ok`, `dead` (Bilibili ended it), `missing` (no readable session), or `none` (bili-svc holds no session for it). */
  session: string
}

/** What `GET /v1/status` answers, as far as this package reads it. */
export interface ServiceStatus {
  accounts: ServiceAccount[]
  gate: { mode: string; readonly: boolean } | undefined
}

/** bili-svc's answer to an owner reply: only whether the Reply Gate sent it. */
export interface ReplyAnswer {
  status: 'sent' | 'held' | 'blocked'
  id?: string
}

/** What the client needs from its owner. */
export interface RemoteHooks {
  /** bili-svc's base URL. */
  baseUrl: string
  /** bili-svc's id of the agent's account (`account` of every call). */
  account: string
  /** The bearer token, read per call; undefined when the credential is not set. */
  token(): Promise<string | undefined>
  /** Debug log line; never request data or the token. */
  debug(message: string): void
  /** Info log line for a call that did not succeed; never request data or the token. */
  info(message: string): void
}

/**
 * Parse JSON, keeping integers beyond 2^53 (comment, dynamic, and message ids) as strings.
 * @param text - JSON text.
 * @returns the value.
 */
export function parseJson(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) => {
    if (typeof value === 'number' && !Number.isSafeInteger(value) && context?.source !== undefined && /^-?\d+$/.test(context.source)) return context.source
    return value
  })
}

/** Whether a URL path matches an entry. */
function pathMatches(entry: Endpoint, path: string): boolean {
  return typeof entry.path === 'string' ? entry.path === path : entry.path.test(path)
}

/**
 * The endpoint of a method and URL, if any: how a subtitle URL from `player` becomes a call.
 * @param method - HTTP method.
 * @param url - absolute URL.
 * @returns the endpoint name, or undefined when none matches.
 */
export function allowedEndpoint(method: string, url: string): EndpointName | undefined {
  const parsed = URL.parse(url)
  if (parsed === null || parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.port !== '') return undefined
  for (const [name, entry] of Object.entries(ENDPOINTS) as [EndpointName, Endpoint][]) {
    if (entry.method === method && entry.host === parsed.hostname && pathMatches(entry, parsed.pathname)) return name
  }
  return undefined
}

/** Bounded one-line text of a field. */
function line(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

/** A finite number, or undefined. */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Bilibili's code and words, as bili-svc passed them on. */
function said(answer: Record<string, unknown>): string {
  const code = num(answer['code'])
  const message = line(answer['message'])
  if (code === undefined) return message
  return message === '' ? `code ${code}` : `code ${code}: ${message}`
}

/** A client of bili-svc. */
export class RemoteBiliClient implements BiliCaller {
  /** @param hooks - base URL, account, token, and logging. */
  constructor(private readonly hooks: RemoteHooks) {}

  /** bili-svc's base URL. */
  get baseUrl(): string {
    return this.hooks.baseUrl
  }

  /** bili-svc's id of the agent's account. */
  get account(): string {
    return this.hooks.account
  }

  /**
   * Call one endpoint through bili-svc's door.
   * @param name - endpoint name; anything not in {@link ENDPOINTS} is refused before any request.
   * @param options - query, form, path suffix, anonymity, cancellation.
   * @returns the answer's data.
   * @throws {BiliRefused} before sending or for HTTP 401/403/404/422; {@link BiliRiskError},
   *   {@link BiliApiError}, {@link BiliVerifyError}, {@link BiliSessionError}, {@link BiliOutcomeError},
   *   or {@link BiliTransportError} after.
   */
  async call(name: EndpointName, options: CallOptions = {}): Promise<CallResult> {
    if (!isEndpointName(name)) throw new BiliRefused(`${String(name)} is not an endpoint this package may call`)
    const entry: Endpoint = ENDPOINTS[name]
    const body = {
      endpoint: name,
      account: this.hooks.account,
      ...(options.query === undefined ? {} : { query: options.query }),
      ...(options.form === undefined ? {} : { form: options.form }),
      ...(options.json === undefined ? {} : { json: options.json }),
      ...(options.path === undefined ? {} : { path: options.path }),
      ...(options.referer === undefined ? {} : { referer: options.referer }),
      ...(options.anonymous === true ? { anonymous: true } : {}),
    }
    const timeoutMs = entry.kind === 'write' ? ACTION_TIMEOUT_MS : READ_TIMEOUT_MS
    const { status, answer } = await this.request(name, 'POST', '/v1/bili/call', body, timeoutMs, options.signal)
    this.refusedStatus(name, status, answer)
    if (status !== 200) throw new BiliTransportError(name, `bili-svc answered HTTP ${status}`)
    if (answer['ok'] === true) return { data: answer['data'], body: answer }
    const outcome = line(answer['outcome'], 40)
    const reason = line(answer['reason']) || line(answer['message'])
    this.hooks.info(`bili: ${name} answered ${outcome || 'no outcome'}${reason === '' ? '' : ` (${said(answer) || reason})`}`)
    switch (outcome) {
      case 'risk':
        throw new BiliRiskError(name, said(answer) || 'risk control')
      case 'verify':
        throw new BiliVerifyError(name, num(answer['code']) ?? 0, line(answer['message']))
      case 'api_error':
        throw new BiliApiError(name, num(answer['code']) ?? 0, line(answer['message']))
      case 'session_expired':
      case 'session_unavailable':
        throw new BiliSessionError(name, outcome, line(answer['message']))
      case 'refused':
      case 'held':
      case 'already':
      case 'uncertain':
        throw new BiliOutcomeError(name, outcome, reason)
      default:
        throw new BiliTransportError(name, `bili-svc answered an unknown outcome ${JSON.stringify(outcome)}`)
    }
  }

  /**
   * The accounts bili-svc holds and its gate.
   * @param signal - cancellation.
   * @returns the accounts, each with its session state, and the gate's mode.
   */
  async status(signal?: AbortSignal): Promise<ServiceStatus> {
    const { status, answer } = await this.request('status', 'GET', '/v1/status', undefined, READ_TIMEOUT_MS, signal)
    if (status === 401 || status === 403) throw new BiliRefused(`bili-svc did not accept the token for /v1/status (HTTP ${status})`)
    if (status !== 200) throw new BiliTransportError('status', `bili-svc answered HTTP ${status}`)
    const accounts = (Array.isArray(answer['accounts']) ? answer['accounts'] : []).flatMap((raw: unknown) => {
      const row = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
      const id = line(row['id'], 64)
      if (id === '') return []
      return [{ id, mid: num(row['mid']) ?? 0, display: line(row['display'], 40), session: line(row['session'], 20) || 'none' }]
    })
    const gate = typeof answer['gate'] === 'object' && answer['gate'] !== null ? answer['gate'] as Record<string, unknown> : undefined
    return { accounts, gate: gate === undefined ? undefined : { mode: line(gate['mode'], 40), readonly: gate['readonly'] === true } }
  }

  /**
   * Answer the owner's private message through bili-svc's Reply Gate (`POST /v1/reply/dm`).
   * @param talker - the owner's main account.
   * @param message - the reply, at most 500 characters.
   * @param signal - cancellation.
   * @returns `sent`, `held`, or `blocked`, with bili-svc's ledger id.
   * @throws {BiliRefused} for no token or HTTP 401/403/404/422; {@link BiliTransportError} when the outcome is unknown.
   */
  async replyDm(talker: number, message: string, signal?: AbortSignal): Promise<ReplyAnswer> {
    const body = { account: this.hooks.account, talker, message }
    const { status, answer } = await this.request('reply/dm', 'POST', '/v1/reply/dm', body, ACTION_TIMEOUT_MS, signal)
    this.refusedStatus('reply/dm', status, answer)
    if (status !== 200) throw new BiliTransportError('reply/dm', `bili-svc answered HTTP ${status}`)
    const verdict = answer['status']
    if (verdict !== 'sent' && verdict !== 'held' && verdict !== 'blocked') throw new BiliTransportError('reply/dm', 'bili-svc answered no status')
    const id = line(answer['id'], 64)
    this.hooks.debug(`bili: reply/dm answered ${verdict}${id === '' ? '' : ` (${id})`}`)
    return id === '' ? { status: verdict } : { status: verdict, id }
  }

  /** HTTP answers bili-svc decides before Bilibili: nothing was done. */
  private refusedStatus(name: string, status: number, answer: Record<string, unknown>): void {
    if (status === 401 || status === 403) throw new BiliRefused(`bili-svc did not accept the token for ${name} (HTTP ${status}${line(answer['error'], 60) === '' ? '' : `: ${line(answer['error'], 60)}`})`)
    if (status === 404) throw new BiliRefused(`bili-svc does not know the account ${this.hooks.account} (HTTP 404)`)
    if (status === 422) throw new BiliRefused(`bili-svc refused the request as malformed (HTTP 422${line(answer['error'], 60) === '' ? '' : `: ${line(answer['error'], 60)}`})`)
  }

  /** One request to bili-svc with the token and a deadline; answers the status and the parsed body. */
  private async request(
    name: string, method: 'GET' | 'POST', route: string, body: unknown, timeoutMs: number, signal: AbortSignal | undefined,
  ): Promise<{ status: number; answer: Record<string, unknown> }> {
    const token = await this.hooks.token()
    if (token === undefined || token === '') throw new BiliRefused(`${TOKEN_CREDENTIAL} is not set, so bili-svc cannot be called; ${name} was not sent`)
    signal?.throwIfAborted()
    // A timer of its own, so the deadline follows the host's clock (and a test's fake one).
    const deadline = new AbortController()
    const timer = setTimeout(() => { deadline.abort(new Error('deadline')) }, timeoutMs)
    const started = Date.now()
    let response: Response
    let text: string
    try {
      response = await fetch(`${this.hooks.baseUrl}${route}`, {
        method,
        headers: { 'authorization': `Bearer ${token}`, 'accept': 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'manual',
        signal: signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal]),
      })
      text = await response.text()
    } catch (error: unknown) {
      signal?.throwIfAborted()
      throw new BiliTransportError(name, deadline.signal.aborted ? `no answer from bili-svc within ${timeoutMs} ms` : `bili-svc is unreachable (${error instanceof Error ? error.name : 'unknown'})`)
    } finally {
      clearTimeout(timer)
    }
    this.hooks.debug(`bili: ${name} → bili-svc HTTP ${response.status} (${Date.now() - started} ms)`)
    if (text.length > MAX_BODY_CHARS) throw new BiliTransportError(name, 'bili-svc answer too large')
    let parsed: unknown = {}
    if (text !== '') {
      try {
        parsed = parseJson(text)
      } catch {
        throw new BiliTransportError(name, `bili-svc answer is not JSON (HTTP ${response.status})`)
      }
    }
    const answer = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    return { status: response.status, answer }
  }
}
