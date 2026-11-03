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
  ctx.provide('forkNotifier', notifier as never)
  await ctx.plugin(ToolWechat)
  const run = async (name: string, args: unknown) => (await ctx.tools.execute({ signal: new AbortController().signal, calls: [{ type: 'tool-call', id: ToolCallId('send-call'), name, arguments: JSON.stringify(args) }] })).results[0]!.result
  const call = (args: unknown) => run('wechat_send_file', args)
  const defer = (args: unknown) => run('defer_deliver', args)
  return { ctx, call, defer }
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

describe('defer_deliver', () => {
  const UNTIL = '2026-11-03T09:00:00-05:00'

  it('passes the text and the parsed time to the channel and gives the held time back as ISO text', async () => {
    const holdDelivery = vi.fn((_text: string, until?: number) => (
      Promise.resolve({ held: 1, ...until === undefined ? {} : { until }, wakes: false })
    ))
    const { ctx, defer } = await mount({ send: vi.fn(), ownsSession: () => false, holdDelivery })
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('defer_deliver')
    expect(await defer({ text: 'good morning', until: UNTIL })).toMatchObject({ value: { held: 1, until: '2026-11-03T14:00:00.000Z', wakes: false } })
    expect(holdDelivery).toHaveBeenCalledWith('good morning', Date.parse(UNTIL))
    expect(ctx.tools.get('defer_deliver')!.presentCall!({ text: 'good morning' })).toEqual({
      card: 'generic', title: 'Hold a message for the owner', kind: 'other', rawInput: 'good morning',
    })
  })

  it('holds until the owner wakes when no time is given', async () => {
    const holdDelivery = vi.fn(() => Promise.resolve({ held: 1, wakes: true }))
    const { defer } = await mount({ send: vi.fn(), ownsSession: () => false, holdDelivery })
    expect(await defer({ text: 'later' })).toMatchObject({ value: { held: 1, wakes: true } })
    expect(holdDelivery).toHaveBeenCalledWith('later', undefined)
  })

  it('returns the channel\'s reason when it holds nothing', async () => {
    const holdDelivery = vi.fn(() => Promise.resolve({ notHeld: 'the owner is awake: put the text in your answer, or give a time with until' }))
    const { defer } = await mount({ send: vi.fn(), ownsSession: () => false, holdDelivery })
    expect(JSON.stringify(await defer({ text: 'now' }))).toContain('the owner is awake')
  })

  it('refuses a time that is not ISO 8601 with a UTC offset, before the channel hears of it', async () => {
    const holdDelivery = vi.fn()
    const { defer } = await mount({ send: vi.fn(), ownsSession: () => false, holdDelivery })
    for (const until of ['tomorrow 9am', '2026-11-03T09:00:00', '2026-13-45T25:00:00Z']) {
      expect(JSON.stringify(await defer({ text: 'x', until })), until).toContain('ISO 8601')
    }
    expect(holdDelivery).not.toHaveBeenCalled()
  })

  it('says so when the notifier is not the WeChat channel, and lets the registry refuse a call without text', async () => {
    const { defer } = await mount({ send: vi.fn(), ownsSession: () => false })
    expect(await defer({ text: 'x' })).toMatchObject({ value: { notHeld: 'the WeChat channel is not mounted' } })
    const refused = await defer({})
    expect(refused).not.toHaveProperty('value')
  })
})
