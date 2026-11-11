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
  const send = (args: unknown) => run('wechat_send', args)
  return { ctx, call, defer, send }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('wechat_send', () => {
  const tool = (extra: Record<string, unknown> = {}) => ({ send: vi.fn(), ownsSession: () => false, delivery: () => 'tool' as const, ...extra })

  it('is registered only while the channel delivers by tool', async () => {
    const text = await mount({ send: vi.fn(), ownsSession: () => false, delivery: () => 'text' })
    expect(text.ctx.tools.schemas().map(schema => schema.name)).not.toContain('wechat_send')
    const legacy = await mount({ send: vi.fn(), ownsSession: () => false })
    expect(legacy.ctx.tools.schemas().map(schema => schema.name)).not.toContain('wechat_send')
    const on = await mount(tool())
    expect(on.ctx.tools.schemas().map(schema => schema.name)).toContain('wechat_send')
  })

  it('passes the text, urgency and the calling Session to the channel and returns what became of it', async () => {
    const sendText = vi.fn((_session: string | undefined, _text: string, _options: { urgent?: boolean }) => Promise.resolve({ sent: 1, queued: 0, held: false, repliesLeft: 7 }))
    const { ctx, send } = await mount(tool({ sendText }))
    expect(await send({ text: 'on it', urgent: true })).toMatchObject({ value: { sent: 1, queued: 0, held: false, repliesLeft: 7 } })
    expect(sendText).toHaveBeenCalledWith(undefined, 'on it', { urgent: true })
    await send({ text: 'plain' })
    expect(sendText).toHaveBeenLastCalledWith(undefined, 'plain', { urgent: false })
    expect(ctx.tools.get('wechat_send')!.presentCall!({ text: 'on it' })).toEqual({
      card: 'generic', title: 'Message the owner on WeChat', kind: 'other', rawInput: 'on it',
    })
  })

  it('leaves out repliesLeft when the channel has no window record, and passes a queued text\'s reason on', async () => {
    const sendText = vi.fn(() => Promise.resolve({ sent: 0, queued: 1, held: false, why: 'the owner has not written yet', repliesLeft: null }))
    const { send } = await mount(tool({ sendText }))
    const result = await send({ text: 'hello' })
    expect(result).toMatchObject({ value: { sent: 0, queued: 1, held: false, why: 'the owner has not written yet' } })
    expect(JSON.stringify(result)).not.toContain('repliesLeft')
  })

  it('returns the channel\'s refusal, says so when the notifier is not the WeChat channel, and refuses a call without text', async () => {
    const sendText = vi.fn(() => Promise.resolve({ notSent: 'this turn already sent 3 messages (the cap is 3): put what is left into one message in your next turn' }))
    const capped = await mount(tool({ sendText }))
    expect(JSON.stringify(await capped.send({ text: 'x' }))).toContain('the cap is 3')
    const bare = await mount(tool())
    expect(await bare.send({ text: 'x' })).toMatchObject({ value: { notSent: 'the WeChat channel is not mounted' } })
    const refused = await capped.send({})
    expect(refused).not.toHaveProperty('value')
  })

  it('moves the "final answer" wording of the other tools to wechat_send', async () => {
    const text = await mount({ send: vi.fn(), ownsSession: () => false, delivery: () => 'text' })
    const on = await mount(tool())
    const describe_ = (h: Awaited<ReturnType<typeof mount>>, name: string) => h.ctx.tools.schemas().find(schema => schema.name === name)!.description
    expect(describe_(text, 'wechat_send_file')).toContain('final answer')
    expect(describe_(on, 'wechat_send_file')).toContain('wechat_send')
    expect(describe_(on, 'wechat_send_file')).not.toContain('final answer')
    expect(describe_(text, 'defer_deliver')).toContain('final answer')
    expect(describe_(on, 'defer_deliver')).not.toContain('final answer')
  })
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
