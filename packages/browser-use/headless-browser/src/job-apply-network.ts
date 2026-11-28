/** Deny sensitive destinations in the shared, signed-in job browser. */
import { isIP } from 'node:net'
import type { Page } from 'playwright-core'
import { getDomain } from 'tldts'

const deniedHosts = [
  'gmail.com', 'mail.google.com', 'inbox.google.com', 'drive.google.com', 'docs.google.com', 'photos.google.com',
  'contacts.google.com', 'myaccount.google.com', 'takeout.google.com', 'passwords.google.com',
  'outlook.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'account.microsoft.com',
  'appleid.apple.com', 'account.apple.com', 'icloud.com',
  'mail.yandex.com', 'mail.yandex.ru', 'mail.yahoo.com', 'proton.me', 'protonmail.com',
  'github.com', 'claude.ai', 'anthropic.com', 'chatgpt.com', 'openai.com', 'deepseek.com', 'lishuyu.app',
  'paypal.com', 'venmo.com', 'stripe.com', 'cash.app', 'plaid.com', 'chase.com', 'bankofamerica.com',
  'wellsfargo.com', 'citi.com', 'citibank.com', 'capitalone.com', 'americanexpress.com', 'discover.com',
  'usbank.com', 'td.com', 'pnc.com', 'fidelity.com', 'schwab.com', 'vanguard.com', 'robinhood.com',
]
// Empty roots denote dedicated career hosts. Shared hosts expose only the named subtree.
const careerRoots = new Map([
  ['careers.bankofamerica.com', ''], ['jobs.citi.com', ''], ['jobs.fidelity.com', ''], ['careers.usbank.com', ''],
  ['jobs.td.com', ''], ['careers.pnc.com', ''], ['jobs.discover.com', ''],
  ['stripe.com', 'jobs'], ['robinhood.com', 'careers'], ['openai.com', 'careers'], ['anthropic.com', 'careers'],
])
const sensitiveCareerSegment = new RegExp(`^(?:${[
  'accounts?|account-settings|admin|admin-panel|auth|billing|console|dashboard',
  'log[-_]?in|log[-_]?out|my-account|oauth2?|password|profile|register|saml|secure',
  'sessions?|settings|sign[-_]?(?:in|on|out|up)|sso',
].join('|')})(?:\\.|$)`, 'iu')
const publicCareerSegment = (value: string): boolean => /^[A-Za-z\d._~-]+$/u.test(value) && !sensitiveCareerSegment.test(value)
// NYU's public-facing identity provider is used by Handshake.
const nyuLogin = new Set(['shibboleth.nyu.edu', 'sso.nyu.edu', 'login.nyu.edu'])
const mailProviders = new Set(['google.com', 'office.com', 'office365.com', 'microsoft.com', 'live.com', 'yahoo.com', 'yandex.com', 'yandex.ru', 'icloud.com', 'apple.com'])
const localSuffixes = ['localhost', 'local', 'internal', 'home.arpa', 'ts.net']
const hostMatches = (host: string, name: string): boolean => host === name || host.endsWith(`.${name}`)

/**
 * Reduce a URL to its lowercase hostname without a trailing dot, so logs and errors never carry a path or query.
 * @param url - candidate URL.
 * @returns the hostname, or '[invalid URL]' when the URL does not parse or has no hostname.
 */
export function safeHost(url: string): string {
  return URL.parse(url)?.hostname.replace(/\.$/u, '').toLowerCase() || '[invalid URL]'
}

/**
 * Resolve a DNS name to its registrable domain, treating private suffixes such as `github.io` as public suffixes.
 * @param host - a DNS name.
 * @returns the registrable domain, or null when the host has none.
 */
export function registrableDomain(host: string): string | null {
  return getDomain(host, { allowPrivateDomains: true })
}

function isDeniedHost(host: string): boolean {
  return deniedHosts.some(name => hostMatches(host, name))
}

