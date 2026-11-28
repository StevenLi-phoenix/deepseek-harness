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
      if (url.pathname.endsWith('/messages')) return Response.json({ messages: messages.map(({ id }) => ({ id })), nextPageToken: options.nextPageToken })
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

  it('returns a code instead of a newer link, and otherwise marks competing verification links ambiguous', async () => {
    const links = [
      message('new', 'Verify account', { body: simplePart('https://mail.example.co.uk/verify?a=new') }),
      message('old', 'Verify account', { beforeMs: 2000, body: simplePart('https://mail.example.co.uk/verify?a=old') }),
    ]
    expect(await fixture(links).run()).toEqual({ code: null, link: 'https://mail.example.co.uk/verify?a=new', domain: 'example.co.uk', receivedAt: NOW - 1000, ambiguous: true })
    expect(await fixture([...links, message('code', 'Verify account with 4321', { beforeMs: 3000 })]).run()).toEqual(result('4321', NOW - 3000))
  })
})
