import { afterEach, describe, expect, it, vi } from 'vitest'
import { GMAIL_API, GMAIL_UPLOAD, GmailApi, GmailApiError, type GmailApiFailure } from '../src/api.ts'

interface Call {
  method: string
  url: URL
  headers: Headers
  body: string | undefined
}

type Answer = Response | Error | ((init: RequestInit | undefined) => Promise<Response>)

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

function client(answers: Answer[], extra: { timeoutMs?: number; retryDelaysMs?: number[] } = {}) {
  const calls: Call[] = []
  const tokens: boolean[] = []
  const sleep = vi.fn(async (_ms: number) => undefined)
  const api = new GmailApi({
    timeoutMs: extra.timeoutMs ?? 5000,
    accessToken: async (fresh) => {
      tokens.push(fresh)
      return fresh ? 'fresh-token' : 'cached-token'
    },
    fetch: async (input, init) => {
      calls.push({
        method: init?.method ?? 'GET',
        url: new URL(urlOf(input)),
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? init.body : undefined,
      })
      const next = answers.shift()
      if (next === undefined) throw new Error('the test queued no answer')
      if (next instanceof Error) throw next
      return typeof next === 'function' ? next(init) : next
    },
    sleep,
    retryDelaysMs: extra.retryDelaysMs ?? [10, 20],
  })
  return { api, calls, tokens, sleep }
}

async function failure(promise: Promise<unknown>): Promise<GmailApiError> {
  const error: unknown = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(GmailApiError)
  return error as GmailApiError
}

const ok = (body: unknown): Response => Response.json(body)
const googleError = (status: number, error: Record<string, unknown>): Response => Response.json({ error }, { status })
const PROFILE = { emailAddress: 'owner@example.com', messagesTotal: 3, threadsTotal: 2 }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('requests', () => {
  it('sends a GET with the bearer token and no body to the user\'s API base', async () => {
    const { api, calls } = client([ok(PROFILE)])
    expect(await api.profile()).toEqual(PROFILE)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('GET')
    expect(calls[0]?.url.href).toBe(`${GMAIL_API}/profile`)
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer cached-token')
    expect(calls[0]?.headers.get('accept')).toBe('application/json')
    expect(calls[0]?.headers.has('content-type')).toBe(false)
    expect(calls[0]?.body).toBeUndefined()
  })

  it('writes the query: the search, the page size, a page token only when given, and repeated metadata headers', async () => {
    const { api, calls } = client([
      ok({ threads: [{ id: 't1', snippet: 's' }], nextPageToken: 'p2', resultSizeEstimate: 9 }),
      ok({ resultSizeEstimate: 0 }),
      ok({ id: 't/1', messages: [{ id: 'm1', threadId: 't/1' }] }),
      ok({ id: 't1' }),
      ok({ id: 'm1', threadId: 't1' }),
    ])
    expect(await api.listThreads('from:ada is:unread', 5)).toEqual({ threads: [{ id: 't1', snippet: 's' }], nextPageToken: 'p2', resultSizeEstimate: 9 })
    expect(await api.listThreads('x', 1, 'p2')).toEqual({ resultSizeEstimate: 0 })
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({ q: 'from:ada is:unread', maxResults: '5' })
    expect(calls[1]?.url.searchParams.get('pageToken')).toBe('p2')
    await api.thread('t/1', 'metadata')
    expect(calls[2]?.url.pathname).toBe('/gmail/v1/users/me/threads/t%2F1')
    expect(calls[2]?.url.searchParams.get('format')).toBe('metadata')
    expect(calls[2]?.url.searchParams.getAll('metadataHeaders')).toEqual(['From', 'To', 'Cc', 'Subject', 'Date'])
    await api.thread('t1', 'full')
    expect(calls[3]?.url.searchParams.has('metadataHeaders')).toBe(false)
    expect(await api.message('m1', 'full')).toEqual({ id: 'm1', threadId: 't1' })
    expect(calls[4]?.url.href).toBe(`${GMAIL_API}/messages/m1?format=full`)
  })

  it('posts JSON for a draft send and a label change', async () => {
    const { api, calls } = client([ok({ id: 'm9', threadId: 't9', labelIds: ['SENT'] }), new Response(null, { status: 204 })])
    expect(await api.sendDraft('d1')).toEqual({ id: 'm9', threadId: 't9', labelIds: ['SENT'] })
    expect(calls[0]?.url.href).toBe(`${GMAIL_API}/drafts/send`)
    expect(calls[0]?.headers.get('content-type')).toBe('application/json')
    expect(calls[0]?.body).toBe('{"id":"d1"}')
    await api.modifyThread('t/2', ['STARRED'], ['UNREAD'])
    expect(calls[1]?.url.href).toBe(`${GMAIL_API}/threads/t%2F2/modify`)
    expect(JSON.parse(calls[1]?.body ?? '')).toEqual({ addLabelIds: ['STARRED'], removeLabelIds: ['UNREAD'] })
  })

  it('moves a thread to the trash and back, and deletes a draft, reading an empty answer as success', async () => {
    const empty = (): Response => new Response(null, { status: 204 })
    const { api, calls } = client([empty(), empty(), new Response('', { status: 200 })])
    await api.trashThread('t1', false)
    await api.trashThread('t1', true)
    await api.deleteDraft('d/1')
    expect(calls.map(call => `${call.method} ${call.url.pathname}`)).toEqual([
      'POST /gmail/v1/users/me/threads/t1/trash', 'POST /gmail/v1/users/me/threads/t1/untrash', 'DELETE /gmail/v1/users/me/drafts/d%2F1',
    ])
  })
})