function isPublicCareerUrl(raw: string, url: URL): boolean {
  const root = careerRoots.get(url.hostname)
  if (root === undefined) return false
  // Reject alternate spellings that a server could route differently from the URL parser.
  const parts = /^https:\/\/([a-z\d.-]+)(?::443)?(\/[^?#]*)?(?=[?#]|$)/iu.exec(raw)
  if (parts?.[1]?.toLowerCase() !== url.hostname || (parts[2] ?? '/') !== url.pathname) return false
  const segments = url.pathname.slice(1).split('/')
  if (segments.at(-1) === '') segments.pop()
  if (root !== '' && segments[0] !== root) return false
  return segments.every(publicCareerSegment) && (url.hash === '' || publicCareerSegment(url.hash.slice(1)))
}

/**
 * Decide whether the shared job profile must refuse a URL: non-HTTP(S), credentialed, local or IP hosts, NYU hosts other
 * than its login pages, denied hosts other than public career pages, and mail-provider inbox paths.
 * @param raw - candidate URL.
 * @returns true when navigation to the URL must be refused, including when it does not parse.
 */
export function deniedJobUrl(raw: string): boolean {
  const url = URL.parse(raw)
  if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '') return true
  const host = safeHost(raw)
  if (!host.includes('.') || isIP(host.replace(/^\[|\]$/gu, '')) !== 0
    || localSuffixes.some(name => hostMatches(host, name))
    || (hostMatches(host, 'nyu.edu') && !nyuLogin.has(host))) return true
  if (isDeniedHost(host)) return !isPublicCareerUrl(raw, url)
  const domain = registrableDomain(host)
  let path = url.pathname
  try {
    path = decodeURIComponent(path)
  } catch (_malformed: unknown) {
    // decodeURIComponent throws only URIError, for a malformed escape; the raw path is compared then.
  }
  return domain !== null && mailProviders.has(domain) && /(?:^|\/)(?:mail|inbox)(?:\/|$)/iu.test(path)
}

/** A browser refusal whose text contains only the blocked hostname. */
export class JobNavigationRefused extends Error {
  /** @param url - the denied URL. */
  constructor(url: string) { super(`navigation_refused: ${safeHost(url)}`) }
}

/**
 * Guard a scoped tab without imposing network policy on the owner's other tabs.
 * @param page - new tab or popup, not yet exposed to the agent.
 * @param refused - report only the denied host.
 */
export async function protectJobPage(page: Page, refused: (url: string, closing: boolean) => void): Promise<void> {
  let closing = false
  const close = (url: string): void => {
    if (closing) return
    closing = true
    refused(url, true)
    void page.close().catch((error: unknown) => { void error })
  }
  const check = (url: string): void => { if (url !== 'about:blank' && deniedJobUrl(url)) close(url) }
  const assertLanding = (): void => {
    const url = page.url()
    if (url === 'about:blank' || !deniedJobUrl(url)) return
    close(url)
    throw new JobNavigationRefused(url)
  }
  page.on('framenavigated', (frame) => { if (frame.parentFrame() === null) check(frame.url()) })
  assertLanding()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.setBypassServiceWorker', { bypass: true })
  const { frameTree } = await cdp.send('Page.getFrameTree')
  const mainFrameId = frameTree.frame.id
  cdp.on('Fetch.requestPaused', (event) => {
    const enforce = async (): Promise<void> => {
      const { requestId, request, responseStatusCode, responseHeaders } = event
      const location = responseHeaders?.find(header => header.name.toLowerCase() === 'location')?.value
      const redirect = responseStatusCode !== undefined && responseStatusCode >= 300 && responseStatusCode < 400 && location !== undefined
      const candidate = redirect ? URL.parse(location, request.url)?.href ?? '' : request.url
      if (deniedJobUrl(candidate)) {
        if (event.resourceType === 'Document' && event.frameId === mainFrameId) close(candidate)
        else refused(candidate, false)
        await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
      } else await cdp.send('Fetch.continueRequest', { requestId })
    }
    void enforce().catch(async (error: unknown) => {
      void error // The target may have closed while a paused request was being resolved.
      try { await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }) }
      catch (closed: unknown) { void closed }
    })
  })
  await page.routeWebSocket('**/*', (socket) => {
    const url = new URL(socket.url())
    if (url.protocol === 'wss:') url.protocol = 'https:'
    // The recruiting exceptions do not permit WebSockets on restricted hosts.
    if (isDeniedHost(safeHost(url.href)) || deniedJobUrl(url.href)) {
      refused(url.href, false)
      void socket.close()
    } else socket.connectToServer()
  })
  await cdp.send('Fetch.enable', { patterns: [{ requestStage: 'Request' }, { requestStage: 'Response' }] })
  assertLanding()
}
