import { describe, expect, it } from 'vitest'
import { CoursesApi, CoursesApiError, type CoursesFailure } from '../src/index.ts'

const TOKEN = 'pat_testtokenvalue0000000000000000000000'

function api(fetchImpl: typeof fetch, extra: { timeoutMs?: number; token?: string | undefined } = {}): CoursesApi {
  return new CoursesApi({
    baseUrl: 'https://courses.example/api',
    agent: 'DSH (test)',
    timeoutMs: extra.timeoutMs ?? 5000,
    token: async () => ('token' in extra ? extra.token : TOKEN),
    fetch: fetchImpl,
  })
}

async function failure(promise: Promise<unknown>): Promise<CoursesApiError> {
  const error: unknown = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(CoursesApiError)
  return error as CoursesApiError
}

const answer = (body: BodyInit | null, status = 200): typeof fetch => async () => new Response(body, { status })

describe('courses api call', () => {
  it('posts the arguments to the operation with the token and the agent name and returns the result', async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = []
    const client = api(async (url, init) => {
      seen.push({ url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url, init })
      return Response.json({ ok: true, result: { n: 1 } })
    })
    expect(await client.call('report', { view: 'x' })).toEqual({ n: 1 })
    expect(seen[0]?.url).toBe('https://courses.example/api/v1/ops/report')
    expect(seen[0]?.init?.body).toBe('{"view":"x"}')
    const headers = new Headers(seen[0]?.init?.headers)
    expect([headers.get('authorization'), headers.get('x-courses-agent')]).toEqual([`Bearer ${TOKEN}`, 'DSH (test)'])
  })

  it('aborts the request when the caller\'s signal aborts, reporting a network failure', async () => {
    const controller = new AbortController()
    const client = api(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('aborted by caller')) })
      controller.abort()
    }))
    const error = await failure(client.call('report', {}, controller.signal))
    expect(error).toMatchObject({ failure: 'network', message: 'the courses service could not be reached (aborted by caller)' })
  })

  it('fails with not-configured when the token is missing or empty', async () => {
    const never = answer('{}')
    for (const token of [undefined, '']) {
      const error = await failure(api(never, { token }).call('report', {}))
      expect(error).toMatchObject({ failure: 'not-configured', message: 'the courses token is not set' })
    }
  })

  it('fails with timeout when the service does not answer within timeoutMs', async () => {
    const client = api((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('signal aborted')) })
    }), { timeoutMs: 5 })
    const error = await failure(client.call('report', {}))
    expect(error).toMatchObject({ failure: 'timeout', message: 'the courses service did not answer within 5 ms' })
  })

  it('fails with network and the error text, or the thrown value\'s text when it is not an Error', async () => {
    const refused = api(async () => { throw new Error('connect ECONNREFUSED') })
    expect(await failure(refused.call('report', {}))).toMatchObject({
      failure: 'network', message: 'the courses service could not be reached (connect ECONNREFUSED)',
    })
    const odd = api(async () => { throw 'socket closed' })
    expect(await failure(odd.call('report', {}))).toMatchObject({
      failure: 'network', message: 'the courses service could not be reached (socket closed)',
    })
  })

  it('classifies an answer without JSON as invalid when HTTP 200 and http otherwise', async () => {
    expect(await failure(api(answer('<html>')).call('report', {}))).toMatchObject({
      failure: 'invalid', status: 200, message: 'the courses service answered HTTP 200 without JSON',
    })
    expect(await failure(api(answer('<html>', 502)).call('report', {}))).toMatchObject({
      failure: 'http', status: 502, message: 'the courses service answered HTTP 502 without JSON',
    })
  })

  it('classifies failed envelopes by status and carries the service error cut to 300 characters', async () => {
    const cases: Array<[number, string, CoursesFailure]> = [
      [401, 'bad token', 'auth'], [403, 'wrong audience', 'auth'], [200, 'not ok', 'invalid'], [500, 'boom', 'http'],
    ]
    for (const [status, text, expected] of cases) {
      const error = await failure(api(answer(JSON.stringify({ ok: false, error: text }), status)).call('get', {}))
      expect(error).toMatchObject({ failure: expected, status, message: `courses get failed with HTTP ${status}: ${text}` })
    }
    const body = JSON.stringify({ ok: false, error: 'x'.repeat(400) })
    const long = await failure(api(answer(body, 500)).call('get', {}))
    expect(long.message).toBe(`courses get failed with HTTP 500: ${'x'.repeat(300)}`)
  })

  it('omits the detail when the answer has no error text, including a body that is not an object', async () => {
    const get = (body: string, status: number): Promise<CoursesApiError> => failure(api(answer(body, status)).call('get', {}))
    expect(await get(JSON.stringify({ ok: false }), 500)).toMatchObject({ failure: 'http', message: 'courses get failed with HTTP 500' })
    expect(await get('null', 200)).toMatchObject({ failure: 'invalid', message: 'courses get failed with HTTP 200' })
    expect(await get('"text"', 403)).toMatchObject({ failure: 'auth', message: 'courses get failed with HTTP 403' })
  })

  it('uses the global fetch when none is injected', async () => {
    const original = globalThis.fetch
    globalThis.fetch = async () => Response.json({ ok: true, result: 'via global' })
    try {
      const client = new CoursesApi({ baseUrl: 'https://courses.example/api', agent: 'a', timeoutMs: 5000, token: async () => TOKEN })
      expect(await client.call('report', {})).toBe('via global')
    } finally {
      globalThis.fetch = original
    }
  })
})
