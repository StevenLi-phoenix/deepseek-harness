import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as ToolVoice from '../src/index.ts'

const contexts: Context[] = []

interface Options {
  voice?: unknown
  notifier?: unknown
}

async function mount({ voice, notifier }: Options) {
  const ctx = new Context()
  contexts.push(ctx)
  const logs: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push(`${message.type}: ${String(message.args[0])}`) } })
  ctx.provide('systemPrompt', { tools: () => () => {} } as never)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  if (voice !== undefined) ctx.provide('lsyVoice', voice as never)
  if (notifier !== undefined) ctx.provide('lsyNotifier', notifier as never)
  await ctx.plugin(ToolVoice)
  const call = async (args: unknown) => (await ctx.tools.execute({ signal: new AbortController().signal, calls: [{ type: 'tool-call', id: ToolCallId('speak-call'), name: 'speak', arguments: JSON.stringify(args) }] })).results[0]!.result
  return { ctx, call, logs }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

const spoken = { path: '/data/lsy-voice/audio/a.mp3', format: 'mp3', bytes: 1234, provider: 'feiyu', elapsedMs: 800 }

describe('speak', () => {
  it('synthesizes, sends the file to the owner, and reports both', async () => {
    const speak = vi.fn(async (_text: string, _options?: unknown) => spoken)
    const sendFile = vi.fn(async () => ({ sent: 'file', name: 'a.mp3', bytes: 1234 }))
    const { ctx, call, logs } = await mount({ voice: { ttsEnabled: true, speak }, notifier: { send: vi.fn(), sendFile } })
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('speak')
    expect(await call({ text: '魔女大人，巡逻完毕。' })).toMatchObject({ value: { path: spoken.path, format: 'mp3', bytes: 1234, provider: 'feiyu', sent: 'file' } })
    expect(speak.mock.calls[0]![0]).toBe('魔女大人，巡逻完毕。')
    expect(sendFile.mock.calls).toEqual([[spoken.path]])
    expect(logs.some(line => line.startsWith('info: lsy-tool-voice: spoke 10 chars'))).toBe(true)
  })

  it('keeps the file and says why when the channel cannot send it', async () => {
    const { call } = await mount({
      voice: { ttsEnabled: true, speak: async () => spoken },
      notifier: { send: vi.fn(), sendFile: async () => ({ notSent: 'reply window expired' }) },
    })
    expect(await call({ text: '你好' })).toMatchObject({ value: { path: spoken.path, notSent: 'reply window expired' } })
  })

  it('only writes the file when send is false', async () => {
    const sendFile = vi.fn()
    const { call } = await mount({ voice: { ttsEnabled: true, speak: async () => spoken }, notifier: { send: vi.fn(), sendFile } })
    const result = await call({ text: '你好', send: false })
    expect(result).toMatchObject({ value: { path: spoken.path } })
    expect(result).not.toHaveProperty('value.sent')
    expect(sendFile).not.toHaveBeenCalled()
  })

  it('says so when the notifier cannot send files', async () => {
    const { call } = await mount({ voice: { ttsEnabled: true, speak: async () => spoken }, notifier: { send: vi.fn() } })
    expect(await call({ text: '你好' })).toMatchObject({ value: { path: spoken.path, notSent: 'the WeChat channel is not mounted' } })
  })

  it('returns the voice error to the model', async () => {
    const { call, logs } = await mount({ voice: { ttsEnabled: true, speak: async () => { throw new Error('speech failed (feiyu: down)') } }, notifier: { send: vi.fn(), sendFile: vi.fn() } })
    expect(await call({ text: '你好' })).toMatchObject({ value: { error: 'speech failed (feiyu: down)' } })
    expect(logs.some(line => line.startsWith('warn: lsy-tool-voice: speak failed'))).toBe(true)
  })

  it('tells the model when speech is off', async () => {
    const speak = vi.fn()
    const { call } = await mount({ voice: { ttsEnabled: false, speak }, notifier: { send: vi.fn(), sendFile: vi.fn() } })
    expect(await call({ text: '你好' })).toMatchObject({ value: { error: expect.stringContaining('turned off') as unknown } })
    expect(speak).not.toHaveBeenCalled()
  })

  it('registers nothing until the voice service is mounted', async () => {
    const { ctx } = await mount({})
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('speak')
  })

  it('lets the registry refuse a call without text', async () => {
    const speak = vi.fn()
    const { call } = await mount({ voice: { ttsEnabled: true, speak }, notifier: { send: vi.fn() } })
    expect(await call({})).not.toHaveProperty('value')
    expect(speak).not.toHaveBeenCalled()
  })
})
