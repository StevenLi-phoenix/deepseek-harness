/**
 * `owner_push` over a stubbed message bus: what one push and one digest line post, the key that dedupes a matter,
 * the arguments it refuses, and what each bus failure tells the model. The token never reaches the result or a log.
 */

import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as ToolPush from '../src/index.ts'
import { MessageBus } from '../src/bus.ts'

const contexts: Context[] = []
const TOKEN = 'pat_test_secret_value'

interface Answer {
  readonly status: number
  readonly body?: unknown
}

async function mount(answer: Answer | (() => never), token: string | null = TOKEN) {
  const ctx = new Context()
  contexts.push(ctx)
  const logs: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push(`${message.type}: ${String(message.args[0])}`) } })
  ctx.provide('systemPrompt', { tools: () => () => {} } as never)
  ctx.provide('credentials', { resolve: async () => (token === null ? undefined : { value: token }) } as never)
  const posted: { url: string; headers: Record<string, string>; body: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    posted.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) })
    if (typeof answer === 'function') answer()
    const { status, body } = answer as Answer
    return new Response(body === undefined ? 'not json' : JSON.stringify(body), { status })
  }))
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(ToolPush, { apiBase: 'https://api.example.test', tokenEnv: 'MESSAGE_PAT', source: 'dsh', channel: 'dsh', pushPriority: 6, requestTimeoutMs: 5000 })
  const call = async (args: unknown) => (await ctx.tools.execute({
    signal: new AbortController().signal,
    calls: [{ type: 'tool-call', id: ToolCallId('push-call'), name: 'owner_push', arguments: JSON.stringify(args) }],
  })).results[0]!.result
  return { ctx, call, logs, posted }
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('owner_push', () => {
  it('posts a push above the notify threshold under a caller-scoped key, and says the bus took it', async () => {
    const { ctx, call, logs, posted } = await mount({ status: 200, body: { id: 42 } })
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('owner_push')
    expect(await call({ text: '  魔女大人，今天 17:00 前要确认 Acme 的面试时间。 ', key: 'acme-interview-confirm', digest: false }))
      .toMatchObject({ value: { posted: true, id: 42, as: 'push' } })
    expect(posted).toHaveLength(1)
    expect(posted[0]!.url).toBe('https://api.example.test/v2/call/messageservice/post')
    expect(posted[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(posted[0]!.body).toEqual({
      source: 'dsh', text: '魔女大人，今天 17:00 前要确认 Acme 的面试时间。', channel: 'dsh', priority: 6, idempotency_key: 'owner-push:acme-interview-confirm',
    })
    expect(logs).toContain('info: tool-push: the bus took message 42 as a push, key acme-interview-confirm, 30 chars')
    expect(logs.join('\n')).not.toContain(TOKEN)
  })

  it('queues a digest line at priority 0, collapsed by the same key', async () => {
    const { call, posted } = await mount({ status: 200, body: { id: 7 } })
    expect(await call({ text: 'Eight Sleep 测评 11/28 12:53 ET 截止。', key: 'eight-sleep-assessment-deadline', digest: true }))
      .toMatchObject({ value: { posted: true, id: 7, as: 'digest' } })
    expect(posted[0]!.body).toMatchObject({ priority: 0, digest: true, digest_key: 'eight-sleep-assessment-deadline', idempotency_key: 'owner-push:eight-sleep-assessment-deadline' })
  })

  it('tells the model a key the bus already took was not sent again', async () => {
    const { call } = await mount({ status: 409, body: { error: 'idempotency_conflict' } })
    expect(await call({ text: 'still due', key: 'acme-interview-confirm' })).toMatchObject({
      value: { notPosted: 'the bus already took a message for key acme-interview-confirm; nothing new was sent, so do not send it again' },
    })
  })

  it.each([
    [{ status: 403, body: { error: 'forbidden' } }, 'the message bus refused the token (HTTP 403 forbidden); tell the owner in your WeChat report instead'],
    [{ status: 502, body: { error: 'upstream' } }, 'the message bus answered HTTP 502 upstream; tell the owner in your WeChat report instead, and do not retry in a loop'],
    [{ status: 200, body: { ok: true } }, 'the message bus answered without a message id; tell the owner in your WeChat report instead, and do not retry in a loop'],
  ])('reports a bus answer of %j without the token', async (answer, said) => {
    const { call, logs } = await mount(answer)
    expect(await call({ text: 'x', key: 'k' })).toMatchObject({ value: { notPosted: said } })
    expect(logs.some(line => line.startsWith('warn: tool-push: push for key k not posted'))).toBe(true)
    expect(logs.join('\n')).not.toContain(TOKEN)
  })

  it('posts nothing without a token, for an empty or long text, or a key that is not a slug', async () => {
    const missing = await mount({ status: 200, body: { id: 1 } }, null)
    expect(await missing.call({ text: 'x', key: 'k' })).toMatchObject({ value: { notPosted: 'the message bus token is not set; tell the owner in your WeChat report instead' } })
    expect(missing.posted).toHaveLength(0)
    const { call, posted } = await mount({ status: 200, body: { id: 1 } })
    expect(await call({ text: '   ', key: 'k' })).toMatchObject({ value: { notPosted: 'text is empty' } })
    expect(await call({ text: '字'.repeat(501), key: 'k' })).toMatchObject({ value: { notPosted: 'text is longer than 500 characters; say it shorter' } })
    const badKey = await call({ text: 'x', key: 'Acme Interview' }) as { value: { notPosted: string } }
    expect(badKey.value.notPosted).toMatch(/^key must be lowercase/u)
    expect(posted).toHaveLength(0)
  })

  it('refuses a configuration the bus would not push', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    expect(() => { ToolPush.apply(ctx, { apiBase: 'https://api.example.test', tokenEnv: 'T', source: 'dsh', channel: 'display', pushPriority: 6, requestTimeoutMs: 5000 }) })
      .toThrow('tool-push: channel "display" is never pushed by the bus')
    expect(() => { ToolPush.apply(ctx, { apiBase: 'https://api.example.test/', tokenEnv: 'T', source: 'dsh', channel: 'dsh', pushPriority: 6, requestTimeoutMs: 5000 }) })
      .toThrow('tool-push: apiBase must be an http(s) URL without a trailing slash')
  })
})

describe('the message bus client', () => {
  it('names a network failure and a timeout', async () => {
    const down = new MessageBus({ apiBase: 'https://api.example.test', timeoutMs: 1000, token: async () => TOKEN, fetch: async () => { throw new Error('ECONNREFUSED') } })
    await expect(down.post({ source: 'dsh', text: 'x', channel: 'dsh', priority: 6, idempotency_key: 'owner-push:k' }))
      .rejects.toMatchObject({ failure: 'network', message: 'the message bus could not be reached (ECONNREFUSED)' })
    const slow = new MessageBus({
      apiBase: 'https://api.example.test',
      timeoutMs: 1000,
      token: async () => TOKEN,
      fetch: async (_url, init) => await new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }) }),
    })
    await expect(slow.post({ source: 'dsh', text: 'x', channel: 'dsh', priority: 6, idempotency_key: 'owner-push:k' }))
      .rejects.toMatchObject({ failure: 'timeout', message: 'the message bus did not answer within 1000 ms' })
  })
})
