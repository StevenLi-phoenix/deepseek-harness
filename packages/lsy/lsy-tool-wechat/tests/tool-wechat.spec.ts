import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as ToolWechat from '../src/index.ts'

const contexts: Context[] = []

async function mount(notifier: unknown) {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('systemPrompt', { tools: () => () => {} } as never)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  ctx.provide('lsyNotifier', notifier as never)
  await ctx.plugin(ToolWechat)
  const call = async (args: unknown) => (await ctx.tools.execute({ signal: new AbortController().signal, calls: [{ type: 'tool-call', id: ToolCallId('send-call'), name: 'wechat_send_file', arguments: JSON.stringify(args) }] })).results[0]!.result
  return { ctx, call }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('wechat_send_file', () => {
  it('passes the path to the channel and returns its outcome', async () => {
    const sendFile = vi.fn((path: string) => Promise.resolve(path.endsWith('.png') ? { sent: 'image', name: 'a.png', bytes: 3 } : { notSent: 'the owner has not written yet' }))
    const { ctx, call } = await mount({ send: vi.fn(), ownsSession: () => false, sendFile })
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('wechat_send_file')
    expect(await call({ path: '/Users/dsh-runtime/me/a.png' })).toMatchObject({ value: { sent: 'image', name: 'a.png', bytes: 3 } })
    expect(await call({ path: '/tmp/b.pdf' })).toMatchObject({ value: { notSent: 'the owner has not written yet' } })
    expect(sendFile.mock.calls).toEqual([['/Users/dsh-runtime/me/a.png'], ['/tmp/b.pdf']])
    expect(ctx.tools.get('wechat_send_file')!.presentCall!({ path: '/x/y/report.pdf' })).toEqual({ card: 'generic', title: 'Send report.pdf on WeChat', kind: 'other', rawInput: '/x/y/report.pdf' })
  })

  it('says so when the notifier is not the WeChat channel', async () => {
    const { call } = await mount({ send: vi.fn(), ownsSession: () => false })
    expect(await call({ path: '/tmp/a.png' })).toMatchObject({ value: { notSent: 'the WeChat channel is not mounted' } })
  })

  it('lets the registry refuse a call without a path', async () => {
    const sendFile = vi.fn()
    const { call } = await mount({ send: vi.fn(), ownsSession: () => false, sendFile })
    const result = await call({})
    expect(result).not.toHaveProperty('value')
    expect(sendFile).not.toHaveBeenCalled()
  })
})
