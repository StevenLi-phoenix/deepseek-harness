import { describe, expect, it, vi } from 'vitest'
import { callService, VoiceError } from '../src/http.ts'

const base = { timeoutMs: 1000, retries: 2, retryDelayMs: 10 }

function answers(...statuses: Array<number | Error>) {
  const queue = [...statuses]
  return vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> => {
    const next = queue.shift() ?? 200
    if (next instanceof Error) throw next
    return new Response(next === 200 ? 'ok' : `body ${next}`, { status: next })
  })
}

describe('callService', () => {
  it('retries 5xx and 429 with a doubling pause, then returns the success', async () => {
    const sleep = vi.fn(async () => {})
    const onRetry = vi.fn()
    const fetchMock = answers(503, 429, 200)
    const response = await callService('svc GET /x', 'http://h/x?secret=1', {}, { ...base, fetch: fetchMock, sleep, onRetry })
    expect(await response.text()).toBe('ok')
    expect(sleep.mock.calls).toEqual([[10], [20]])
    expect(onRetry.mock.calls.map((call: unknown[]) => call[0])).toEqual([1, 2])
  })

  it('retries a network error and reports the last reason after the final attempt, without the URL', async () => {
    const error = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) })
    const failure = await callService('svc GET /x', 'http://h/x?secret=1', {}, { ...base, fetch: answers(error, error, error), sleep: async () => {} }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(VoiceError)
    expect((failure as Error).message).toContain('ECONNREFUSED')
    expect((failure as Error).message).toContain('after 3 attempts')
    expect((failure as Error).message).not.toContain('secret')
  })

  it('fails a 4xx at once and clips the body', async () => {
    const fetchMock = answers(404)
    const failure = await callService('svc GET /x', 'http://h/x', {}, { ...base, fetch: fetchMock, sleep: async () => {} }).catch((e: unknown) => e)
    expect((failure as Error).message).toBe('svc GET /x answered HTTP 404: body 404')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('turns a deadline into a timeout reason', async () => {
    const hang: typeof fetch = (_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => { reject(new Error('aborted')) })
    })
    const failure = await callService('svc GET /x', 'http://h/x', {}, { timeoutMs: 20, retries: 0, retryDelayMs: 1, fetch: hang }).catch((e: unknown) => e)
    expect((failure as Error).message).toBe('svc GET /x timed out after 20 ms')
  })

  it('stops at once when the caller cancels', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchMock = answers(200)
    await expect(callService('svc GET /x', 'http://h/x', {}, { ...base, fetch: fetchMock, signal: controller.signal })).rejects.toThrow('was cancelled')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('clips a long error body to 160 characters and drops the status colon for an empty one', async () => {
    const long = vi.fn(async () => new Response(`${'x'.repeat(100)}\n  ${'y'.repeat(100)}`, { status: 400 }))
    const clipped = await callService('svc GET /x', 'http://h/x', {}, { ...base, fetch: long }).catch((e: unknown) => e)
    expect((clipped as Error).message).toBe(`svc GET /x answered HTTP 400: ${'x'.repeat(100)} ${'y'.repeat(59)}…`)
    const empty = vi.fn(async () => new Response(null, { status: 404 }))
    const bare = await callService('svc GET /x', 'http://h/x', {}, { ...base, fetch: empty }).catch((e: unknown) => e)
    expect((bare as Error).message).toBe('svc GET /x answered HTTP 404')
  })

  it('reports the status alone when the error body cannot be read', async () => {
    const broken = vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('reset')) } }), { status: 400 }))
    const failure = await callService('svc GET /x', 'http://h/x', {}, { ...base, fetch: broken }).catch((e: unknown) => e)
    expect((failure as Error).message).toBe('svc GET /x answered HTTP 400')
  })

  it('describes a plain error and a thrown non-Error without a code', async () => {
    const plain = await callService('svc GET /x', 'http://h/x', {}, { ...base, retries: 0, fetch: answers(new Error('boom')) }).catch((e: unknown) => e)
    expect((plain as Error).message).toBe('svc GET /x failed: boom')
    const thrown = vi.fn(async (): Promise<Response> => { throw 'weird' })
    const other = await callService('svc GET /x', 'http://h/x', {}, { ...base, retries: 0, fetch: thrown }).catch((e: unknown) => e)
    expect((other as Error).message).toBe('svc GET /x failed: weird')
  })

  it('reports a cancellation that arrives while the request is in flight, without retrying', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async (): Promise<Response> => { controller.abort(); throw new Error('aborted') })
    await expect(callService('svc GET /x', 'http://h/x', {}, { ...base, fetch: fetchMock, signal: controller.signal })).rejects.toThrow('svc GET /x was cancelled')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('makes no attempt and fails with an empty reason when retries is negative', async () => {
    const fetchMock = answers(200)
    const failure = await callService('svc GET /x', 'http://h/x', {}, { ...base, retries: -1, fetch: fetchMock }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(VoiceError)
    expect((failure as Error).message).toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sleeps with the real timer between attempts when no sleep is injected', async () => {
    const response = await callService('svc GET /x', 'http://h/x', {}, { timeoutMs: 1000, retries: 1, retryDelayMs: 1, fetch: answers(503, 200) })
    expect(await response.text()).toBe('ok')
  })
})
