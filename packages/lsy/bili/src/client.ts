/**
 * The only way this package talks to Bilibili. Every request names an entry
 * of the endpoint allowlist (method, host, and path), so nothing else can be
 * reached; redirects are never followed; cookies go only to Bilibili API hosts
 * and only for entries that need them; requests are spaced by a minimum gap
 * with jitter and bounded by a deadline. Risk-control answers (HTTP 412/429,
 * codes -352/-412/-799, a captcha voucher) are reported to the owner of the
 * client before they surface as {@link BiliRiskError}.
 */
import { cookieHeader, type CookieJar } from './cookies.ts'
import { ENDPOINTS, type Endpoint, type EndpointName } from './endpoints.ts'
import { keyFromUrl, signQuery, type WbiKeys } from './wbi.ts'

/** Desktop browser identity sent with every request. */
export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
/** Hosts that may receive the account's cookies. */
export const COOKIE_HOSTS: ReadonlySet<string> = new Set(['api.bilibili.com', 'api.vc.bilibili.com', 'passport.bilibili.com', 'www.bilibili.com'])
/**
 * JSON codes that mean risk control or a demand to slow down: -352 (risk check
 * failed), -412 (request intercepted), -799 and -509 (too frequent); and, from
 * the write endpoints, 12015 (comment needs a captcha), 21020 and 21046 (DMs
 * too fast), 10031 (favorites too fast). The content-restricted `-412` that
 * play-URL endpoints return for one video does not apply: this client never
 * calls them.
 */
export const RISK_CODES: ReadonlySet<number> = new Set([-352, -412, -509, -799, 10031, 12015, 21020, 21046])
/** Message words Bilibili uses for challenges and risk control. */
const RISK_WORDS = /captcha|验证码|风控|账号异常/i
/**
 * JSON codes that mean the account must bind or verify a phone number, or
 * verify its real name, before this write: -108, -110, -114 (no phone bound),
 * -113, -115 (no real-name verification), 21015 (messages need a bound phone),
 * 4126021 (dynamics need a bound phone). They are refusals, not risk control.
 */
export const VERIFY_CODES: ReadonlySet<number> = new Set([-108, -110, -113, -114, -115, 21015, 4126021])
/** Message words of the same demand when the code is not one of {@link VERIFY_CODES}; `验证码` (captcha) is risk control. */
const VERIFY_WORDS = /手机|绑定|实名|验证(?!码)/
/** Largest response body read. */
const MAX_BODY_BYTES = 4 * 1024 * 1024
/** WBI keys rotate daily; a cached pair is used for at most this long. */
const WBI_KEYS_TTL_MS = 12 * 3_600_000

/** A request this client refused to send. */
export class BiliRefused extends Error {
  /** @param message - why, without request data. */
  constructor(message: string) {
    super(message)
    this.name = 'BiliRefused'
  }
}

/** Bilibili answered with risk control; the request did nothing. */
export class BiliRiskError extends Error {
  /**
   * @param endpoint - allowlist entry name.
   * @param reason - e.g. `HTTP 412`, `code -352`, `captcha`.
   */
  constructor(readonly endpoint: EndpointName, readonly reason: string) {
    super(`${endpoint}: risk control (${reason})`)
    this.name = 'BiliRiskError'
  }
}

/** Bilibili answered with a non-zero business code. */
export class BiliApiError extends Error {
  /**
   * @param endpoint - allowlist entry name.
   * @param code - the JSON `code`.
   * @param detail - the JSON `message`, bounded.
   * @param data - the `data` field that came with the code, when there was one.
   */
  constructor(readonly endpoint: EndpointName, readonly code: number, readonly detail: string, readonly data?: unknown) {
    super(`${endpoint}: code ${code}${detail === '' ? '' : ` (${detail})`}`)
    this.name = 'BiliApiError'
  }
}

/**
 * Bilibili refused a write until the account binds or verifies a phone number
 * (or verifies its real name). Nothing happened; it is not risk control.
 */
