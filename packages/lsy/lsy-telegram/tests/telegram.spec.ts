import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TelegramNotifier, { type Config } from '../src/index.ts'

const TOKEN = '123456:secret-token'

const baseConfig: Config = {
  botTokenEnv: 'LSY_TELEGRAM_BOT_TOKEN',
  chatId: '-1001',
  apiBase: 'https://api.telegram.test',
  timeoutMs: 5_000,
  maxRetryAfterSeconds: 30,
}

interface Call { url: string; body: Record<string, unknown> }

const contexts: Context[] = []

async function harness(responses: Array<() => Response>, options: { token?: string | undefined; config?: Partial<Config> } = {}) {
  const calls: Call[] = []
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(init?.body as string) as Record<string, unknown> })
    const next = responses.shift()
    if (next === undefined) throw new Error('unexpected fetch')
    return next()
  })
  vi.stubGlobal('fetch', fetchMock)
  const ctx = new Context()
  contexts.push(ctx)
  const token = 'token' in options ? options.token : TOKEN
  const resolve = vi.fn(async () => token === undefined ? undefined : { value: token, source: 'env' })
  ctx.provide('credentials', { resolve } as never)
  await ctx.plugin(TelegramNotifier, Object.assign({}, baseConfig, options.config))
  return { notifier: ctx.lsyNotifier, calls, resolve }
}

function ok(): Response {
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('TelegramNotifier', () => {
  it('sends the title, body, and link as one plain-text message to the configured chat', async () => {
    const { notifier, calls, resolve } = await harness([ok])
    await notifier.send({ title: 'releases: 1 event(s)', body: '• octo/repo v1', url: 'https://dsh.example/' })
    expect(resolve).toHaveBeenCalledWith('LSY_TELEGRAM_BOT_TOKEN')
    expect(calls).toEqual([{
      url: `https://api.telegram.test/bot${TOKEN}/sendMessage`,
      body: {
        chat_id: '-1001',
        text: 'releases: 1 event(s)\n\n• octo/repo v1\n\nhttps://dsh.example/',
        link_preview_options: { is_disabled: true },
      },
    }])
  })

  it('sends a title-only message', async () => {
    const { notifier, calls } = await harness([ok])
    await notifier.send({ title: 'ping' })
    expect(calls[0]!.body['text']).toBe('ping')
  })

  it('clips messages to the Telegram limit', async () => {
    const { notifier, calls } = await harness([ok])
    await notifier.send({ title: 't', body: 'x'.repeat(5000) })
    expect(String(calls[0]!.body['text']).length).toBe(4096)
  })

  it('fails with the credential name when the token is not configured', async () => {
    const { notifier, calls } = await harness([ok], { token: undefined })
    await expect(notifier.send({ title: 't' })).rejects.toThrow('Telegram bot token LSY_TELEGRAM_BOT_TOKEN is not configured')
    expect(calls).toHaveLength(0)
  })

  it('reports the Telegram error description without the token', async () => {
    const { notifier } = await harness([() => new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), { status: 400 })])
    const error = await notifier.send({ title: 't' }).catch((caught: unknown) => caught)
    expect(String(error)).toContain('Telegram sendMessage failed: HTTP 400 Bad Request: chat not found')
    expect(String(error)).not.toContain('secret-token')
  })

  it('reports non-JSON and non-object error bodies by status', async () => {
    const { notifier } = await harness([
      () => new Response('<html>bad gateway</html>', { status: 502 }),
      () => new Response('null', { status: 500 }),
    ])
    await expect(notifier.send({ title: 't' })).rejects.toThrow('Telegram sendMessage failed: HTTP 502 (no description)')
    await expect(notifier.send({ title: 't' })).rejects.toThrow('Telegram sendMessage failed: HTTP 500 (no description)')
  })

  it('retries once after a short retry_after and gives up on long ones', async () => {
    const limited = (seconds: number) => () => new Response(JSON.stringify({ ok: false, description: 'Too Many Requests', parameters: { retry_after: seconds } }), { status: 429 })
    const first = await harness([limited(3), ok])
    const sent = first.notifier.send({ title: 't' })
    await vi.advanceTimersByTimeAsync(3_000)
    await sent
    expect(first.calls).toHaveLength(2)

    const second = await harness([limited(120)])
    await expect(second.notifier.send({ title: 't' })).rejects.toThrow('HTTP 429 Too Many Requests')
    expect(second.calls).toHaveLength(1)
  })

  it('does not retry twice', async () => {
    const limited = () => new Response(JSON.stringify({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 1 } }), { status: 429 })
    const { notifier, calls } = await harness([limited, limited])
    const sent = notifier.send({ title: 't' }).catch((caught: unknown) => caught)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(String(await sent)).toContain('HTTP 429')
    expect(calls).toHaveLength(2)
  })

  it('rejects an empty chat id and an invalid credential name at load', () => {
    expect(() => new TelegramNotifier(new Context(), Object.assign({}, baseConfig, { chatId: ' ' }))).toThrow('chatId')
    expect(() => new TelegramNotifier(new Context(), Object.assign({}, baseConfig, { botTokenEnv: 'not a name' }))).toThrow()
  })
})
