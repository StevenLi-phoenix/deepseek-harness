/** Authentication expectations for a keepalive landing page. */
import { setTimeout as sleep } from 'node:timers/promises'
import z from '@deepseek-ai/schemastery'
import { getDomain } from 'tldts'

/** Every configured matcher must pass; hosts and origins within one matcher are alternatives. */
export interface KeepaliveExpectation extends Record<string, unknown> {
  /** Exact final hostnames accepted instead of the default registrable domain. */
  readonly allowHosts?: string[]
  /** Exact final HTTP(S) origins accepted instead of the default registrable domain. */
  readonly allowOrigins?: string[]
  /** Final paths and path descendants that indicate a signed-out landing. */
  readonly forbidPath?: string[]
  /** Literal text that must appear in the visible page. */
  readonly expectText?: string
  /** Regular expression source that must match the visible page. */
  readonly expectRegex?: string
  /** Literal text that must not appear in the visible page. */
  readonly forbidText?: string
  /** Milliseconds to wait after load for required text; when omitted, check once. */
  readonly waitForTextMs?: number
}

/** Serialisable configuration shared by the tool, profile, and store. */
export const KeepaliveExpectation = z.object({
  // A bare string, array, or number schema supplies a value even when omitted.
  allowHosts: z.union([z.array(z.string().min(1)).min(1)]),
  allowOrigins: z.union([z.array(z.string().min(1)).min(1)]),
  forbidPath: z.union([z.array(z.string().min(1)).min(1)]),
  expectText: z.union([z.string().min(1)]),
  expectRegex: z.union([z.string().min(1)]),
  forbidText: z.union([z.string().min(1)]),
  waitForTextMs: z.union([z.natural().min(1).max(30_000)]),
})

/** Schema for the conjunction of authentication matchers. */
export const ExpectationList = z.array(KeepaliveExpectation)

const SIGN_IN_HOST = /(?:^|\.)microsoftonline\.com$|^accounts\.google\.com$|(?:^|\.)sso\./i
const SIGN_IN_PATH = /(?:^|\/)(?:log[-_]?in|sign[-_]?in|login\.aspx|sso|challenge)(?:\/|$)|(?:^|\/)d2l\/error(?:\/|$)/i

function site(host: string): string {
  const canonical = host.toLowerCase().replace(/\.$/u, '')
  return getDomain(canonical, { allowPrivateDomains: true }) ?? canonical
}

/**
 * Check the final HTTP(S) URL. An explicit allowlist replaces the site default, not the sign-in veto.
 * @param target - the request's site host and its matchers.
 * @param landed - the URL after navigation.
 * @returns whether the URL looks like an authenticated location.
 */
export function allowedLanding(target: { domain: string; expect?: readonly KeepaliveExpectation[] }, landed: URL): boolean {
  const host = landed.hostname.toLowerCase().replace(/\.$/u, '')
  if (!['http:', 'https:'].includes(landed.protocol) || SIGN_IN_HOST.test(host) || SIGN_IN_PATH.test(landed.pathname)) return false
  const allowlists = target.expect?.filter(rule => rule.allowHosts !== undefined || rule.allowOrigins !== undefined) ?? []
  if (allowlists.length === 0 && site(host) !== site(target.domain)) return false
  const allowed = allowlists.every(rule => rule.allowHosts?.includes(host) === true || rule.allowOrigins?.includes(landed.origin) === true)
  const forbidden = target.expect?.some(rule => rule.forbidPath?.some(path =>
    landed.pathname === path || landed.pathname.startsWith(`${path}/`)) === true)
  return allowed && forbidden !== true
}

/**
 * Reject unsupported or ambiguous values before an expectation is persisted.
 * @param expect - matcher list from a caller, profile, or state file.
 * @returns an error to report, or nothing for a valid list.
 */
export function expectationError(expect: readonly KeepaliveExpectation[]): string | undefined {
  for (const rule of expect) {
    if (Object.values(rule).every(value => value === undefined)) return 'each expectation must set a matcher'
    if (rule.waitForTextMs !== undefined && (!Number.isInteger(rule.waitForTextMs) || rule.waitForTextMs < 1 || rule.waitForTextMs > 30_000)) return 'waitForTextMs must be a whole number from 1 to 30000'
    if (rule.waitForTextMs !== undefined && rule.expectText === undefined && rule.expectRegex === undefined) return 'waitForTextMs requires expectText or expectRegex in the same matcher'
    if (rule.allowHosts?.some(host => URL.parse(`https://${host}`)?.hostname !== host)) return 'allowHosts must name canonical hostnames without paths or ports'
    if (rule.allowOrigins?.some(origin => URL.parse(origin)?.origin !== origin || !/^https?:\/\//u.test(origin))) return 'allowOrigins must name canonical HTTP(S) origins without paths'
    if (rule.forbidPath?.some(path => !path.startsWith('/') || path.endsWith('/'))) return 'forbidPath entries must start with / and have no trailing slash'
    if (rule.expectRegex !== undefined) {
      try {
        new RegExp(rule.expectRegex, 'u')
      } catch (error: unknown) {
        // A string pattern with literal flags fails only with a SyntaxError.
        return `invalid expectRegex: ${(error as SyntaxError).message}`
      }
    }
  }
  return undefined
}

/**
 * Check the configured text requirements without returning content from the page.
 * @param expect - matchers for the visited page.
 * @param readText - reads the page's rendered text when a rule needs it.
 * @returns the first failing text check, or nothing when all pass.
 */
export async function textFailure(
  expect: readonly KeepaliveExpectation[] | undefined,
  readText: () => Promise<string>,
): Promise<string | undefined> {
  const textRules = expect?.filter(rule => rule.expectText !== undefined || rule.expectRegex !== undefined || rule.forbidText !== undefined)
  if (textRules === undefined || textRules.length === 0) return undefined
  const started = performance.now()
  const rules = textRules.map(rule => ({ rule, regex: rule.expectRegex === undefined ? undefined : new RegExp(rule.expectRegex, 'u') }))
  for (;;) {
    const text = await readText()
    let wait = Number.POSITIVE_INFINITY
    for (const { rule, regex } of rules) {
      if (rule.forbidText !== undefined && text.includes(rule.forbidText)) return 'forbidden_text'
      const missing = rule.expectText !== undefined && !text.includes(rule.expectText)
        ? rule.expectText : regex !== undefined && !regex.test(text) ? rule.expectRegex : undefined
      if (missing === undefined) continue
      if (rule.waitForTextMs === undefined) return `missing_text:${missing}`
      const left = started + rule.waitForTextMs - performance.now()
      if (left <= 0) return 'timeout'
      wait = Math.min(wait, left)
    }
    if (!Number.isFinite(wait)) return undefined
    await sleep(Math.min(wait, 250))
  }
}
