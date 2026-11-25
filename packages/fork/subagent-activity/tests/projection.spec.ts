import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionSeq, buildSessionHeader, type SessionEvent, type SessionEventMap } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import * as plugin from '../src/index.ts'
import { activityProjectionDefinition as unit, noteOf, previewOf, retryOf, shorten, type ActivityState } from '../src/projection.ts'

type Header = Parameters<typeof unit.init>[0]
const CHILD: Header = buildSessionHeader(SessionId('child'), { createdAt: 0, origin: 'subagent' })
const ROOT: Header = buildSessionHeader(SessionId('root'), { createdAt: 0 })

type CallId = SessionEventMap['tool/call']['callId']
type MessageId = SessionEventMap['tool/result']['message']['id']
// dsh-llm-retry and dsh-jobs declare these payloads; the Host aggregate program merges their event maps.
type RetryId = SessionEventMap['llm/retry-started']['retryId']
type JobId = SessionEventMap['job/registered']['jobId']
const callId = (id: string) => id as CallId
const messageId = (id: string) => id as MessageId
const RETRY = 'retry-1' as RetryId

/** A Session event before the log assigns its sequence number. */
type Unsequenced<E> = E extends SessionEvent ? Omit<E, 'seq'> : never

let seq = 0
function event(draft: Unsequenced<SessionEvent>): SessionEvent {
  return { ...draft, seq: SessionSeq(seq++) }
}

function fold(events: readonly SessionEvent[], header: Header = CHILD): ActivityState {
  let state: ActivityState = unit.init(header)
  for (const next of events) state = unit.apply(state, next)
  return state
}

const turnStart = (time: number) => event({ type: 'turn/start', time, data: { turn: 1 } })
const stepStart = (time: number, step = 1) => event({ type: 'step/start', time, data: { turn: 1, step } })
const turnEnd = (time: number, reason: SessionEventMap['turn/end']['reason']) => event({ type: 'turn/end', time, data: { turn: 1, reason } })
const said = (time: number, content: SessionEventMap['assistant/message']['message']['content']) => event({
  type: 'assistant/message', time, surfaceOp: 'append',
  data: { turn: 1, step: 1, message: { id: messageId(`assistant-${time}`), role: 'assistant', content, source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' } }, stream: [] },
})
const call = (time: number, id: string, name: string, args: unknown) =>
  event({ type: 'tool/call', time, data: { turn: 1, step: 1, callId: callId(id), name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } })
const result = (time: number, id: string, isError = false) => event({
  type: 'tool/result', time, surfaceOp: 'append',
  data: { turn: 1, step: 1, message: { id: messageId(`tool-${time}`), role: 'tool', toolCallId: callId(id), isError, content: [], source: { kind: 'tool', callId: callId(id) } } },
})
const retryStarted = (time: number) => event({ type: 'llm/retry-started', time, data: { retryId: RETRY, turn: 1, step: 1, retry: 1 } })

describe('subagentActivity', () => {
  it('stays null and returns the same state for a Session that is not a subagent', () => {
    const start = unit.init(ROOT)
    const next = unit.apply(start, turnStart(1))
    expect(next).toBe(start)
    expect(unit.wire.view(next)).toBeNull()
  })

  it('follows a turn: model, a running tool, back to the model, then idle with how it ended', () => {
    const events = [
      turnStart(1_000),
      stepStart(1_100),
    ]
    let state = fold(events)
    expect(state.view).toMatchObject({ phase: 'model', since: 1_100, step: 1, toolCalls: 0 })

    state = unit.apply(state, said(2_000, [{ type: 'reasoning', text: 'Read the uploader first.' }]))
    state = unit.apply(state, call(2_000, 'c1', 'bash', { command: 'grep -rn onBatchStored Sources', description: 'Find the batch hook' }))
    expect(state.view).toMatchObject({
      phase: 'tool', since: 2_000, at: 2_000, toolCalls: 1,
      tool: { name: 'bash', preview: 'Find the batch hook', open: 1 },
      note: { kind: 'thought', text: 'Read the uploader first.' },
    })

    state = unit.apply(state, result(2_500, 'c1', true))
    expect(state.view).toMatchObject({ phase: 'model', since: 2_500, lastTool: { name: 'bash', preview: 'Find the batch hook', error: true } })
    expect(state.view).not.toHaveProperty('tool')

    state = unit.apply(state, turnEnd(9_000, { kind: 'completed' }))
    expect(state.view).toMatchObject({ phase: 'idle', since: 9_000, ended: 'completed', toolCalls: 1 })
  })

  it('keeps the oldest of parallel calls in front and counts the rest', () => {
    const state = fold([
      stepStart(10, 2),
      call(20, 'a', 'read', { path: '/tmp/dt/a.swift' }),
      call(30, 'b', 'bash', { command: 'swift test' }),
    ])
    expect(state.view).toMatchObject({ phase: 'tool', since: 20, at: 30, tool: { name: 'read', open: 2 } })
    const after = unit.apply(state, result(40, 'a'))
    expect(after.view).toMatchObject({ phase: 'tool', since: 30, tool: { name: 'bash', preview: 'swift test', open: 1 }, lastTool: { name: 'read', error: false } })
  })

  it('shows a retry with its reason and returns to the model when the retry starts', () => {
    let state = fold([
      stepStart(10),
      event({
        type: 'llm/retry', time: 50,
        data: { retryId: RETRY, turn: 1, step: 1, provider: 'deepseek', mode: 'normal', policyKey: 'deepseek', retry: 1, maxRetries: 5, delayMs: 3_401, failure: { message: 'Stream ended without finish_reason', code: 'x' } },
      }),
    ])
    expect(state.view).toMatchObject({ phase: 'retry', since: 50, retry: { attempt: 1, max: 5, reason: 'Stream ended without finish_reason' } })
    state = unit.apply(state, retryStarted(3_500))
    expect(state.view).toMatchObject({ phase: 'model', since: 3_500 })
    expect(state.view).not.toHaveProperty('retry')
  })

  it('records the failure of a turn that ended with an error, and the end kind of an aborted one', () => {
    const failed = fold([
      turnStart(1),
      turnEnd(2, { kind: 'error', error: { message: 'UNKNOWN_MODEL opencode-go/x', code: 'UNKNOWN' } }),
    ])
    expect(failed.view).toMatchObject({ phase: 'idle', ended: 'error', error: 'UNKNOWN_MODEL opencode-go/x' })
    const aborted = fold([turnStart(1), turnEnd(2, { kind: 'aborted', reason: { kind: 'user' } })])
    expect(aborted.view).toMatchObject({ ended: 'aborted' })
    expect(aborted.view).not.toHaveProperty('error')
  })

  it('returns the same state for events it does not show, so the control stream stays quiet', () => {
    const state = fold([stepStart(10)])
    for (const quiet of [
      event({ type: 'job/registered', time: 11, data: { jobId: 'job-1' as JobId, owner: CHILD.id, kind: 'bash', label: 'swift test', startedAt: 11 } }),
      event({ type: 'request/header', time: 12, data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } }, reason: 'initial' } }),
      event({ type: 'step/end', time: 13, data: { turn: 1, step: 1 } }),
      said(14, []),
      result(15, 'unknown-call'),
    ]) expect(unit.apply(state, quiet)).toBe(state)
  })

  it('switches on at a descriptor for a log whose header predates the origin field', () => {
    const state = fold([event({ type: 'subagent/descriptor', time: 5, data: { version: 3, mode: 'one-shot', provider: 'subagent' } }), turnStart(6)], ROOT)
    expect(state.on).toBe(true)
    expect(state.view).toMatchObject({ phase: 'model', since: 6 })
  })

  it('reads a retry without its optional fields, and ignores a retry start outside a retry', () => {
    const state = fold([
      stepStart(10),
      event({
        type: 'llm/retry', time: 20,
        data: { retryId: RETRY, turn: 1, step: 1, provider: 'deepseek', mode: 'always', policyKey: 'deepseek', retry: 2, delayMs: 1_000, failure: { message: 'overloaded', code: 'x' } },
      }),
    ])
    expect(state.view).toMatchObject({ phase: 'retry', retry: { attempt: 2, reason: 'overloaded' } })
    expect(state.view?.retry).not.toHaveProperty('max')
    expect(retryOf({})).toEqual({ attempt: 0, reason: '' })
    expect(retryOf({ retry: '2', maxRetries: null, failure: {} })).toEqual({ attempt: 0, reason: '' })
    const model = fold([stepStart(10)])
    expect(unit.apply(model, retryStarted(30))).toBe(model)
  })

  it('validates its own state and view', () => {
    const state = fold([stepStart(1), call(2, 'c', 'bash', { command: 'ls' })])
    expect(unit.stateSchema.parse(state)).toEqual(state)
    expect(unit.wire.viewSchema.parse(state.view)).toEqual(state.view)
  })
})

