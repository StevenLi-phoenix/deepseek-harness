/**
 * The generic answer to "is this page still asking me to sign in?". A keepalive
 * exists so a session never dies of neglect: it visits a URL the way a person
 * would, and decides from the document's structure — not from its words, and
 * not from a site's selectors — whether the visit landed on the signed-in page.
 *
 * Four signals cover the shapes every sign-in flow has. A visible password
 * field is one; a visible one-time-code field is another; a list of accounts to
 * choose from is the third; and a final URL on another site is the fourth. The
 * probe measures the first three inside the page and returns plain facts, and
 * the decision runs in the host, so the rule is one reviewable function rather
 * than a script per site.
 *
 * @module @deepseek-ai/dsh-headless-browser/challenge
 */

import { pageOrigin } from './guard.ts'

/**
 * The interactive step that stopped a check. `redirect` is a move to another
 * site with no account list to read, and `account-chooser` is the same move
 * where the page asks which account to use.
 */
export type BlockedStep = 'account-chooser' | 'password' | 'mfa' | 'redirect'

/** What one loaded document shows, measured structurally by {@link probeChallenge}. */
export interface ChallengeFacts {
  /** A visible password field is on the page. */
  readonly passwordField: boolean
  /** A visible field asks for a one-time code. */
  readonly oneTimeCode: boolean
  /** How many visible links, buttons, or options name an account by its e-mail address. */
  readonly accountLinks: number
}

/** What a check found when the page is not the signed-in page. */
export interface Challenge {
  /** The step that blocked the check. */
  readonly step: BlockedStep
  /** One short line for the owner and the entry's `lastError`. */
  readonly reason: string
}

/** One challenge request: what was asked for, what answered, and what it showed. */
export interface ChallengeRequest {
  /** URL the keepalive visits. */
  readonly requestedUrl: string
  /** URL the page settled on. */
  readonly finalUrl: string
  /** What the page's structure showed. */
  readonly facts: ChallengeFacts
  /**
   * Site the caller named; a final URL on this domain or below it is still on
   * site, so an SSO host inside the same site is not a move. Defaults to the
   * requested URL's origin.
   */
  readonly domain?: string
  /** URL verdict supplied by a caller with an explicit landing policy. */
  readonly allowedLanding?: boolean
}

/**
 * Measure the document a check landed on. Runs inside the page, so it names no
 * outer binding and returns only plain values; a page-side script is a string by
 * nature, so what it returns is validated at {@link readChallengeFacts}.
 * @returns the three structural facts a sign-in page shows.
 */
export function probeChallenge(): ChallengeFacts {
  const doc = document
  const view = window
  const visible = (element: Element): boolean => {
    if (element.closest('[aria-hidden="true"]') !== null) return false
    const box = element.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0) return false
    const style = view.getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
    const opacity = Number.parseFloat(style.opacity)
    // Literal, not a module constant: this function is serialized into the page
    // and runs where nothing outside its own body exists.
    return Number.isFinite(opacity) ? opacity > 0.05 : true
  }
  const passwordField = Array.from(doc.querySelectorAll('input[type="password" i]')).some(visible)
  const oneTimeCode = Array.from(doc.querySelectorAll('input')).some((field) => {
    if ((field.getAttribute('type') ?? '').trim().toLowerCase() === 'password') return false
    if (!visible(field)) return false
    const autocomplete = (field.getAttribute('autocomplete') ?? '').trim().toLowerCase().split(/\s+/u)
    if (autocomplete.includes('one-time-code')) return true
    const hint = [
      field.getAttribute('name'),
      field.getAttribute('id'),
      field.getAttribute('placeholder'),
      field.getAttribute('aria-label'),
    ].filter((part): part is string => part !== null).join(' ')
    return /(?:\botp\b|one[-\s_]?time|\btotp\b|\b2fa\b|\bmfa\b|verification[-\s_]?code|security[-\s_]?code|验证码)/iu.test(hint)
  })
  // Literal bounds, like every value in this function: it runs in the page,
  // where the only names that exist are the ones its own body declares. Five is
  // enough to tell a chooser from a page, and a link's text is an account label
  // only while it is short.
  let accountLinks = 0
  for (const node of Array.from(doc.querySelectorAll('a, button, [role="button"], [role="link"], [role="option"]'))) {
    if (accountLinks >= 5) break
    if (!visible(node)) continue
    const text = (node.textContent ?? '').replace(/\s+/gu, ' ').trim()
    if (text === '' || text.length > 200 || !/[^\s@]+@[^\s@]+\.[^\s@]+/u.test(text)) continue
    accountLinks += 1
  }
  return { passwordField, oneTimeCode, accountLinks }
}

/**
 * Validate facts that crossed the page boundary, so a page cannot hand the host
 * a value that is not a measurement.
 * @param value - whatever `evaluate` returned.
 * @returns the facts, when every field is present and typed.
 * @throws Error - when a field is missing or mistyped.
 */
export function readChallengeFacts(value: unknown): ChallengeFacts {
  if (typeof value !== 'object' || value === null) throw new Error('the challenge probe returned no object')
  const record = value as Record<string, unknown>
  const passwordField = record.passwordField
  const oneTimeCode = record.oneTimeCode
  const accountLinks = record.accountLinks
  if (typeof passwordField !== 'boolean') throw new Error('the challenge probe returned no passwordField')
  if (typeof oneTimeCode !== 'boolean') throw new Error('the challenge probe returned no oneTimeCode')
  if (typeof accountLinks !== 'number' || !Number.isFinite(accountLinks) || accountLinks < 0) {
    throw new Error('the challenge probe returned no accountLinks')
  }
  return { passwordField, oneTimeCode, accountLinks }
}

/**
 * Decide whether a loaded page is still a sign-in page.
 * @param request - the requested URL, the settled URL, the page's facts, and the caller's site.
 * @returns the blocking step, or `undefined` when the page is the signed-in page.
 */
export function classifyChallenge(request: ChallengeRequest): Challenge | undefined {
  if (request.facts.passwordField) return { step: 'password', reason: 'the page shows a password field' }
  if (request.facts.oneTimeCode) return { step: 'mfa', reason: 'the page asks for a one-time code' }
  if (request.allowedLanding ?? onSite(request)) return undefined
  if (request.facts.accountLinks >= 2) {
    return { step: 'account-chooser', reason: `the page moved to ${siteOf(request.finalUrl)} and lists accounts to choose from` }
  }
  return { step: 'redirect', reason: `the page moved to ${siteOf(request.finalUrl)}` }
}

/**
 * Whether the settled URL is still inside the site the caller asked for.
 * @param request - the requested URL, the settled URL, and the optional domain.
 * @returns whether the page stayed on site.
 */
function onSite(request: ChallengeRequest): boolean {
  if (request.domain !== undefined) {
    const host = hostOf(request.finalUrl)
    return host !== '' && (host === request.domain || host.endsWith(`.${request.domain}`))
  }
  const origin = pageOrigin(request.requestedUrl)
  return origin !== '' && origin === pageOrigin(request.finalUrl)
}

/**
 * The site a failed check reports, without credentials, a query, or a path.
 * @param url - a page URL.
 * @returns the origin, or the URL's own host when it does not parse.
 */
function siteOf(url: string): string {
  const origin = pageOrigin(url)
  return origin === '' ? hostOf(url) || 'another page' : origin
}

/**
 * The lower-case host of a URL, or the empty string.
 * @param url - a page URL.
 * @returns the host without a port, or nothing when the URL does not parse.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch (error: unknown) {
    void error
    return ''
  }
}