describe('uploads', () => {
  const RAW = 'From: owner@example.com\r\nTo: ada@example.com\r\nSubject: Hi\r\n\r\nSGk=\r\n'

  function parts(call: Call | undefined): { boundary: string; metadata: unknown; message: string } {
    const type = call?.headers.get('content-type') ?? ''
    const boundary = /^multipart\/related; boundary=(fork-gmail-[0-9a-f]{24})$/u.exec(type)?.[1] ?? ''
    expect(boundary).not.toBe('')
    const body = call?.body ?? ''
    expect(body.endsWith(`--${boundary}--\r\n`)).toBe(true)
    const [, json, rfc822] = body.split(`--${boundary}`)
    expect(json?.startsWith('\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n')).toBe(true)
    expect(rfc822?.startsWith('\r\nContent-Type: message/rfc822\r\n\r\n')).toBe(true)
    return {
      boundary,
      metadata: JSON.parse((json ?? '').split('\r\n\r\n')[1] ?? ''),
      message: (rfc822 ?? '').slice('\r\nContent-Type: message/rfc822\r\n\r\n'.length, -2),
    }
  }

  it('sends a message as multipart/related (JSON metadata, then message/rfc822) to the upload host', async () => {
    const { api, calls } = client([ok({ id: 'm1', threadId: 't1' }), ok({ id: 'm2', threadId: 't2' })])
    expect(await api.send(RAW, 't1')).toEqual({ id: 'm1', threadId: 't1' })
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url.href).toBe(`${GMAIL_UPLOAD}/messages/send?uploadType=multipart`)
    expect(parts(calls[0])).toMatchObject({ metadata: { threadId: 't1' }, message: RAW })
    await api.send(RAW)
    expect(parts(calls[1]).metadata).toEqual({})
    expect(parts(calls[0]).boundary).not.toBe(parts(calls[1]).boundary)
  })

  it('creates and replaces a draft the same way, with the thread in the metadata\'s message', async () => {
    const draft = { id: 'd1', message: { id: 'm1', threadId: 't1' } }
    const { api, calls } = client([ok(draft), ok({ id: 'd2', message: { id: 'm2' } }), ok(draft), ok({ id: 'd1' })])
    expect(await api.createDraft(RAW, 't1')).toEqual(draft)
    expect(calls[0]?.url.href).toBe(`${GMAIL_UPLOAD}/drafts?uploadType=multipart`)
    expect(parts(calls[0]).metadata).toEqual({ message: { threadId: 't1' } })
    expect(await api.createDraft(RAW)).toEqual({ id: 'd2', message: { id: 'm2' } })
    expect(parts(calls[1]).metadata).toEqual({ message: {} })
    await api.updateDraft('d1', RAW, 't1')
    expect(calls[2]?.method).toBe('PUT')
    expect(calls[2]?.url.href).toBe(`${GMAIL_UPLOAD}/drafts/d1?uploadType=multipart`)
    expect(parts(calls[2])).toMatchObject({ metadata: { id: 'd1', message: { threadId: 't1' } }, message: RAW })
    await api.updateDraft('d1', RAW)
    expect(parts(calls[3]).metadata).toEqual({ id: 'd1', message: {} })
  })
})

