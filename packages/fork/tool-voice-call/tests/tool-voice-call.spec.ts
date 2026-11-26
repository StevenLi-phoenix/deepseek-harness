import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import type { CallView, RingResult } from '@deepseek-ai/dsh-voice-call'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as ToolVoiceCall from '../src/index.ts'

const contexts: Context[] = []

async function mount(voiceCall: unknown, config: Partial<ToolVoiceCall.Config> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const logs: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push(`${message.type}: ${String(message.args[0])}`) } })
  ctx.provide('systemPrompt', { tools: () => () => {} } as never)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  if (voiceCall !== undefined) ctx.provide('voiceCall', voiceCall as never)
  await ctx.plugin(ToolVoiceCall, ToolVoiceCall.Config(config))
  const call = async (args: unknown) => (await ctx.tools.execute({ signal: new AbortController().signal, calls: [{ type: 'tool-call', id: ToolCallId('call-owner'), name: 'call_owner', arguments: JSON.stringify(args) }] })).results[0]!.result
  return { ctx, call, logs }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

const view: CallView = {
  callId: '0f9e8d7c-6b5a-4938-8271-605f4e3d2c1b' as CallView['callId'],
  initiator: 'agent',
  state: 'ended',
  reason: '磁盘满了',
  createdAt: 1_000,
  answeredAt: 5_000,
  endedAt: 65_400,
  outcome: 'completed',
}

const ended = (overrides: Partial<CallView> = {}, transcript: Array<{ role: 'owner' | 'agent'; text: string }> = []): RingResult => ({
  status: 'ended',
  call: { ...view, ...overrides },
  detail: 'the owner hung up',
  transcript: transcript.map((line, index) => ({ ...line, at: index })),
})

describe('callOutput', () => {
  it('reports a refusal', () => {
    expect(ToolVoiceCall.callOutput({ status: 'refused', reason: 'no phone is registered' }, 10)).toEqual({ refused: 'no phone is registered' })
  })

  it('reports the outcome, duration, and newest transcript lines', () => {
    const lines = [{ role: 'agent', text: '一' }, { role: 'owner', text: '二' }, { role: 'agent', text: '三' }] as const
    expect(ToolVoiceCall.callOutput(ended({}, [...lines]), 2)).toEqual({
      outcome: 'completed',
      detail: 'the owner hung up',
      durationS: 60,
      transcript: [{ role: 'owner', text: '二' }, { role: 'agent', text: '三' }],
      omittedLines: 1,
    })
  })

  it('reports an unanswered call as zero seconds, and a call without an outcome as failed', () => {
    const missed: RingResult = { ...ended({ answeredAt: null, outcome: 'missed' }), detail: null }
    expect(ToolVoiceCall.callOutput(missed, 5)).toEqual({ outcome: 'missed', durationS: 0, transcript: [] })
    expect(ToolVoiceCall.callOutput(ended({ endedAt: null, outcome: null }), 5)).toMatchObject({ outcome: 'failed', durationS: 0 })
  })
})

describe('call_owner', () => {
  it('rings with the reason and urgency and returns how the call went', async () => {
    const ring = vi.fn(async (_request: unknown, _signal?: AbortSignal) => ended({}, [{ role: 'agent', text: '主人，磁盘满了。' }, { role: 'owner', text: '清理吧' }]))
    const { ctx, call, logs } = await mount({ ring })
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('call_owner')
    expect(await call({ reason: '磁盘满了，要不要清理？', urgent: true })).toMatchObject({
      value: { outcome: 'completed', durationS: 60, transcript: [{ role: 'agent', text: '主人，磁盘满了。' }, { role: 'owner', text: '清理吧' }] },
    })
    expect(ring.mock.calls[0]![0]).toEqual({ reason: '磁盘满了，要不要清理？', urgent: true })
    expect(ring.mock.calls[0]![1]).toBeInstanceOf(AbortSignal)
    expect(logs).toContain('info: tool-voice-call: completed after 60s, 2 line(s)')
    // What was said stays out of the log.
    expect(logs.filter(line => line.includes('清理'))).toEqual([])
  })

  it('returns a refusal, and calls without urgency by default', async () => {
    const ring = vi.fn(async () => ({ status: 'refused', reason: 'the owner is asleep' }) satisfies RingResult)
    const { call, logs } = await mount({ ring }, { maxTranscriptLines: 5 })
    expect(await call({ reason: '提醒' })).toMatchObject({ value: { refused: 'the owner is asleep' } })
    expect(ring).toHaveBeenCalledWith({ reason: '提醒', urgent: false }, expect.any(AbortSignal))
    expect(logs).toContain('info: tool-voice-call: refused: the owner is asleep')
  })

  it('presents the call with its urgency', async () => {
    const { ctx } = await mount({ ring: vi.fn() })
    const tool = ctx.tools.get('call_owner')!
    expect(tool.presentCall!({ reason: '提醒', urgent: true })).toEqual({ card: 'generic', title: 'Call the owner (urgent)', kind: 'other', rawInput: '提醒' })
    expect(tool.presentCall!({ reason: '提醒' })).toMatchObject({ title: 'Call the owner' })
  })

  it('is absent while no voice-call service is mounted', async () => {
    const { ctx } = await mount(undefined)
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('call_owner')
  })
})