export class BiliVerifyError extends BiliApiError {
  /**
   * @param endpoint - allowlist entry name.
   * @param code - the JSON `code`.
   * @param detail - the JSON `message`, bounded.
   */
  constructor(endpoint: EndpointName, code: number, detail: string) {
    super(endpoint, code, detail)
    this.name = 'BiliVerifyError'
  }
}

/**
 * The request may or may not have reached Bilibili: a network failure, a
 * deadline, a server error, or an answer this client could not read. For a
 * write this means the outcome is unknown.
 */
export class BiliTransportError extends Error {
  /**
   * @param endpoint - allowlist entry name.
   * @param detail - what failed, without request data.
   */
  constructor(readonly endpoint: EndpointName, detail: string) {
    super(`${endpoint}: ${detail}`)
    this.name = 'BiliTransportError'
  }
}

/** Arguments of one call. */
export interface CallOptions {
  /** Query parameters; signed when the entry needs WBI. */
  query?: Readonly<Record<string, string | number>>
  /** Form body of a POST; csrf fields are added from the jar. */
  form?: Readonly<Record<string, string | number>>
  /** JSON body of a POST. */
  json?: unknown
  /** Path suffix for entries with a pattern path (the `correspond` page, subtitle files). */
  path?: string
  /** Send no cookies, as a signed-out visitor would. */
  anonymous?: boolean
  /** `Referer` of the page that would make this request, e.g. a video page; must be a Bilibili page. */
  referer?: string
  signal?: AbortSignal
}

/** One answer. */
export interface CallResult {
  /** The JSON `data` (or `result`) field, the text of a text entry, or the whole value of a file entry. */
  data: unknown
  /** The whole parsed JSON body; undefined for text entries. */
  body: Record<string, unknown> | undefined
  /** Raw `Set-Cookie` headers. */
  setCookies: string[]
}

/** What the client needs from its owner. */
export interface ClientHooks {
  /** The current jar, read per request; undefined while signed out. */
  jar(): Promise<CookieJar | undefined>
  /** Called before every request; throw to refuse it (reads during a back-off). */
  admit(endpoint: EndpointName, entry: Endpoint): void
  /** A risk-control answer arrived. */
  onRisk(endpoint: EndpointName, entry: Endpoint, reason: string): void
  /** Resolve after `ms`, or reject when the owner stops. */
  sleep(ms: number): Promise<void>
  /** Uniform source in [0, 1), for jitter. */
  random(): number
  /** Debug log line; never request data. */
  debug(message: string): void
}

/** Spacing and deadlines. */
export interface ClientTiming {
  /** Minimum gap between two requests, in milliseconds. */
  gapMs: number
  /** Extra random gap up to this many milliseconds. */
  jitterMs: number
  /** Deadline of one request. */
  timeoutMs: number
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
 * The allowlist entry for a method and URL, if any. Exported for tests and
 * for callers handed a URL by Bilibili (subtitle files).
 * @param method - HTTP method.
 * @param url - absolute URL.
 * @returns the entry name, or undefined when nothing allows it.
 */
export function allowedEndpoint(method: string, url: string): EndpointName | undefined {
  const parsed = URL.parse(url)
  if (parsed === null || parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.port !== '') return undefined
  for (const [name, entry] of Object.entries(ENDPOINTS) as [EndpointName, Endpoint][]) {
    if (entry.method === method && entry.host === parsed.hostname && pathMatches(entry, parsed.pathname)) return name
  }
  return undefined
}

/** URL-encoded text of query or form fields. */
function formText(fields: Readonly<Record<string, string | number>>): string {
  return new URLSearchParams(Object.entries(fields).map(([key, value]) => [key, String(value)])).toString()
}

/** Pages a request may claim to come from. */
const REFERER_ORIGINS: ReadonlySet<string> = new Set(['https://www.bilibili.com', 'https://t.bilibili.com', 'https://space.bilibili.com', 'https://search.bilibili.com', 'https://message.bilibili.com'])

/** The entry's referer, or a caller's page on a Bilibili site. */
function refererOf(entry: Endpoint, requested: string | undefined): string {
  if (requested !== undefined && REFERER_ORIGINS.has(URL.parse(requested)?.origin ?? '')) return requested
  return entry.referer ?? 'https://www.bilibili.com/'
}

/** Bounded one-line text of a JSON message. */
function messageText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 160) : ''
}

