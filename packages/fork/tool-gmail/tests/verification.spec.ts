import { Context } from '@deepseek-ai/cordis'
import type { AccountView, VerificationProof, VerificationLookup } from '@deepseek-ai/dsh-gmail'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as ToolGmail from '../src/index.ts'
import { openTurn } from './session.ts'

const contexts: Context[] = []
const RESULT: VerificationProof = { code: '004321', link: null, domain: 'example.co.uk', receivedAt: 1_700_000_000_000, ambiguous: false }
const NO_CODE = { found: false, code: null, link: null, from_domain: null, received_at: null, ambiguous: false }
const MISMATCH = { ...NO_CODE, error: 'domain_mismatch' }
const ARGS = { account: 'work', sender_domain: 'Mail.Example.CO.UK.' }
const SESSION = openTurn([], [], 'job-session')

async function mount(host: string | null = 'Careers.Example.Co.Uk.', provideBrowser = true, mode: ToolGmail.Config['mode'] = 'verification-only', links: string[] = [], frames: string[] = []) {
  const ctx = new Context()
  contexts.push(ctx)
  const logs: string[] = []
  const gmail = {
    accounts: vi.fn((): AccountView[] => [{
      id: 'work', email: 'owner@example.org', name: 'secret-name', policy: 'direct', addedAt: 0, lastOkAt: null, lastError: 'secret-error', needsReconnect: true, sentToday: 8,
    }]),
    verificationCode: vi.fn(async (_account: string, _lookup: VerificationLookup): Promise<VerificationProof | null> => RESULT),
    held: vi.fn(), search: vi.fn(), thread: vi.fn(), message: vi.fn(), download: vi.fn(),
  }
  const currentHost = vi.fn(async (_id: string, _signal?: AbortSignal) => host)
  const linkedHosts = vi.fn(async (_id: string, _signal?: AbortSignal): Promise<readonly string[]> => links)
  const frameHosts = vi.fn(async (_id: string, _signal?: AbortSignal): Promise<readonly string[]> => frames)
  // This is a deliberately small fixture, not a replacement PSL implementation.
  const registrableDomain = vi.fn((value: string) => {
    const labels = value.split('.')
    const suffix = value.endsWith('.co.uk') ? 3 : 2
    return value === 'co.uk' || labels.length < suffix ? null : labels.slice(-suffix).join('.')
  })
  ctx.logger.exporter({ levels: { default: 3 }, export: (entry) => { logs.push(String(entry.args[0])) } })
  ctx.provide('systemPrompt', { tools: () => () => {} } as never)
  await ctx.plugin(ToolRuntime)
  ctx.provide('gmail', gmail as never)
  if (provideBrowser) ctx.provide('jobApplyBrowser', { currentHost, linkedHosts, frameHosts, registrableDomain })
  await ctx.plugin(ToolGmail, { timeZone: 'UTC', mode })
  const invoke = async (args: Record<string, unknown>, withAgent = true, signal = new AbortController().signal) => {
    const tool = ctx.tools.get('gmail_verification_code')!
    const value = await tool.execute(args, { agent: withAgent ? { session: SESSION } : undefined, signal } as never)
    return { value, content: tool.output.render(args, value as JsonValue) }
  }
  return { ctx, gmail, logs, currentHost, linkedHosts, frameHosts, registrableDomain, invoke }
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('inbox-only mode', () => {
  it('exposes only search and read, with untrusted mail output', async () => {
    const { ctx, gmail } = await mount(null, false, 'inbox-only')
    expect(ctx.tools.schemas().map(schema => schema.name).sort()).toEqual(['gmail_read', 'gmail_search'])
    const tool = ctx.tools.get('gmail_read')!
    expect(tool.output.render({ account: 'work' }, { text: 'Sender-written instruction' })[0]).toMatchObject({ text: expect.stringContaining('trust="untrusted"') as string })
    expect(gmail.accounts).not.toHaveBeenCalled()
    expect(gmail.download).not.toHaveBeenCalled()
  })
})

describe('verification-only mode', () => {
  it('registers only account ids and verification; account output drops policy, health, name, and holds', async () => {
    const { ctx, gmail } = await mount()
    expect(ctx.tools.schemas().map(schema => schema.name).sort()).toEqual(['gmail_accounts', 'gmail_verification_code'])
    const tool = ctx.tools.get('gmail_accounts')!
    const accounts = await tool.execute({}, {} as never)
    expect(accounts).toEqual({ accounts: [{ id: 'work', email: 'owner@example.org' }] })
    expect(tool.output.render({}, accounts as JsonValue)).toEqual([{ type: 'text', text: '{"accounts":[{"id":"work","email":"owner@example.org"}]}' }])
    expect(gmail.held).not.toHaveBeenCalled()
  })

  it('presents both calls as reads', async () => {
    const { ctx } = await mount()
    expect(ctx.tools.get('gmail_accounts')!.presentCall?.({})).toEqual({ card: 'generic', title: 'Gmail accounts', kind: 'read' })
    expect(ctx.tools.get('gmail_verification_code')!.presentCall?.(ARGS)).toEqual({ card: 'generic', title: 'Gmail verification code', kind: 'read' })
  })

  it('uses the trusted Session id, normalizes hostnames, checks again after Gmail, and emits only the reduced JSON', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_001_000)
    try {
      const h = await mount()
      const signal = new AbortController().signal
      const reply = await h.invoke({ ...ARGS, session_id: 'other-session' }, true, signal)
      const expected = { found: true, code: '004321', link: null, from_domain: 'example.co.uk', received_at: '2023-11-14T22:13:20.000Z', ambiguous: false }
      expect(reply.value).toEqual(expected)
      expect(reply.content).toEqual([{ type: 'text', text: JSON.stringify(expected) }])
      expect(h.currentHost.mock.calls).toEqual([['job-session', signal], ['job-session', signal]])
      expect(h.gmail.verificationCode).toHaveBeenCalledWith('work', expect.objectContaining({ domain: 'example.co.uk', after: 1_699_998_201_000, before: 1_700_000_001_000, signal }))
      expect(h.registrableDomain.mock.calls).toEqual([['careers.example.co.uk'], ['mail.example.co.uk']])
      expect(h.currentHost.mock.invocationCallOrder[0]).toBeLessThan(h.gmail.verificationCode.mock.invocationCallOrder[0]!)
      expect(h.currentHost.mock.invocationCallOrder[1]).toBeGreaterThan(h.gmail.verificationCode.mock.invocationCallOrder[0]!)
      expect(h.logs.join('\n')).not.toContain('004321')
    } finally {
      vi.restoreAllMocks()
    }
  })

  it.each([[99_999, 1440], [-50, 1], [5, 5], [0, 30]])('clamps %i minutes to %i', async (lookback_minutes, clamped) => {
    const h = await mount()
    h.gmail.verificationCode.mockResolvedValue(null)
    expect((await h.invoke({ ...ARGS, lookback_minutes })).value).toEqual(NO_CODE)
    const lookup = h.gmail.verificationCode.mock.calls[0]![1]
    expect(lookup.before - lookup.after).toBe(clamped * 60_000)
  })

  it.each([
    ['tenant.wd1.myworkdayjobs.com', 'workday.com'],
    ['workday.com', 'myworkdayjobs.com'],
    ['tenant.wd5.myworkdayjobs.com', 'myworkday.com'],
    ['boards.greenhouse.io', 'eu.greenhouse-mail.io'],
  ])('allows the pinned vendor pair %s and %s', async (host, sender_domain) => {
    const h = await mount(host)
    h.gmail.verificationCode.mockResolvedValue({ ...RESULT, domain: sender_domain.endsWith('greenhouse-mail.io') ? 'greenhouse-mail.io' : sender_domain, ambiguous: true })
    expect((await h.invoke({ ...ARGS, sender_domain })).value).toMatchObject({ found: true, ambiguous: true })
  })

  it.each([
    ['tenant.wd1.myworkdayjobs.com', 'employer.example'],
    ['tenant.wd1.myworkdayjobs.com', 'notworkday.com'],
    ['tenant.wd1.myworkdayjobs.com', 'workday.com.example'],
    ['tenant.wd1.myworkdayjobs.com', 'notmyworkday.com'],
    ['careers.example.co.uk', 'other.co.uk'],
    ['careers.example.co.uk', 'https://example.co.uk'],
    ['careers.example.co.uk', 'example.co.uk -in:inbox'],
    ['careers.example.co.uk', 'owner@example.co.uk'],
    ['careers.example.co.uk', 'co.uk'],
    ['careers.example.co.uk', 'mail-.example.co.uk'],
    ['127.0.0.1', '127.0.0.1'],
    [null, 'example.co.uk'],
  ])('refuses host %s with sender %s without touching mail', async (host, sender_domain) => {
    const h = await mount(host)
    const { value, content } = await h.invoke({ ...ARGS, sender_domain })
    expect(value).toEqual(MISMATCH)
    expect(content).toEqual([{ type: 'text', text: JSON.stringify(MISMATCH) }])
    expect(h.gmail.verificationCode).not.toHaveBeenCalled()
    expect(h.logs).toEqual(['tool-gmail: gmail_verification_code domain_mismatch'])
  })

  it.each(['accounts.google.com', 'mail.gmail.com', 'github.com', 'appleid.apple.com', 'icloud.com', 'account.microsoft.com', 'outlook.live.com', 'sso.nyu.edu', 'paypal.com', 'secure.chase.com', 'api.lishuyu.app'])('refuses sensitive sender %s even when the active site matches', async (domain) => {
    const h = await mount(domain)
    expect((await h.invoke({ ...ARGS, sender_domain: domain })).value).toEqual({ ...NO_CODE, error: 'sensitive_sender' })
    expect(h.gmail.verificationCode).not.toHaveBeenCalled()
    expect(h.logs).toEqual(['tool-gmail: gmail_verification_code sensitive_sender'])
  })

  it('searches every domain of a pinned vendor and returns the newest proof', async () => {
    const h = await mount('pipersandler.wd501.myworkdayjobs.com')
    const asked: string[] = []
    h.gmail.verificationCode.mockImplementation(async (_account, lookup) => {
      asked.push(lookup.domain)
      if (lookup.domain === 'workday.com') return { ...RESULT, domain: 'workday.com', receivedAt: RESULT.receivedAt + 60_000 }
      if (lookup.domain === 'myworkday.com') return { ...RESULT, code: null, link: 'https://pipersandler.wd501.myworkdayjobs.com/verify', domain: 'myworkday.com' }
      return null
    })
    expect((await h.invoke({ ...ARGS, sender_domain: 'myworkday.com' })).value).toMatchObject({ found: true, code: RESULT.code, from_domain: 'workday.com' })
    expect(asked).toEqual(['myworkday.com', 'workday.com', 'myworkdayjobs.com'])
    expect(h.gmail.verificationCode).toHaveBeenCalledWith('work', expect.objectContaining({ liveHost: 'pipersandler.wd501.myworkdayjobs.com' }))
    const plain = await mount()
    await plain.invoke(ARGS)
    expect(plain.gmail.verificationCode).toHaveBeenCalledTimes(1)
  })

  it('prefers a link on the live host to a newer link for another tenant from another alias domain', async () => {
    const h = await mount('wellsky.wd1.myworkdayjobs.com')
    h.gmail.verificationCode.mockImplementation(async (_account, lookup) => {
      if (lookup.domain === 'myworkday.com') return { ...RESULT, code: null, link: 'https://wellsky.wd1.myworkdayjobs.com/activate', domain: 'myworkday.com' }
      if (lookup.domain === 'workday.com') return { ...RESULT, code: null, link: 'https://litera.wd12.myworkdayjobs.com/activate', domain: 'workday.com', receivedAt: RESULT.receivedAt + 60_000 }
      return null
    })
    expect((await h.invoke({ ...ARGS, sender_domain: 'myworkday.com' })).value).toMatchObject({ found: true, link: 'https://wellsky.wd1.myworkdayjobs.com/activate', from_domain: 'myworkday.com' })
  })

  it('accepts an employer sender that the caller\'s Oracle page links to, with links back to that ATS', async () => {
    const h = await mount('eodr.fa.us2.oraclecloud.com', true, 'verification-only', ['www.tenethealth.com', 'eodr.fa.us2.oraclecloud.com'])
    h.gmail.verificationCode.mockImplementationOnce(async (_account, lookup) => {
      expect(lookup.domain).toBe('tenethealth.com')
      expect(lookup.allowsLinkHost('eodr.fa.us2.oraclecloud.com')).toBe(true)
      expect(lookup.allowsLinkHost('careers.tenethealth.com')).toBe(true)
      expect(lookup.allowsLinkHost('evil.example')).toBe(false)
      return { ...RESULT, domain: 'tenethealth.com' }
    })
    expect((await h.invoke({ ...ARGS, sender_domain: 'tenethealth.com' })).value).toMatchObject({ found: true, from_domain: 'tenethealth.com' })
    expect(h.linkedHosts).toHaveBeenCalledWith('job-session', expect.anything())
    expect(h.logs).toContain('tool-gmail: gmail_verification_code sender %s vouched by the %s page')
  })

  it.each([
    ['eodr.fa.us2.oraclecloud.com', 'linkedin.com', ['www.linkedin.com']],
    ['eodr.fa.us2.oraclecloud.com', 'myworkday.com', ['www.myworkday.com']],
    ['sagehr.my.salesforce-sites.com', 'salesforce.com', ['www.salesforce.com']],
    ['tenant.wd1.myworkdayjobs.com', 'employer.example', ['www.employer.example']],
    ['careers.example.co.uk', 'employer.example', ['www.employer.example']],
    ['careers.qualcomm.com', 'onetrust.com', ['www.onetrust.com']],
  ])('refuses on %s the sender %s that the page does not vouch for', async (host, sender_domain, links) => {
    const h = await mount(host, true, 'verification-only', links)
    expect((await h.invoke({ ...ARGS, sender_domain })).value).toEqual(MISMATCH)
    expect(h.gmail.verificationCode).not.toHaveBeenCalled()
  })

  it('accepts the employer sender a Salesforce Site links to, as Sage mails from careers.sage.com', async () => {
    // Live Sage fRecruit form, 2026-11-27 20:15: the worker asked for the ATS domain and found nothing.
    const h = await mount('sagehr.my.salesforce-sites.com', true, 'verification-only', ['www.sage.com', 'www.sagepeople.com', 'www.linkedin.com'])
    h.gmail.verificationCode.mockImplementationOnce(async (_account, lookup) => {
      expect(lookup.domain).toBe('sage.com')
      expect(lookup.domainOf('careers.sage.com')).toBe('sage.com')
      return { ...RESULT, domain: 'sage.com' }
    })
    expect((await h.invoke({ ...ARGS, sender_domain: 'careers.sage.com' })).value).toMatchObject({ found: true, from_domain: 'sage.com' })
  })

  it('accepts the ATS vendor sender an employer careers site links to, as Qualcomm\'s Eightfold site mails from eightfold.ai', async () => {
    // Live Qualcomm account verification at careers.qualcomm.com, 2026-11-27 22:23: the code came from confirm@eightfold.ai,
    // and the site's footer links "Powered by eightfold.ai".
    const h = await mount('careers.qualcomm.com', true, 'verification-only', ['www.qualcomm.com', 'careers.qualcomm.com', 'eightfold.ai', 'www.onetrust.com'])
    h.gmail.verificationCode.mockImplementationOnce(async (_account, lookup) => {
      expect(lookup.domain).toBe('eightfold.ai')
      expect(lookup.allowsLinkHost('careers.qualcomm.com')).toBe(true)
      expect(lookup.allowsLinkHost('app.eightfold.ai')).toBe(true)
      expect(lookup.allowsLinkHost('evil.example')).toBe(false)
      return { ...RESULT, domain: 'eightfold.ai' }
    })
    expect((await h.invoke({ ...ARGS, sender_domain: 'eightfold.ai' })).value).toMatchObject({ found: true, from_domain: 'eightfold.ai' })
    expect(h.logs).toContain('tool-gmail: gmail_verification_code sender %s vouched by the %s page')
    const bare = await mount('careers.qualcomm.com', true, 'verification-only', ['www.qualcomm.com'])
    expect((await bare.invoke({ ...ARGS, sender_domain: 'eightfold.ai' })).value).toEqual({ ...MISMATCH, hint: expect.stringContaining('posting page') as string })
    expect(bare.gmail.verificationCode).not.toHaveBeenCalled()
  })

  it('accepts Greenhouse\'s sender for the Greenhouse form an employer page embeds, as Esri\'s posting does', async () => {
    // Live Esri 5070853007 at www.esri.com, 2026-11-28 02:56: the security code came from us.greenhouse-mail.io, and
    // greenhouse.io answered domain_mismatch because the page itself is the employer's.
    const h = await mount('www.esri.com', true, 'verification-only', [], ['www.youtube.com', 'job-boards.greenhouse.io'])
    const asked: string[] = []
    h.gmail.verificationCode.mockImplementation(async (_account, lookup) => {
      asked.push(lookup.domain)
      expect(lookup.liveHost).toBe('job-boards.greenhouse.io')
      return lookup.domain === 'greenhouse-mail.io' ? { ...RESULT, domain: 'greenhouse-mail.io' } : null
    })
    expect((await h.invoke({ ...ARGS, sender_domain: 'us.greenhouse-mail.io' })).value).toMatchObject({ found: true, from_domain: 'greenhouse-mail.io' })
    expect(asked).toEqual(['greenhouse-mail.io', 'greenhouse.io'])
    expect(h.frameHosts).toHaveBeenCalledWith('job-session', expect.anything())
    expect(h.logs).toContain('tool-gmail: gmail_verification_code sender %s for the %s form the %s page embeds')
    expect((await h.invoke({ ...ARGS, sender_domain: 'greenhouse.io' })).value).toMatchObject({ found: true })
  })

  it.each([
    ['no Greenhouse frame', 'greenhouse.io', ['www.youtube.com']],
    ['an embedded page of a vendor that is not pinned', 'lever.co', ['jobs.lever.co']],
    ['an embedded sign-in page', 'linkedin.com', ['www.linkedin.com']],
  ])('refuses the sender of an employer page that embeds %s', async (_case, sender_domain, frames) => {
    const h = await mount('www.esri.com', true, 'verification-only', [], frames)
    expect((await h.invoke({ ...ARGS, sender_domain })).value).toEqual(MISMATCH)
    expect(h.gmail.verificationCode).not.toHaveBeenCalled()
  })

  it('refuses the embedded vendor when the page\'s frames cannot be listed', async () => {
    const h = await mount('www.esri.com', true, 'verification-only', [], ['job-boards.greenhouse.io'])
    h.frameHosts.mockRejectedValue(new Error('page gone'))
    expect((await h.invoke({ ...ARGS, sender_domain: 'greenhouse.io' })).value).toEqual(MISMATCH)
    expect(h.gmail.verificationCode).not.toHaveBeenCalled()
  })

  it('tells the caller to open the posting page when no open Oracle page links to the employer sender', async () => {
    // Tenet's application step at eodr.fa.us2.oraclecloud.com links only doleta.gov and uscis.gov (2026-11-27 20:14).
    const h = await mount('eodr.fa.us2.oraclecloud.com', true, 'verification-only', ['www.doleta.gov', 'www.uscis.gov'])
    const value = (await h.invoke({ ...ARGS, sender_domain: 'tenethealth.com' })).value as Record<string, unknown>
    expect(value).toEqual({ ...MISMATCH, hint: expect.stringContaining('posting page') as string })
    expect(h.gmail.verificationCode).not.toHaveBeenCalled()
    expect(h.logs).toContain('tool-gmail: gmail_verification_code domain_mismatch: no open %s page links to %s')
  })

  it('returns only the trusted link and rejects unrelated or sensitive link hosts', async () => {
    const h = await mount('boards.greenhouse.io')
    const link = 'https://eu.greenhouse-mail.io/verify?token=abc'
    h.gmail.verificationCode.mockImplementationOnce(async (_account, lookup) => {
      expect(lookup.allowsLinkHost('boards.greenhouse.io')).toBe(true)
      expect(lookup.allowsLinkHost('eu.greenhouse-mail.io')).toBe(true)
      expect(lookup.allowsLinkHost('greenhouse-mail.io.evil.example')).toBe(false)
      expect(lookup.allowsLinkHost('accounts.google.com')).toBe(false)
      return { code: null, link, domain: 'greenhouse.io', receivedAt: RESULT.receivedAt, ambiguous: false }
    })
    expect((await h.invoke({ ...ARGS, sender_domain: 'greenhouse.io' })).value).toEqual({ ...NO_CODE, found: true, link, from_domain: 'greenhouse.io', received_at: '2023-11-14T22:13:20.000Z' })
    expect(h.logs.join('\n')).not.toContain(link)
  })

  it('fails closed without the scoped browser or a trusted calling Session', async () => {
    const withoutBrowser = await mount('careers.example.co.uk', false)
    expect((await withoutBrowser.invoke(ARGS)).value).toEqual(MISMATCH)
    expect(withoutBrowser.gmail.verificationCode).not.toHaveBeenCalled()
    const withoutAgent = await mount()
    expect((await withoutAgent.invoke({ ...ARGS, session_id: 'job-session' }, false)).value).toEqual(MISMATCH)
    expect(withoutAgent.currentHost).not.toHaveBeenCalled()
    expect(withoutAgent.gmail.verificationCode).not.toHaveBeenCalled()
  })

  it.each(['other.example.co.uk', 'unrelated.example', null])('does not release a result if the active host changed to %s', async (next) => {
    const h = await mount()
    h.currentHost.mockResolvedValueOnce('careers.example.co.uk').mockResolvedValueOnce(next)
    expect((await h.invoke(ARGS)).value).toEqual(MISMATCH)
    expect(h.gmail.verificationCode).toHaveBeenCalledTimes(1)
  })

  it('redacts Gmail and browser failures from both outputs and logs', async () => {
    const h = await mount()
    h.gmail.verificationCode.mockRejectedValue(new Error('Google error with private mail identifier'))
    expect((await h.invoke(ARGS)).value).toEqual({ ...NO_CODE, error: 'lookup_failed' })
    expect(h.logs).toEqual(['tool-gmail: gmail_verification_code lookup_failed'])
    h.currentHost.mockRejectedValue(new Error('private browser URL'))
    expect((await h.invoke(ARGS)).value).toEqual(MISMATCH)
    expect(h.logs.at(-1)).toBe('tool-gmail: gmail_verification_code domain_mismatch')
  })

  it('reports a mismatch instead of a lookup failure when the active host changed during the lookup', async () => {
    const h = await mount()
    h.gmail.verificationCode.mockRejectedValue(new Error('Google error'))
    h.currentHost.mockResolvedValueOnce('careers.example.co.uk').mockResolvedValueOnce('unrelated.example')
    expect((await h.invoke(ARGS)).value).toEqual(MISMATCH)
  })

  it('does not vouch with a page whose links cannot be read or a suffix lookup that fails', async () => {
    const unreadable = await mount('eodr.fa.us2.oraclecloud.com')
    unreadable.linkedHosts.mockRejectedValue(new Error('page gone'))
    expect((await unreadable.invoke({ ...ARGS, sender_domain: 'tenethealth.com' })).value).toEqual({ ...MISMATCH, hint: expect.stringContaining('posting page') as string })
    const failing = await mount()
    failing.registrableDomain.mockImplementation(() => { throw new Error('suffix list unavailable') })
    expect((await failing.invoke(ARGS)).value).toEqual(MISMATCH)
    expect(failing.gmail.verificationCode).not.toHaveBeenCalled()
  })

  it('refuses a sensitive sender host inside the approved domain and stops searching aliases once cancelled', async () => {
    const h = await mount('tenant.wd1.myworkdayjobs.com')
    const abort = new AbortController()
    h.gmail.verificationCode.mockImplementationOnce(async (_account, lookup) => {
      expect(lookup.domainOf('accounts.google.com')).toBeNull()
      expect(lookup.domainOf('otp.workday.com')).toBe('workday.com')
      abort.abort('cancelled')
      return null
    })
    expect((await h.invoke({ ...ARGS, sender_domain: 'workday.com' }, true, abort.signal)).value).toEqual(MISMATCH)
    expect(h.gmail.verificationCode).toHaveBeenCalledTimes(1)
  })

  it('does not release a result if cancellation occurred during Gmail lookup', async () => {
    const h = await mount()
    const abort = new AbortController()
    h.gmail.verificationCode.mockImplementationOnce(async () => {
      abort.abort('cancelled')
      return RESULT
    })
    expect((await h.invoke(ARGS, true, abort.signal)).value).toEqual(MISMATCH)
  })
})
