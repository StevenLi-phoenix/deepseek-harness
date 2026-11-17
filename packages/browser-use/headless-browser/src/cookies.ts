/**
 * The context's cookies, shaped for a caller that wants to fetch pages over
 * plain HTTP instead of driving a browser. Driving a browser for every read is
 * slow and visible to the site; a signed-in session is mostly one Cookie
 * header, so a caller that already has the browser can ask for that header and
 * fetch with it.
 *
 * Cookie values are session credentials. This module never writes them to disk,
 * and the one line it builds for a log names each cookie and the length its
 * value would have been, never the value: {@link redactSecret} is what makes
 * that truncation visible.
 *
 * @module @deepseek-ai/dsh-headless-browser/cookies
 */

/** One cookie as a tool result reports it. */
export interface CookieView {
  /** Cookie name. */
  readonly name: string
  /** Cookie value, a credential: it goes to the caller, never to a log line. */
  readonly value: string
  /** Domain the cookie belongs to, with a leading dot for a domain cookie. */
  readonly domain: string
  /** Path the cookie is scoped to. */
  readonly path: string
  /** Expiry in seconds since the Unix epoch, or -1 for a cookie that ends with the session. */
  readonly expires: number
  /** Whether page script cannot read the cookie. */
  readonly httpOnly: boolean
  /** Whether the cookie is sent over HTTPS only. */
  readonly secure: boolean
}

/** The fields this module reads from a Playwright cookie; the rest it ignores. */
export interface RawCookie {
  readonly name: string
  readonly value: string
  readonly domain: string
  readonly path: string
  readonly expires: number
  readonly httpOnly: boolean
  readonly secure: boolean
}

/** The cookies of one domain, and the Cookie header for them. */
export interface CookieResult {
  /** Every matching cookie, most specific path first. */
  readonly cookies: CookieView[]
  /** `name=value; name=value` as a request's Cookie header, or the empty string. */
  readonly toHeader: string
}

/** Characters of a cookie name the summary line keeps. */
const SUMMARY_NAME_LIMIT = 40

/**
 * Strip a domain filter down to the host suffix a cookie's domain is matched
 * against: a whole URL is accepted, and a leading dot, a port, and a path are
 * dropped, because a caller copies whatever it has to hand.
 * @param value - the `domain` a caller passed, or nothing.
 * @returns the suffix to match, or nothing when the value names no host.
 */
export function domainFilter(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const text = value.trim().toLowerCase()
  if (text === '') return undefined
  const host = text.includes('://') ? hostOf(text) : text.split('/')[0] ?? ''
  const bare = host.replace(/^\.+/u, '').replace(/\.+$/u, '').replace(/:\d+$/u, '')
  return bare === '' ? undefined : bare
}

/**
 * Keep the cookies one domain may use, in the order a request sends them.
 * @param cookies - every cookie of the context, as Playwright reports them.
 * @param domain - domain suffix to keep, or nothing for all of them.
 * @returns the matching cookies, most specific path first.
 */
export function filterCookies(cookies: readonly RawCookie[], domain?: string): CookieView[] {
  const wanted = domainFilter(domain)
  return cookies
    .filter(cookie => wanted === undefined || underDomain(cookie.domain, wanted))
    .map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
    }))
    .sort((left, right) => right.path.length - left.path.length || left.name.localeCompare(right.name))
}

/**
 * Build the Cookie header one set of cookies is sent as.
 * @param cookies - the cookies to send, in the order they are sent.
 * @returns `name=value; name=value`, or the empty string when there are none.
 */
export function cookieHeader(cookies: readonly CookieView[]): string {
  return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
}

/**
 * Shape a context's cookies for the caller: filtered, and with the header.
 * @param cookies - every cookie of the context, as Playwright reports them.
 * @param domain - domain suffix to keep, or nothing for all of them.
 * @returns the cookies and the Cookie header for them.
 */
export function cookieSnapshot(cookies: readonly RawCookie[], domain?: string): CookieResult {
  const kept = filterCookies(cookies, domain)
  return { cookies: kept, toHeader: cookieHeader(kept) }
}

/**
 * Turn a value that must never reach a log line into text that says only how
 * long it was.
 * @param value - the secret.
 * @returns a marker with the value's length and none of its characters.
 */
export function redactSecret(value: string): string {
  return value === '' ? '‹empty›' : `‹${String(value.length)} chars›`
}

/**
 * One log-safe line about a cookie set: how many, which names, and how long
 * each value is. Never a value.
 * @param cookies - the cookies the caller received.
 * @param domain - the domain the caller asked for, for the line.
 * @returns the line to log.
 */
export function cookieSummary(cookies: readonly CookieView[], domain?: string): string {
  const scope = domainFilter(domain) ?? 'the whole context'
  if (cookies.length === 0) return `no cookies for ${scope}`
  const names = cookies.map((cookie) => {
    const name = cookie.name.length > SUMMARY_NAME_LIMIT ? `${cookie.name.slice(0, SUMMARY_NAME_LIMIT)}…` : cookie.name
    return `${name} ${redactSecret(cookie.value)}`
  })
  return `${String(cookies.length)} cookie(s) for ${scope}: ${names.join(', ')}`
}

/**
 * Whether a cookie's domain is the wanted suffix or below it.
 * @param cookieDomain - the cookie's own domain, with or without a leading dot.
 * @param wanted - the normalized suffix to match.
 * @returns whether the cookie may be sent for that suffix.
 */
function underDomain(cookieDomain: string, wanted: string): boolean {
  const bare = cookieDomain.toLowerCase().replace(/^\.+/u, '')
  return bare === wanted || bare.endsWith(`.${wanted}`)
}

/**
 * The host of a URL, or the empty string.
 * @param url - a URL a caller passed as a domain.
 * @returns the lower-case host, without a port.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch (error: unknown) {
    void error
    return ''
  }
}