/** Rate-limited, allowlisted Bilibili HTTP client. */
export class BiliClient {
  private queue: Promise<void> = Promise.resolve()
  private lastAt = 0
  private wbi: { keys: WbiKeys; at: number } | undefined

  /**
   * @param hooks - jar, admission, risk report, sleep, random, and debug log.
   * @param timing - spacing and deadline.
   */
  constructor(private readonly hooks: ClientHooks, private readonly timing: ClientTiming) {}

  /** Forget the cached WBI keys, e.g. after a sign-in. */
  resetWbi(): void {
    this.wbi = undefined
  }

  /**
   * Call one allowlisted endpoint.
   * @param name - allowlist entry.
   * @param options - query, body, path suffix, anonymity, cancellation.
   * @returns the answer's data.
   * @throws {BiliRefused} before sending; {@link BiliRiskError}, {@link BiliApiError}, or {@link BiliTransportError} after.
   */
  async call(name: EndpointName, options: CallOptions = {}): Promise<CallResult> {
    const entry: Endpoint = ENDPOINTS[name]
    this.hooks.admit(name, entry)
    const jar = options.anonymous === true || !entry.cookies ? undefined : await this.hooks.jar()
    if (entry.cookies && options.anonymous !== true && jar === undefined && entry.signedIn === true) {
      throw new BiliRefused(`${name} needs a signed-in account`)
    }
    const query: Record<string, string | number> = { ...options.query }
    for (const field of entry.csrfQuery ?? []) query[field] = this.csrf(name, jar)
    let search = ''
    if (entry.wbi === true) search = signQuery(query, await this.wbiKeys(), Math.floor(Date.now() / 1000))
    else if (Object.keys(query).length > 0) search = formText(query)
    const path = typeof entry.path === 'string' ? entry.path : options.path ?? ''
    const url = `https://${entry.host}${path}${search === '' ? '' : `?${search}`}`
    // Second line of defense: the built URL must itself match the same entry.
    if (allowedEndpoint(entry.method, url) !== name) throw new BiliRefused(`${name} does not allow this URL`)

    const referer = refererOf(entry, options.referer)
    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
      'accept': entry.response === 'text' ? 'text/html,application/xhtml+xml' : 'application/json, text/plain, */*',
      referer,
    }
    if (jar !== undefined && COOKIE_HOSTS.has(entry.host)) {
      const cookie = cookieHeader(jar)
      if (cookie !== '') headers['cookie'] = cookie
    }
    let body: string | undefined
    if (entry.method === 'POST') {
      headers['origin'] = new URL(referer).origin
      if (options.json !== undefined) {
        headers['content-type'] = 'application/json'
        body = JSON.stringify(options.json)
      } else {
        const form: Record<string, string | number> = { ...options.form }
        for (const field of entry.csrfForm ?? []) form[field] = this.csrf(name, jar)
        headers['content-type'] = 'application/x-www-form-urlencoded'
        body = formText(form)
      }
    }
    await this.spaced()
    return await this.send(name, entry, url, { method: entry.method, headers, body }, options.signal)
  }

  /** The jar's csrf token for an entry that needs one. */
  private csrf(name: EndpointName, jar: CookieJar | undefined): string {
    const token = jar?.bili_jct
    if (token === undefined) throw new BiliRefused(`${name} needs the account's csrf cookie`)
    return token
  }

  /** WBI keys from `nav`, cached for at most a day. */
  private async wbiKeys(): Promise<WbiKeys> {
    if (this.wbi !== undefined && Date.now() - this.wbi.at < WBI_KEYS_TTL_MS) return this.wbi.keys
    let data: unknown
    try {
      data = (await this.call('nav')).data
    } catch (error: unknown) {
      // Signed out (-101), nav still publishes the keys.
      if (!(error instanceof BiliApiError) || error.code !== -101 || error.data === undefined) throw error
      data = error.data
    }
    const image = (data as { wbi_img?: { img_url?: unknown; sub_url?: unknown } } | undefined)?.wbi_img
    const imgKey = keyFromUrl(image?.img_url)
    const subKey = keyFromUrl(image?.sub_url)
    if (imgKey === undefined || subKey === undefined) throw new BiliTransportError('nav', 'answer carries no WBI keys')
    this.wbi = { keys: { imgKey, subKey }, at: Date.now() }
    return this.wbi.keys
  }

  /** Wait for this request's turn: requests go one at a time, at least `gapMs` (+ jitter) apart. */
  private spaced(): Promise<void> {
    const turn = this.queue.then(async () => {
      const wait = this.lastAt + this.timing.gapMs + Math.floor(this.hooks.random() * this.timing.jitterMs) - Date.now()
      if (this.lastAt > 0 && wait > 0) await this.hooks.sleep(wait)
      this.lastAt = Date.now()
    })
    this.queue = turn.catch(() => undefined)
    return turn
  }

  /** Send one built request and classify the answer. */
  private async send(
    name: EndpointName, entry: Endpoint, url: string,
    init: { method: string; headers: Record<string, string>; body: string | undefined }, signal: AbortSignal | undefined,
  ): Promise<CallResult> {
    const deadline = AbortSignal.timeout(this.timing.timeoutMs)
    let response: Response
    try {
      response = await fetch(url, {
        method: init.method,
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        redirect: 'manual',
        signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
      })
    } catch (error: unknown) {
      signal?.throwIfAborted()
      throw new BiliTransportError(name, deadline.aborted ? `no answer within ${this.timing.timeoutMs} ms` : `network error (${error instanceof Error ? error.name : 'unknown'})`)
    }
    this.hooks.debug(`${name} → HTTP ${response.status}`)
    if (response.status === 412 || response.status === 429) {
      await response.body?.cancel()
      return this.risk(name, entry, `HTTP ${response.status}`)
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      throw new BiliTransportError(name, `refused to follow a redirect (HTTP ${response.status})`)
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new BiliTransportError(name, `HTTP ${response.status}`)
    }
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > MAX_BODY_BYTES) {
      await response.body?.cancel()
      throw new BiliTransportError(name, 'answer too large')
    }
    const text = await response.text()
    if (text.length > MAX_BODY_BYTES) throw new BiliTransportError(name, 'answer too large')
    const setCookies = response.headers.getSetCookie()
    if (entry.response === 'text') return { data: text, body: undefined, setCookies }
    let parsed: unknown
    try {
      parsed = parseJson(text)
    } catch {
      if (/captcha|验证码/i.test(text.slice(0, 8192))) return this.risk(name, entry, 'captcha page')
      throw new BiliTransportError(name, 'answer is not JSON')
    }
    if (entry.response === 'file') return { data: parsed, body: undefined, setCookies }
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { code?: unknown }).code !== 'number') {
      throw new BiliTransportError(name, 'answer has no code')
    }
    const json = parsed as Record<string, unknown> & { code: number }
    const data = json['data'] ?? json['result']
    const message = messageText(json['message'] ?? json['msg'])
    // Bilibili's own words go with the code, so the owner can tell a flagged account from a captcha.
    const said = message === '' ? `code ${json.code}` : `code ${json.code}: ${message}`
    if (typeof (data as { v_voucher?: unknown } | undefined)?.v_voucher === 'string') return this.risk(name, entry, `captcha (${said})`)
    if (RISK_CODES.has(json.code)) return this.risk(name, entry, said)
    if (VERIFY_CODES.has(json.code) || (json.code !== 0 && VERIFY_WORDS.test(message))) throw new BiliVerifyError(name, json.code, message)
    if (json.code !== 0 && RISK_WORDS.test(message)) return this.risk(name, entry, said)
    if (json.code !== 0) throw new BiliApiError(name, json.code, message, data)
    return { data, body: json, setCookies }
  }

  /** Report a risk answer, then fail the call. */
  private risk(name: EndpointName, entry: Endpoint, reason: string): never {
    this.hooks.onRisk(name, entry, reason)
    throw new BiliRiskError(name, reason)
  }
}
