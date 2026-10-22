import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SOURCES, readSource, type BalanceSource } from '../src/sources.ts'

/** A fetch double answering by URL; records the headers each request carried. */
function server(answers: Record<string, { status?: number; body: unknown } | Error>) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const fetch = vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) })
    const answer = answers[url]
    if (answer === undefined) return Promise.resolve(new Response('not found', { status: 404 }))
    if (answer instanceof Error) return Promise.reject(answer)
    return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 }))
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}

const source = (kind: BalanceSource['kind']): BalanceSource => DEFAULT_SOURCES.find(entry => entry.kind === kind)!
const KEY = 'sk-test-secret'

afterEach(() => { vi.restoreAllMocks() })

describe('readSource', () => {
  it('reads DeepSeek API key wallets', async () => {
    const s = server({ 'https://api.deepseek.com/user/balance': { body: {
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '12.30', granted_balance: '2.30', topped_up_balance: '10.00' }],
    } } })
    expect(await readSource(source('deepseek'), KEY, { fetch: s.fetch, timeoutMs: 1000 })).toEqual({
      source: 'deepseek', label: 'DeepSeek API', status: 'ready', kind: 'wallets',
      wallets: [{ currency: 'CNY', total: '12.30', toppedUp: '10.00', granted: '2.30' }],
    })
    expect(s.calls[0]!.headers['authorization']).toBe(`Bearer ${KEY}`)
  })

  it('reads the OpenRouter key limit and usage', async () => {
    const s = server({ 'https://openrouter.ai/api/v1/key': { body: { data: { limit: 10, limit_remaining: 7.2049, usage: 2.7951 } } } })
    expect(await readSource(source('openrouter'), KEY, { fetch: s.fetch, timeoutMs: 1000 })).toEqual({
      source: 'openrouter', label: 'OpenRouter', status: 'ready', kind: 'credit', currency: 'USD', remaining: 7.2049, limit: 10, used: 2.7951,
    })
    const unlimited = server({ 'https://openrouter.ai/api/v1/key': { body: { data: { limit: null, limit_remaining: null, usage: 1.5 } } } })
    expect(await readSource(source('openrouter'), KEY, { fetch: unlimited.fetch, timeoutMs: 1000 }))
      .toMatchObject({ kind: 'credit', remaining: null, limit: null, used: 1.5 })
  })

  it('reads OpenCode Go quota windows', async () => {
    const s = server({ 'https://opencode.ai/inference/go/v1/usage': { body: { usage: {
      fiveHour: { status: 'ok', percent: 12, resetsAt: '2026-10-22T23:00:00Z' },
      weekly: { status: 'ok', percent: 34.5, resetsAt: '2026-10-26T00:00:00Z' },
    } } } })
    expect(await readSource(source('opencode-go'), KEY, { fetch: s.fetch, timeoutMs: 1000 })).toEqual({
      source: 'opencode-go', label: 'OpenCode Go', status: 'ready', kind: 'quota', windows: [
        { name: 'fiveHour', percent: 12, resetsAt: '2026-10-22T23:00:00Z' },
        { name: 'weekly', percent: 34.5, resetsAt: '2026-10-26T00:00:00Z' },
      ],
    })
    expect(s.calls[0]!.headers['x-api-key']).toBe(KEY)
  })

  it('turns HTTP, network, and shape failures into reasons without the key or URL', async () => {
    const s = server({
      'https://openrouter.ai/api/v1/key': { status: 401, body: { error: { message: `bad key ${KEY}` } } },
      'https://api.deepseek.com/user/balance': { body: { unexpected: true } },
      'https://opencode.ai/inference/go/v1/usage': new TypeError('fetch failed'),
    })
    const failed = await Promise.all((['openrouter', 'deepseek', 'opencode-go'] as const)
      .map(kind => readSource(source(kind), KEY, { fetch: s.fetch, timeoutMs: 1000 })))
    expect(failed.map(reading => reading.status === 'failed' ? reading.reason : undefined)).toEqual([
      'HTTP 401', 'unexpected response', 'request failed',
    ])
    expect(JSON.stringify(failed)).not.toContain(KEY)
  })
})
