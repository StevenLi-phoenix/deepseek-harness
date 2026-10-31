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
    const hang = ((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => { reject(new Error('aborted')) })
    })) as unknown as typeof fetch
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
})