describe('previews', () => {
  it('prefers a description, then the command, path, query, or url, then any string', () => {
    expect(previewOf(JSON.stringify({ command: 'ls -la', description: 'List files' }))).toBe('List files')
    expect(previewOf(JSON.stringify({ file_path: '/tmp/a.txt', limit: 20 }))).toBe('/tmp/a.txt')
    expect(previewOf(JSON.stringify({ other: 'x y' }))).toBe('x y')
    expect(previewOf(JSON.stringify({ n: 1 }))).toBe('')
    expect(previewOf('not json\n at all')).toBe('not json at all')
    for (const value of ['[1]', '"text"', 'null', '3']) expect(previewOf(value)).toBe('')
  })

  it('shortens to one line with an ellipsis', () => {
    expect(shorten('a\n  b', 10)).toBe('a b')
    expect(shorten('x'.repeat(30), 10)).toBe(`${'x'.repeat(9)}…`)
  })

  it('takes reply text over reasoning', () => {
    expect(noteOf([{ type: 'reasoning', text: 'hm' }, { type: 'text', text: '改好了' }])).toEqual({ kind: 'text', text: '改好了' })
    expect(noteOf([{ type: 'reasoning', text: 'hm' }])).toEqual({ kind: 'thought', text: 'hm' })
    expect(noteOf([{ type: 'image' }])).toBeUndefined()
    expect(noteOf([null, 'loose', { type: 'other', text: 'x' }, { type: 'text', text: '  ' }, { type: 'thinking', text: 'deep' }]))
      .toEqual({ kind: 'thought', text: 'deep' })
  })
})

describe('plugin', () => {
  it('registers the projection and logs it', async () => {
    const ctx = new Context()
    const register = vi.fn(async () => ({ stateOf: () => undefined, dispose: async () => {} }))
    ctx.provide('sessionProjections', { register } as never)
    const info = vi.fn()
    ctx.provide('logger', Object.assign(() => ({ info }), { info, debug: vi.fn(), warn: vi.fn() }) as never)
    await ctx.plugin(plugin)
    await vi.waitFor(() => { expect(register).toHaveBeenCalledWith(unit) })
  })
})