describe('answers', () => {
  it('reads a draft in full, and its raw text byte for byte from base64url', async () => {
    const bytes = Buffer.from('Subject: café 文\r\nBcc: audit@example.com\r\n\r\nbody', 'utf8')
    const { api, calls } = client([
      ok({ id: 'd1', message: { id: 'm1', threadId: 't1', payload: { mimeType: 'text/plain' } } }),
      ok({ id: 'd1', message: { raw: bytes.toString('base64url') } }),
    ])
    expect(await api.draft('d1')).toEqual({ id: 'd1', message: { id: 'm1', threadId: 't1', payload: { mimeType: 'text/plain' } } })
    expect(calls[0]?.url.searchParams.get('format')).toBe('full')
    const raw = await api.draftRaw('d1')
    expect(calls[1]?.url.searchParams.get('format')).toBe('raw')
    expect(Buffer.from(raw, 'latin1')).toEqual(bytes)
    expect(raw).toContain('Bcc: audit@example.com')
  })

  it('reads an attachment\'s bytes from base64url', async () => {
    const { api, calls } = client([ok({ size: 3, data: Buffer.from([1, 2, 255]).toString('base64url') })])
    expect(Buffer.from(await api.attachment('m1', 'att/1'))).toEqual(Buffer.from([1, 2, 255]))
    expect(calls[0]?.url.pathname).toBe('/gmail/v1/users/me/messages/m1/attachments/att%2F1')
  })

  it('reads the primary send-as display name, or nothing', async () => {
    const { api } = client([
      ok({ sendAs: [{ sendAsEmail: 'alias@example.com', displayName: 'Alias' }, { sendAsEmail: 'owner@example.com', displayName: 'Owner', isPrimary: true }] }),
      ok({ sendAs: [{ sendAsEmail: 'owner@example.com', isPrimary: true }] }),
      ok({ sendAs: [{ sendAsEmail: 'owner@example.com', displayName: 'Owner', isPrimary: false }] }),
      ok({}),
    ])
    expect(await api.displayName()).toBe('Owner')
    expect(await api.displayName()).toBe('')
    expect(await api.displayName()).toBe('')
    expect(await api.displayName()).toBe('')
  })

  it('lists the labels, and none when Gmail sends no list', async () => {
    const labels = [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'Label_1', name: 'Receipts', type: 'user' }]
    const { api } = client([ok({ labels }), ok({})])
    expect(await api.labels()).toEqual(labels)
    expect(await api.labels()).toEqual([])
  })

  it('fails as invalid on an answer in an unexpected shape or without JSON', async () => {
    const { api } = client([ok({ messagesTotal: 1 }), new Response('<html>', { status: 200 }), ok({ id: 'd1', message: {} })])
    expect(await failure(api.profile())).toMatchObject({ name: 'GmailApiError', failure: 'invalid', message: 'Gmail answered the profile in an unexpected shape' })
    expect(await failure(api.labels())).toMatchObject({ failure: 'invalid', message: 'Gmail answered the label list in an unexpected shape' })
    expect(await failure(api.draftRaw('d1'))).toMatchObject({ failure: 'invalid', message: 'Gmail answered the draft in an unexpected shape' })
  })
})

