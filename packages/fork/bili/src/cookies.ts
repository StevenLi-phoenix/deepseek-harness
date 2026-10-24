/**
 * The account's sign-in cookies: which ones are kept, how `Set-Cookie`
 * headers and the QR poll's redirect URL become a jar, and the `Cookie`
 * header built from it. Values never leave this module except in that header
 * and in the credential record.
 */

/** Cookies a web session needs; anything else Bilibili sets is dropped. */
export const COOKIE_NAMES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid', 'buvid3', 'buvid4', '_uuid', 'b_nut'] as const
/** One of {@link COOKIE_NAMES}. */
export type CookieName = typeof COOKIE_NAMES[number]
/** The kept cookies by name. */
export type CookieJar = Partial<Record<CookieName, string>>

const KEPT: ReadonlySet<string> = new Set(COOKIE_NAMES)

/** A cookie value Bilibili may send percent-encoded (SESSDATA carries `%2C`); kept as sent. */
function cleanValue(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed === '' || /[\s;"\\]/.test(trimmed) ? undefined : trimmed
}

/**
 * Merge `Set-Cookie` headers into a jar. Expired cookies (`Max-Age=0` or an
 * `Expires` in the past) are removed.
 * @param jar - the current jar; not modified.
 * @param headers - raw `Set-Cookie` header values.
 * @param now - Unix epoch milliseconds for `Expires` comparisons.
 * @returns the merged jar.
 */
export function mergeSetCookies(jar: CookieJar, headers: readonly string[], now: number = Date.now()): CookieJar {
  const next = new Map(Object.entries(jar))
  for (const header of headers) {
    const [pair = '', ...attributes] = header.split(';')
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    if (!KEPT.has(name)) continue
    const value = cleanValue(pair.slice(eq + 1))
    const expired = attributes.some((attribute) => {
      const [key = '', raw = ''] = attribute.split('=', 2).map(part => part.trim())
      if (key.toLowerCase() === 'max-age') return Number(raw) <= 0
      if (key.toLowerCase() === 'expires') return Date.parse(raw) <= now
      return false
    })
    if (expired || value === undefined) next.delete(name)
    else next.set(name, value)
  }
  return Object.fromEntries(next)
}

/**
 * The jar the QR poll's `data.url` carries in its query (the cross-domain
 * redirect that sets cookies on other Bilibili sites).
 * @param url - `data.url` of a successful poll.
 * @returns the kept cookies found in it.
 */
export function cookiesFromUrl(url: string): CookieJar {
  const parsed = URL.parse(url)
  const jar: CookieJar = {}
  if (parsed === null) return jar
  for (const name of COOKIE_NAMES) {
    const raw = parsed.searchParams.get(name)
    // searchParams decodes `%2C`; the cookie keeps Bilibili's encoded form.
    const value = raw === null ? undefined : cleanValue(encodeURIComponent(raw))
    if (value !== undefined) jar[name] = value
  }
  return jar
}

/**
 * `Cookie` header of a jar.
 * @param jar - cookies to send.
 * @returns `name=value; …`, or an empty string for an empty jar.
 */
export function cookieHeader(jar: CookieJar): string {
  return COOKIE_NAMES.flatMap(name => (jar[name] === undefined ? [] : [`${name}=${jar[name]}`])).join('; ')
}

/**
 * Whether a jar holds a signed-in web session.
 * @param jar - cookies to check.
 */
export function isSignedIn(jar: CookieJar): jar is CookieJar & Record<'SESSDATA' | 'bili_jct' | 'DedeUserID', string> {
  return jar.SESSDATA !== undefined && jar.bili_jct !== undefined && jar.DedeUserID !== undefined
}
