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
const GATEWAY_QUOTA = 'https://api.lishuyu.app/llm/api/upstream/opencode-go/quota'

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

  it('reads the OpenCode Go quota windows and the gateway key limit through llmgateway', async () => {
    const s = server({ [GATEWAY_QUOTA]: { body: {
      provider: 'opencode-go',
      usage: {
        rolling: { status: 'ok', percent: 12, resetsAt: '2026-10-22T23:00:00Z' },
        weekly: { status: 'ok', percent: 34.5, resetsAt: '2026-10-26T00:00:00Z' },
      },
      key: { id: 'k_1', name: 'dsh', limit_usd: 2, period: { kind: 'daily', seconds: null }, spend_usd: 0.1234, remaining_usd: 1.8766, reserved_usd: 0.1, available_usd: 1.7766 },
    } } })
    expect(await readSource(source('opencode-go'), KEY, { fetch: s.fetch, timeoutMs: 1000 })).toEqual({
      source: 'opencode-go', label: 'OpenCode Go', status: 'ready', kind: 'quota', windows: [
        { name: 'rolling', percent: 12, resetsAt: '2026-10-22T23:00:00Z' },
        { name: 'weekly', percent: 34.5, resetsAt: '2026-10-26T00:00:00Z' },
      ],
      key: { period: 'daily', limitUsd: 2, spendUsd: 0.1234, remainingUsd: 1.8766 },
    })
    // Only the gateway key travels, and only as a Bearer token.
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0]!.headers['authorization']).toBe(`Bearer ${KEY}`)
    expect(s.calls[0]!.headers['x-api-key']).toBeUndefined()
  })

  it('keeps the quota windows when the gateway sends no key block, or a key without a limit', async () => {
    const windows = { rolling: { status: 'ok', percent: 5, resetsAt: '2026-10-31T07:52:27.000Z' } }
    const bare = server({ [GATEWAY_QUOTA]: { body: { usage: windows } } })
    const reading = await readSource(source('opencode-go'), KEY, { fetch: bare.fetch, timeoutMs: 1000 })
    expect(reading).toMatchObject({ status: 'ready', kind: 'quota' })
    expect(reading).not.toHaveProperty('key')
    const unlimited = server({ [GATEWAY_QUOTA]: { body: { usage: windows, key: { limit_usd: null, period: { kind: 'total' }, spend_usd: 3, remaining_usd: null } } } })
    expect(await readSource(source('opencode-go'), KEY, { fetch: unlimited.fetch, timeoutMs: 1000 }))
      .toMatchObject({ key: { period: 'total', limitUsd: null, spendUsd: 3, remainingUsd: null } })
  })

  it('treats a malformed key block as an unexpected response', async () => {
    const s = server({ [GATEWAY_QUOTA]: { body: { usage: {}, key: { limit_usd: 'two', spend_usd: 0 } } } })
    expect(await readSource(source('opencode-go'), KEY, { fetch: s.fetch, timeoutMs: 1000 })).toMatchObject({ status: 'failed', reason: 'unexpected response' })
  })

  it('queries DeepSeek and the gateway by default, with the gateway key', () => {
    expect(DEFAULT_SOURCES.map(entry => [entry.kind, entry.keyRef])).toEqual([['deepseek', 'DEEPSEEK_API_KEY'], ['opencode-go', 'LLMGW_DSH_API_KEY']])
  })

  it('turns HTTP, network, and shape failures into reasons without the key or URL', async () => {
    const s = server({
      'https://api.deepseek.com/user/balance': { body: { unexpected: true } },
      [GATEWAY_QUOTA]: new TypeError('fetch failed'),
    })
    const unauthorized = server({ [GATEWAY_QUOTA]: { status: 401, body: { error: { message: `bad key ${KEY}` } } } })
    const failed = await Promise.all([
      readSource(source('deepseek'), KEY, { fetch: s.fetch, timeoutMs: 1000 }),
      readSource(source('opencode-go'), KEY, { fetch: s.fetch, timeoutMs: 1000 }),
      readSource(source('opencode-go'), KEY, { fetch: unauthorized.fetch, timeoutMs: 1000 }),
    ])
    expect(failed.map(reading => reading.status === 'failed' ? reading.reason : undefined)).toEqual([
      'unexpected response', 'request failed', 'HTTP 401',
    ])
    expect(JSON.stringify(failed)).not.toContain(KEY)
  })
})