describe('authorization', () => {
  it('drops the token after a 401 and retries once with a fresh one', async () => {
    const { api, calls, tokens } = client([googleError(401, { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' }), ok(PROFILE)])
    expect(await api.profile()).toEqual(PROFILE)
    expect(tokens).toEqual([false, true])
    expect(calls.map(call => call.headers.get('authorization'))).toEqual(['Bearer cached-token', 'Bearer fresh-token'])
  })

  it('fails as auth when the fresh token is refused too, without the token in the message', async () => {
    const refused = (): Response => googleError(401, { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' })
    const { api, calls, sleep } = client([refused(), refused()])
    const error = await failure(api.send('raw'))
    expect(error).toMatchObject({ failure: 'auth', status: 401, message: 'Gmail POST /messages/send failed with HTTP 401 UNAUTHENTICATED: Invalid Credentials' })
    expect(error.message).not.toContain('token')
    expect(calls).toHaveLength(2)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('fails as auth on a 403 that is not a rate limit, at once', async () => {
    const { api, calls } = client([googleError(403, { message: 'Insufficient Permission', errors: [{ reason: 'insufficientPermissions' }] })])
    expect(await failure(api.labels())).toMatchObject({ failure: 'auth', status: 403, message: 'Gmail GET /labels failed with HTTP 403 insufficientPermissions: Insufficient Permission' })
    expect(calls).toHaveLength(1)
  })
})

describe('rate limits and retries', () => {
  it('retries a 429 after each injected pause, then fails as rate', async () => {
    const limited = (): Response => googleError(429, { message: 'Too many requests', status: 'RESOURCE_EXHAUSTED' })
    const { api, calls, sleep } = client([limited(), limited(), limited()])
    expect(await failure(api.send('raw'))).toMatchObject({ failure: 'rate', status: 429 })
    expect(calls).toHaveLength(3)
    expect(sleep.mock.calls).toEqual([[10], [20]])
  })

  it('retries a 403 that names a rate limit, by reason or by status', async () => {
    for (const error of [{ errors: [{ reason: 'rateLimitExceeded' }] }, { errors: [{ reason: 'userRateLimitExceeded' }] }, { status: 'RESOURCE_EXHAUSTED' }]) {
      const { api, calls, sleep } = client([googleError(403, error), ok(PROFILE)])
      expect(await api.profile()).toEqual(PROFILE)
      expect(calls).toHaveLength(2)
      expect(sleep.mock.calls).toEqual([[10]])
    }
  })

  it('retries a 5xx and a broken connection for a call that is safe to repeat', async () => {
    const { api, calls, sleep } = client([googleError(503, { message: 'Backend Error' }), new Error('socket hang up'), ok(PROFILE)])
    expect(await api.profile()).toEqual(PROFILE)
    expect(calls).toHaveLength(3)
    expect(sleep.mock.calls).toEqual([[10], [20]])
    const upload = client([googleError(500, {}), ok({ id: 'd1' })])
    expect(await upload.api.updateDraft('d1', 'raw')).toEqual({ id: 'd1' })
    expect(upload.calls).toHaveLength(2)
  })

  it('fails as http after the last retry of a 5xx', async () => {
    const down = (): Response => googleError(500, { message: 'x'.repeat(400) })
    const { api, calls } = client([down(), down(), down()])
    const error = await failure(api.labels())
    expect(error).toMatchObject({ failure: 'http', status: 500 })
    expect(error.message).toBe(`Gmail GET /labels failed with HTTP 500: ${'x'.repeat(300)}`)
    expect(calls).toHaveLength(3)
  })

  it('never repeats a send, a draft send, or a new draft after a 5xx or a broken connection', async () => {
    const cases: Array<[(api: GmailApi) => Promise<unknown>, Answer, GmailApiFailure, string]> = [
      [api => api.send('raw'), googleError(500, { message: 'Backend Error' }), 'http', 'Gmail POST /messages/send failed with HTTP 500: Backend Error'],
      [api => api.sendDraft('d1'), new Response('<html>Bad Gateway</html>', { status: 502 }), 'http', 'Gmail POST /drafts/send failed with HTTP 502'],
      [api => api.createDraft('raw'), googleError(503, {}), 'http', 'Gmail POST /drafts failed with HTTP 503'],
      [api => api.send('raw'), new Error('ECONNRESET'), 'network', 'Gmail could not be reached (ECONNRESET)'],
    ]
    for (const [run, answer, kind, message] of cases) {
      const { api, calls, sleep } = client([answer, ok({ id: 'm1', threadId: 't1' })])
      expect(await failure(run(api))).toMatchObject({ failure: kind, message })
      expect(calls).toHaveLength(1)
      expect(sleep).not.toHaveBeenCalled()
    }
  })

  it('reports a thrown value that is not an Error by its text', async () => {
    const { api } = client([(async () => { throw 'offline' })], { retryDelaysMs: [] })
    expect(await failure(api.profile())).toMatchObject({ failure: 'network', message: 'Gmail could not be reached (offline)' })
  })

  it('fails as timeout when Gmail does not answer within timeoutMs', async () => {
    const hanging = (init: RequestInit | undefined): Promise<Response> => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
    })
    const { api } = client([hanging], { timeoutMs: 5, retryDelaysMs: [] })
    expect(await failure(api.profile())).toMatchObject({ failure: 'timeout', message: 'Gmail did not answer within 5 ms' })
  })
})

describe('error answers', () => {
  it('fails as not-found on a 404, with Google\'s reason and message', async () => {
    const { api } = client([googleError(404, { code: 404, message: 'Requested entity was not found.', errors: [{ reason: 'notFound' }] })])
    expect(await failure(api.message('m1', 'full'))).toMatchObject({
      failure: 'not-found', status: 404, message: 'Gmail GET /messages/m1 failed with HTTP 404 notFound: Requested entity was not found.',
    })
  })

  it('writes the bare status when Google gives neither a reason nor a message', async () => {
    const { api } = client([googleError(400, {}), googleError(400, { errors: [{}], message: 'Invalid label' })])
    expect(await failure(api.labels())).toMatchObject({ failure: 'http', message: 'Gmail GET /labels failed with HTTP 400' })
    expect(await failure(api.labels())).toMatchObject({ failure: 'http', message: 'Gmail GET /labels failed with HTTP 400: Invalid label' })
  })
})

describe('defaults', () => {
  it('uses the global fetch, a real pause, and the default retry delays when none are injected', async () => {
    vi.useFakeTimers()
    const answers = [googleError(429, { status: 'RESOURCE_EXHAUSTED' }), ok(PROFILE)]
    const globalFetch = vi.fn(async () => answers.shift() ?? ok(PROFILE))
    vi.stubGlobal('fetch', globalFetch)
    const api = new GmailApi({ timeoutMs: 5000, accessToken: async () => 'token' })
    const profile = api.profile()
    await vi.advanceTimersByTimeAsync(999)
    expect(globalFetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await profile).toEqual(PROFILE)
    expect(globalFetch).toHaveBeenCalledTimes(2)
  })
})
