import { describe, expect, it } from 'vitest'
import { GmailApi } from '../src/api.ts'
import type { GmailMessage, GmailPart } from '../src/message.ts'
import { readVerificationCode, type VerificationLookup } from '../src/verification.ts'

const NOW = 1_700_000_000_000
const LOOKUP: VerificationLookup = {
  domain: 'example.co.uk',
  domainOf: host => host.toLowerCase().endsWith('.example.co.uk') || host.toLowerCase() === 'example.co.uk' ? 'example.co.uk' : null,
  allowsLinkHost: host => ['mail.example.co.uk', 'example.co.uk', 'pinned-mailer.example'].includes(host),
  after: NOW - 30 * 60_000, before: NOW,
  signal: new AbortController().signal,
}

const simplePart = (body: string, mimeType = 'text/plain'): GmailPart => ({ mimeType, body: { data: Buffer.from(body).toString('base64url') } })

function message(
  id: string, subject: string,
  options: { beforeMs?: number; sender?: string; date?: string; labels?: string[]; body?: GmailPart } = {},
): GmailMessage {
  const headers = [{ name: 'From', value: options.sender ?? 'Careers <verify@Mail.Example.Co.Uk>' }, { name: 'Subject', value: subject }]
  return { id, threadId: 't1', internalDate: options.date ?? String(NOW - (options.beforeMs ?? 1000)), labelIds: options.labels ?? ['INBOX'], payload: { ...options.body, headers } }
}

function fixture(messages: GmailMessage[], options: { nextPageToken?: string; full?: GmailMessage[] } = {}) {
  const calls: URL[] = []
  const api = new GmailApi({
    timeoutMs: 1000, accessToken: async () => 'fake-token', retryDelaysMs: [],
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input)
      calls.push(url)
      // Gmail leaves out `messages` when nothing matches.
      if (url.pathname.endsWith('/messages')) return Response.json({ ...messages.length === 0 ? {} : { messages: messages.map(({ id }) => ({ id })) }, nextPageToken: options.nextPageToken })
      const id = url.pathname.split('/').at(-1)
      const format = url.searchParams.get('format')
      const mail = (format === 'full' ? (options.full ?? messages) : messages).find(row => row.id === id)
      if (mail === undefined) return new Response(null, { status: 404 })
      return Response.json(format === 'metadata' ? { ...mail, payload: { headers: mail.payload?.headers } } : mail)
    },
  })
  const run = (lookup: VerificationLookup = LOOKUP, limit = 20) => readVerificationCode(api, lookup, limit, 10_000, 1_000)
  return { calls, run }
}

const result = (code: string, receivedAt = NOW - 1000, ambiguous = false) => ({ code, link: null, domain: 'example.co.uk', receivedAt, ambiguous })

