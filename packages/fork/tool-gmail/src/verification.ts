/** The job-apply preset can read codes from the active site's sender domain, never messages. */
import { domainToASCII } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Gmail, VerificationProof } from '@deepseek-ai/dsh-gmail'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Structural consumer of the preset-scoped browser service; the Gmail plugin does not depend on the browser package. */
interface JobApplyBrowser {
  currentHost(sessionId: string, signal?: AbortSignal): Promise<string | null>
  registrableDomain(host: string): string | null
}

const ATS_ALIASES: readonly (readonly string[])[] = [
  ['workday.com', 'myworkdayjobs.com'],
  // Greenhouse's documented US and EU sender subdomains share this registrable domain.
  ['greenhouse.io', 'greenhouse-mail.io'],
]

// This is a finite private-service denylist, not a classification of every bank or identity provider.
const SENSITIVE_DOMAINS = new Set([
  'google.com', 'gmail.com', 'googlemail.com', 'github.com', 'apple.com', 'icloud.com', 'me.com',
  'microsoft.com', 'live.com', 'outlook.com', 'hotmail.com', 'office.com', 'microsoftonline.com',
  'nyu.edu', 'lishuyu.app', 'claude.ai', 'anthropic.com', 'chatgpt.com', 'openai.com',
  'paypal.com', 'venmo.com', 'stripe.com', 'cash.app', 'plaid.com', 'chase.com', 'bankofamerica.com',
  'wellsfargo.com', 'citi.com', 'citibank.com', 'capitalone.com', 'americanexpress.com', 'discover.com',
  'usbank.com', 'td.com', 'pnc.com', 'fidelity.com', 'schwab.com', 'vanguard.com', 'robinhood.com',
])

const MINUTE_MS = 60_000
const DEFAULT_LOOKBACK_MINUTES = 30
const MAX_LOOKBACK_MINUTES = 24 * 60
const NO_CODE = { found: false, code: null, link: null, from_domain: null, received_at: null, ambiguous: false } as const

/** Normalize only a DNS hostname, never a URL, userinfo, or an IP literal. */
function normalizeHost(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const candidate = value.trim().toLowerCase().replace(/\.$/u, '')
  if (!/^[\p{L}\p{N}\p{M}.-]+$/u.test(candidate)) return null
  const host = domainToASCII(candidate)
  if (host.length > 253 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(host)) return null
  if (!/[a-z]/u.test(host.slice(host.lastIndexOf('.') + 1))) return null
  return host
}

function sensitive(host: unknown): boolean {
  let suffix = normalizeHost(host)
  while (suffix !== null && suffix.includes('.')) {
    if (SENSITIVE_DOMAINS.has(suffix)) return true
    suffix = suffix.slice(suffix.indexOf('.') + 1)
  }
  return false
}

function sameSite(site: string, sender: string): boolean {
  return site === sender || ATS_ALIASES.some(domains => domains.includes(site) && domains.includes(sender))
}

async function liveHost(browser: JobApplyBrowser | undefined, sessionId: string | undefined, signal: AbortSignal): Promise<string | null> {
  if (browser === undefined || sessionId === undefined || signal.aborted) return null
  try {
    const host = await browser.currentHost(sessionId, signal)
    return signal.aborted ? null : normalizeHost(host)
  } catch {
    // The runner may have lost or disposed the browser; no browser errors leave the boundary.
    return null
  }
}

function registrable(browser: JobApplyBrowser, value: unknown): string | null {
  const host = normalizeHost(value)
  if (host === null) return null
  try {
    return normalizeHost(browser.registrableDomain(host))
  } catch {
    // A failing suffix lookup cannot authorize a mailbox read.
    return null
  }
}

/**
 * Register the verification-only tool set in the preset tool registry.
 * @param ctx - the preset's scope, which can see its own browser bridge.
 * @param gmail - the Gmail service.
 */
export function registerVerificationTools(ctx: Context, gmail: Gmail): void {
  ctx.tools.register(defineTool({
    name: 'gmail_accounts',
    description: 'List connected Gmail account ids and email addresses for gmail_verification_code.',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute() {
      return { accounts: gmail.accounts().map(({ id, email }) => ({ id, email })) }
    },
    presentCall: () => ({ card: 'generic', title: 'Gmail accounts', kind: 'read' }),
  }))
  ctx.tools.register(defineTool({
    name: 'gmail_verification_code',
    description: 'Find a recent 4–8 digit sign-in or verification code, or a verification link if there is no code, for the active job application tab. The sender domain must belong to that live site or a pinned ATS-owned alias. Sensitive sender domains are refused. Only the code or link, sender domain, receipt time and ambiguity flag are returned; if ambiguous, check with the owner rather than guessing. Do not share the code or link; use them only to complete verification on the matching job application site.',
    parameters: {
      account: { type: 'string', required: true, description: 'Account id from gmail_accounts.' },
      sender_domain: { type: 'string', required: true, description: 'Expected sender domain, not a URL or email address.' },
      lookback_minutes: { type: 'integer', description: 'Look back 30 minutes by default; clamped to 1–1440 minutes.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(input, exec) {
      const sessionId = exec.agent?.session.id
      const browser = ctx.get('jobApplyBrowser') as JobApplyBrowser | undefined
      const mismatch = () => {
        ctx.logger.warn('tool-gmail: gmail_verification_code domain_mismatch')
        return { ...NO_CODE, error: 'domain_mismatch' }
      }
      const before = await liveHost(browser, sessionId, exec.signal)
      if (browser === undefined || before === null) return mismatch()
      const site = registrable(browser, before)
      const sender = registrable(browser, input.sender_domain)
      if (site === null || sender === null || !sameSite(site, sender)) return mismatch()
      if (sensitive(before) || sensitive(site) || sensitive(input.sender_domain) || sensitive(sender)) {
        ctx.logger.warn('tool-gmail: gmail_verification_code sensitive_sender')
        return { ...NO_CODE, error: 'sensitive_sender' }
      }

      const requested = input.lookback_minutes
      const since = Number.isSafeInteger(requested) && requested !== undefined
        ? Math.min(MAX_LOOKBACK_MINUTES, Math.max(1, requested))
        : DEFAULT_LOOKBACK_MINUTES
      const now = Date.now()
      let answer: VerificationProof | null
      try {
        answer = await gmail.verificationCode(input.account.trim(), {
          domain: sender,
          domainOf: host => sensitive(host) ? null : registrable(browser, host),
          allowsLinkHost: (host) => {
            const linkDomain = registrable(browser, host)
            return linkDomain !== null && !sensitive(host) && !sensitive(linkDomain) && sameSite(sender, linkDomain)
          },
          after: now - since * MINUTE_MS,
          before: now,
          signal: exec.signal,
        })
      } catch {
        // API diagnostics may contain message ids or caller data. Only emit the stable failure key.
        if (await liveHost(browser, sessionId, exec.signal) !== before) return mismatch()
        ctx.logger.warn('tool-gmail: gmail_verification_code lookup_failed')
        return { ...NO_CODE, error: 'lookup_failed' }
      }
      // Compare the whole host, including the ATS tenant, rather than comparing only registrable domains.
      if (await liveHost(browser, sessionId, exec.signal) !== before) return mismatch()
      if (answer === null) return { ...NO_CODE }
      return {
        found: true, code: answer.code, link: answer.link, from_domain: answer.domain,
        received_at: new Date(answer.receivedAt).toISOString(), ambiguous: answer.ambiguous,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Gmail verification code', kind: 'read' }),
  }))
}
