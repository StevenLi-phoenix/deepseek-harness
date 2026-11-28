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

async function mount(host: string | null = 'Careers.Example.Co.Uk.', provideBrowser = true, mode: ToolGmail.Config['mode'] = 'verification-only') {
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
  if (provideBrowser) ctx.provide('jobApplyBrowser', { currentHost, registrableDomain })
  await ctx.plugin(ToolGmail, { timeZone: 'UTC', mode })
  const invoke = async (args: Record<string, unknown>, withAgent = true, signal = new AbortController().signal) => {
    const tool = ctx.tools.get('gmail_verification_code')!
    const value = await tool.execute(args, { agent: withAgent ? { session: SESSION } : undefined, signal } as never)
    return { value, content: tool.output.render(args, value as JsonValue) }
  }
  return { ctx, gmail, logs, currentHost, registrableDomain, invoke }
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
    expect(tool.output.render({ account: 'work' }, { text: 'Sender-written instruction' })[0]).toMatchObject({ text: expect.stringContaining('trust="untrusted"') })
    expect(gmail.accounts).not.toHaveBeenCalled()
    expect(gmail.download).not.toHaveBeenCalled()
  })
})

describe('verification-only mode', () => {
  it('registers only account ids and verification; account output drops policy, health, name, and holds', async () => {
    const { ctx, gmail } = await mount()
    expect(ctx.tools.schemas().map(schema => schema.name).sort()).toEqual(['gmail_accounts', 'gmail_verification_code'])
    const tool = ctx.tools.get('gmail_accounts')!
    expect(await tool.execute({}, {} as never)).toEqual({ accounts: [{ id: 'work', email: 'owner@example.org' }] })
    expect(gmail.held).not.toHaveBeenCalled()
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