describe('Gmail verification proofs', () => {
  it('queries message ids using canonical domain and epoch seconds, then chooses newest by checked internalDate', async () => {
    const h = fixture([
      message('old', 'Your verification code: 2222', { beforeMs: 2000 }),
      message('new', 'Verify: 004321 or 99887766', { body: simplePart('Body verification code is 8999') }),
      message('same', 'One-time code is 004321', { beforeMs: 1500 }),
    ])
    expect(await h.run()).toEqual(result('004321', NOW - 1000, true))
    expect(h.calls[0]?.searchParams.get('q')).toBe('from:example.co.uk after:1699998199 -in:sent -in:drafts')
    expect(h.calls[0]?.searchParams.get('maxResults')).toBe('20')
    expect(h.calls.slice(1).every(url => url.searchParams.get('format') === 'metadata')).toBe(true)
    expect(h.calls[1]?.searchParams.getAll('metadataHeaders')).toEqual(['From', 'Subject'])
    expect(h.calls.some(url => url.pathname.includes('/threads') || url.pathname.includes('/attachments'))).toBe(false)
  })

  it('rejects other sender domains, misleading display names, sent messages, and all stale or invalid receipt dates before the body', async () => {
    const h = fixture([
      message('suffix', 'Verification: 9876', { sender: 'verify@example.co.uk.attacker.com' }),
      message('display', 'Verification: 9876', { sender: 'verify@example.co.uk <a@attacker.com>' }),
      message('multiple', 'Verification: 9876', { sender: 'a@attacker.com, <verify@example.co.uk>' }),
      message('sent', 'Verification: 9876', { labels: ['SENT'] }),
      message('spam', 'Verification: 9876', { labels: ['SPAM'] }),
      message('stale', 'Verification: 9876', { date: String(LOOKUP.after - 1) }),
      message('future', 'Verification: 9876', { date: String(LOOKUP.before + 1) }),
      message('missing', 'Verification: 9876', { date: '' }),
    ])
    expect(await h.run()).toBeNull()
    expect(h.calls).toHaveLength(9)
    expect(h.calls.slice(1).every(url => url.searchParams.get('format') === 'metadata')).toBe(true)
  })

  it.each([
    ['Your verification is ready', 'ID 123456789 and A3456; verification code: 00001111', '00001111'],
    ['Login', '  0123  ', '0123'],
    ['7890', 'The other number was 9876', '7890'],
    ['验证码', '本次验证码001234', '001234'],
    ['Application submitted', 'Your reference number is 23456789.', null],
    ['Application submitted', 'Your unrelated mixed id is a1234b.', null],
  ])('handles subject %s and body %s', async (subject, body, code) => {
    const h = fixture([message('a', subject, { body: simplePart(body) })])
    expect(await h.run()).toEqual(code === null ? null : result(code))
  })

  it('ignores a repeated code and untrusted content hidden in attachments', async () => {
    const h = fixture([
      message('good1', 'Sign-in code: 31415'),
      message('good2', 'Verification: 31415', { beforeMs: 2500 }),
      message('bad', 'Account verification', { beforeMs: 100, body: { mimeType: 'multipart/mixed', parts: [
        { ...simplePart('Verification code was 1111'), filename: 'secret.txt' },
        { mimeType: 'message/rfc822', parts: [simplePart('Verification code was 2222')] },
        { ...simplePart('Verification code was 3333'), headers: [{ name: 'Content-Disposition', value: 'attachment' }] },
      ] } }),
    ])
    expect(await h.run()).toEqual(result('31415'))
  })

  it('does not trust sender or freshness if the full response differs from metadata', async () => {
    const h = fixture([message('a', 'Verification')], { full: [message('a', 'Verification', { sender: 'verify@outside.example', body: simplePart('Verification code was 1234') })] })
    expect(await h.run()).toBeNull()
    expect(h.calls.at(-1)?.searchParams.get('format')).toBe('full')
  })

  it('fails closed when the verification result page is incomplete or the domain would inject search syntax', async () => {
    const h = fixture([message('a', 'Verification code 1234')], { nextPageToken: 'next' })
    await expect(h.run()).rejects.toMatchObject({ failure: 'limit' })
    expect(h.calls).toHaveLength(1)
    await expect(h.run({ ...LOOKUP, domain: 'example.co.uk -from:' })).rejects.toMatchObject({ failure: 'invalid' })
    expect(h.calls).toHaveLength(1)
  })

  it('preserves only an approved verification link from HTML and does not mistake its numeric token for a code', async () => {
    const h = fixture([message('link', 'Verify your account', { body: simplePart(
      '<p><a href="https://evil.example/verify?a=112233">Verify</a></p><p><a href="https://pinned-mailer.example/verify?token=001234&amp;other=x">Verify account</a></p>', 'text/html',
    ) })])
    expect(await h.run()).toEqual({ code: null, link: 'https://pinned-mailer.example/verify?token=001234&other=x', domain: 'example.co.uk', receivedAt: NOW - 1000, ambiguous: false })
  })

  it.each([
    'http://mail.example.co.uk/verify?token=foo',
    'https://mail.example.co.uk.evil.example/verify?token=foo',
    'https://mail.example.co.uk@evil.example/verify?token=foo',
    'https://evil.example@mail.example.co.uk/verify?token=foo',
    'https://mail.example.co.uk:1234/verify?token=foo',
    'https://evil.example/verify?token=foo&host=mail.example.co.uk',
  ])('rejects an unsafe link: %s', async (link) => {
    const h = fixture([message('link', 'Verify your account', { body: simplePart(`Verify: ${link}`) })])
    expect(await h.run()).toBeNull()
  })

  it('takes the verification link over a number far from any verification wording, as in a Workday account email', async () => {
    // WellSky's Workday account email (2026-11-28) carried a stray number, and the tool answered it instead of the link.
    const link = 'https://mail.example.co.uk/verify?token=abc'
    const h = fixture([message('workday', 'Verify your account', { body: simplePart([
      'Hi, please verify your account to finish creating it.', link, '',
      'If you did not create this account, ignore this email.',
      'Office: 11300 Switzer Road, Overland Park, KS 66210', '© 2026 Workday, Inc. All rights reserved.',
    ].join('\n')) })])
    expect(await h.run()).toEqual({ code: null, link, domain: 'example.co.uk', receivedAt: NOW - 1000, ambiguous: false })
  })

  it('reads a code just before its verification wording', async () => {
    const h = fixture([message('before', 'Welcome', { body: simplePart('Use 482913 to sign in. Our office is at 11300 Switzer Road.') })])
    expect(await h.run()).toEqual(result('482913'))
  })

  it('returns a code instead of a newer link, and otherwise marks competing verification links ambiguous', async () => {
    const links = [
      message('new', 'Verify account', { body: simplePart('https://mail.example.co.uk/verify?a=new') }),
      message('other', 'Verify account', { beforeMs: 1500, body: simplePart('https://pinned-mailer.example/verify?a=other') }),
    ]
    expect(await fixture(links).run()).toEqual({ code: null, link: 'https://mail.example.co.uk/verify?a=new', domain: 'example.co.uk', receivedAt: NOW - 1000, ambiguous: true })
    expect(await fixture([...links, message('code', 'Verify account with 4321', { beforeMs: 3000 })]).run()).toEqual(result('4321', NOW - 3000))
  })

  it('takes a resend\'s link over the earlier link on the same host, as WellSky\'s Workday account email resent one', async () => {
    const h = fixture([
      message('resent', 'Verify account', { body: simplePart('https://mail.example.co.uk/verify?a=resent') }),
      message('first', 'Verify account', { beforeMs: 2000, body: simplePart('https://mail.example.co.uk/verify?a=first') }),
    ])
    expect(await h.run()).toEqual({ code: null, link: 'https://mail.example.co.uk/verify?a=resent', domain: 'example.co.uk', receivedAt: NOW - 1000, ambiguous: false })
  })

  it('takes the link on the caller\'s live host over a newer one for another tenant of the same sender', async () => {
    // Workday mails every tenant's account verification from myworkday.com.
    const h = fixture([
      message('tenant', 'Verify account', { body: simplePart('https://pinned-mailer.example/verify?a=other-tenant') }),
      message('live', 'Verify account', { beforeMs: 2000, body: simplePart('https://mail.example.co.uk/verify?a=resent') }),
      message('live-first', 'Verify account', { beforeMs: 3000, body: simplePart('https://mail.example.co.uk/verify?a=first') }),
    ])
    expect(await h.run({ ...LOOKUP, liveHost: 'mail.example.co.uk' })).toEqual({ code: null, link: 'https://mail.example.co.uk/verify?a=resent', domain: 'example.co.uk', receivedAt: NOW - 2000, ambiguous: false })
    expect(await h.run({ ...LOOKUP, liveHost: 'careers.example.co.uk' })).toEqual({ code: null, link: 'https://pinned-mailer.example/verify?a=other-tenant', domain: 'example.co.uk', receivedAt: NOW - 1000, ambiguous: true })
  })

  it.each([
    ['its path', 'Password Reset', 'Hello, we received your request. https://mail.example.co.uk/en-US/Site/passwordreset/abc123'],
    ['wording just before it', 'Your account', 'Click the link below to reset your password: https://mail.example.co.uk/welcome?t=7'],
    ['a reset subject when it is the only link', 'Reset Password', 'Open https://mail.example.co.uk/welcome?t=8'],
  ])('takes a password reset link by %s, as Priceline\'s Workday recovery email sends one', async (_case, subject, body) => {
    // 2026-11-28 06:45: the worker reset the password of an existing Workday account and the reader took no link.
    const h = fixture([message('reset', subject, { body: simplePart(`${body}\nOffice: 800 Connecticut Avenue, Norwalk, CT 06854`) })])
    expect(await h.run()).toEqual({ code: null, link: body.slice(body.indexOf('https://')), domain: 'example.co.uk', receivedAt: NOW - 1000, ambiguous: false })
  })

  it('reads only the pinned sender address when one is given, as Goldman Sachs mails from gsrecruiting@oracle.com', async () => {
    const h = fixture([
      message('account', 'Your sign-in code is 1111', { sender: 'Accounts <account@mail.example.co.uk>' }),
      message('pinned', 'Your verification code is 2222', { beforeMs: 2000, sender: 'Recruiting <Recruiting@Mail.Example.co.uk>' }),
    ])
    expect(await h.run({ ...LOOKUP, address: 'recruiting@mail.example.co.uk' })).toEqual(result('2222', NOW - 2000))
    expect(h.calls[0]?.searchParams.get('q')).toBe('from:recruiting@mail.example.co.uk after:1699998199 -in:sent -in:drafts')
    await expect(h.run({ ...LOOKUP, address: 'recruiting@other.example' })).rejects.toThrow('invalid verification address')
    await expect(h.run({ ...LOOKUP, address: 'a@mail.example.co.uk OR from:x.com' })).rejects.toThrow('invalid verification address')
  })

  it('finds nothing when no message matches', async () => {
    expect(await fixture([]).run()).toBeNull()
  })

  it('skips a message without exactly one plain From address or without a receipt time', async () => {
    const bare = message('bare', 'Verification code 1234')
    const h = fixture([
      { ...bare, id: 'none', payload: {} },
      { ...bare, id: 'two', payload: { headers: [...bare.payload?.headers ?? [], { name: 'From', value: 'other@example.co.uk' }] } },
      message('malformed', 'Verification code 1234', { sender: 'Careers <not an address>' }),
      { ...bare, id: 'undated', internalDate: undefined },
    ])
    expect(await h.run()).toBeNull()
  })

  it('reads text nested in an inline multipart body, including a part without a media type', async () => {
    const h = fixture([message('nested', 'Your account', { body: { mimeType: 'multipart/alternative', parts: [
      { body: { data: Buffer.from('ignored').toString('base64url') } },
      { mimeType: 'multipart/related', parts: [simplePart('Verification code was 5678')] },
    ] } })])
    expect(await h.run()).toEqual(result('5678'))
  })

  it('breaks a tie in receipt time by message id', async () => {
    const h = fixture([message('b', 'Verification code 2222'), message('a', 'Verification code 1111')])
    expect(await h.run()).toEqual(result('1111', NOW - 1000, true))
  })

  it.each([
    ['wording just before it', 'Account', 'Click to verify your account: https://mail.example.co.uk/welcome?t=1', 'https://mail.example.co.uk/welcome?t=1'],
    ['a verification subject when it is the only link', 'Verify your account', 'Open https://mail.example.co.uk/welcome?t=2', 'https://mail.example.co.uk/welcome?t=2'],
    ['none of those', 'Account', 'Open https://mail.example.co.uk/welcome?t=3', null],
  ])('takes a link that carries no verification path by %s', async (_case, subject, body, link) => {
    const h = fixture([message('link', subject, { body: simplePart(body) })])
    expect(await h.run()).toEqual(link === null ? null : { code: null, link, domain: 'example.co.uk', receivedAt: NOW - 1000, ambiguous: false })
  })

  it('does not call the same link in two messages ambiguous', async () => {
    const h = fixture([
      message('new', 'Verify account', { body: simplePart('https://mail.example.co.uk/verify?a=same') }),
      message('old', 'Verify account', { beforeMs: 2000, body: simplePart('https://mail.example.co.uk/verify?a=same') }),
    ])
    expect(await h.run()).toEqual({ code: null, link: 'https://mail.example.co.uk/verify?a=same', domain: 'example.co.uk', receivedAt: NOW - 1000, ambiguous: false })
  })
})
