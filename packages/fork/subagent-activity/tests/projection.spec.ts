import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as plugin from '../src/index.ts'
import { activityProjectionDefinition as unit, noteOf, previewOf, shorten, type ActivityState } from '../src/projection.ts'

type Header = Parameters<typeof unit.init>[0]
const CHILD = { origin: 'subagent' } as unknown as Header
const ROOT = {} as unknown as Header

let seq = 0
function event(type: string, time: number, data: unknown): SessionEvent {
  return { type, seq: seq++, time, data } as unknown as SessionEvent
}

function fold(events: readonly SessionEvent[], header: Header = CHILD): ActivityState {
  let state: ActivityState = unit.init(header)
  for (const next of events) state = unit.apply(state, next)
  return state
}

const call = (time: number, callId: string, name: string, args: unknown) =>
  event('tool/call', time, { turn: 1, step: 1, callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) })
const result = (time: number, callId: string, isError = false) =>
  event('tool/result', time, { turn: 1, step: 1, message: { role: 'tool', toolCallId: callId, isError, content: [], source: { kind: 'tool', callId } } })

describe('subagentActivity', () => {
  it('stays null and returns the same state for a Session that is not a subagent', () => {
    const start = unit.init(ROOT)
    const next = unit.apply(start, event('turn/start', 1, { turn: 1 }))
    expect(next).toBe(start)
    expect(unit.wire.view(next)).toBeNull()
  })

  it('follows a turn: model, a running tool, back to the model, then idle with how it ended', () => {
    const events = [
      event('turn/start', 1_000, { turn: 1 }),
      event('step/start', 1_100, { turn: 1, step: 1 }),
    ]
    let state = fold(events)
    expect(state.view).toMatchObject({ phase: 'model', since: 1_100, step: 1, toolCalls: 0 })

    state = unit.apply(state, event('assistant/message', 2_000, { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: 'Read the uploader first.' }] } }))
    state = unit.apply(state, call(2_000, 'c1', 'bash', { command: 'grep -rn onBatchStored Sources', description: 'Find the batch hook' }))
    expect(state.view).toMatchObject({
      phase: 'tool', since: 2_000, at: 2_000, toolCalls: 1,
      tool: { name: 'bash', preview: 'Find the batch hook', open: 1 },
      note: { kind: 'thought', text: 'Read the uploader first.' },
    })

    state = unit.apply(state, result(2_500, 'c1', true))
    expect(state.view).toMatchObject({ phase: 'model', since: 2_500, lastTool: { name: 'bash', preview: 'Find the batch hook', error: true } })
    expect(state.view).not.toHaveProperty('tool')

    state = unit.apply(state, event('turn/end', 9_000, { turn: 1, reason: { kind: 'completed' } }))
    expect(state.view).toMatchObject({ phase: 'idle', since: 9_000, ended: 'completed', toolCalls: 1 })
  })

  it('keeps the oldest of parallel calls in front and counts the rest', () => {
    const state = fold([
      event('step/start', 10, { turn: 1, step: 2 }),
      call(20, 'a', 'read', { path: '/tmp/dt/a.swift' }),
      call(30, 'b', 'bash', { command: 'swift test' }),
    ])
    expect(state.view).toMatchObject({ phase: 'tool', since: 20, at: 30, tool: { name: 'read', open: 2 } })
    const after = unit.apply(state, result(40, 'a'))
    expect(after.view).toMatchObject({ phase: 'tool', since: 30, tool: { name: 'bash', preview: 'swift test', open: 1 }, lastTool: { name: 'read', error: false } })
  })

  it('shows a retry with its reason and returns to the model when the retry starts', () => {
    let state = fold([
      event('step/start', 10, { turn: 1, step: 1 }),
      event('llm/retry', 50, { turn: 1, step: 1, retry: 1, maxRetries: 5, delayMs: 3_401, failure: { message: 'Stream ended without finish_reason', code: 'x' } }),
    ])
    expect(state.view).toMatchObject({ phase: 'retry', since: 50, retry: { attempt: 1, max: 5, reason: 'Stream ended without finish_reason' } })
    state = unit.apply(state, event('llm/retry-started', 3_500, { turn: 1, step: 1, retry: 1 }))
    expect(state.view).toMatchObject({ phase: 'model', since: 3_500 })
    expect(state.view).not.toHaveProperty('retry')
  })

  it('records the failure of a turn that ended with an error, and the end kind of an aborted one', () => {
    const failed = fold([
      event('turn/start', 1, { turn: 1 }),
      event('turn/end', 2, { turn: 1, reason: { kind: 'error', error: { message: 'UNKNOWN_MODEL opencode-go/x', code: 'UNKNOWN' } } }),
    ])
    expect(failed.view).toMatchObject({ phase: 'idle', ended: 'error', error: 'UNKNOWN_MODEL opencode-go/x' })
    const aborted = fold([event('turn/start', 1, { turn: 1 }), event('turn/end', 2, { turn: 1, reason: { kind: 'aborted', reason: {} } })])
    expect(aborted.view).toMatchObject({ ended: 'aborted' })
    expect(aborted.view).not.toHaveProperty('error')
  })

  it('returns the same state for events it does not show, so the control stream stays quiet', () => {
    const state = fold([event('step/start', 10, { turn: 1, step: 1 })])
    for (const quiet of [
      event('job/registered', 11, {}),
      event('request/header', 12, {}),
      event('step/end', 13, { turn: 1, step: 1 }),
      event('assistant/message', 14, { turn: 1, step: 1, message: { content: [] } }),
      result(15, 'unknown-call'),
    ]) expect(unit.apply(state, quiet)).toBe(state)
  })

  it('switches on at a descriptor for a log whose header predates the origin field', () => {
    const state = fold([event('subagent/descriptor', 5, { version: 3 }), event('turn/start', 6, { turn: 1 })], ROOT)
    expect(state.on).toBe(true)
    expect(state.view).toMatchObject({ phase: 'model', since: 6 })
  })

  it('reads a retry without its optional fields, and ignores a retry start outside a retry', () => {
    const state = fold([event('step/start', 10, { turn: 1, step: 1 }), event('llm/retry', 20, { turn: 1, step: 1 })])
    expect(state.view).toMatchObject({ phase: 'retry', retry: { attempt: 0, reason: '' } })
    expect(state.view?.retry).not.toHaveProperty('max')
    const model = fold([event('step/start', 10, { turn: 1, step: 1 })])
    expect(unit.apply(model, event('llm/retry-started', 30, { turn: 1, step: 1, retry: 1 }))).toBe(model)
    const failed = fold([event('turn/start', 1, { turn: 1 }), event('turn/end', 2, { turn: 1, reason: { kind: 'error' } })])
    expect(failed.view).toMatchObject({ ended: 'error' })
    expect(failed.view).not.toHaveProperty('error')
  })

  it('validates its own state and view', () => {
    const state = fold([event('step/start', 1, { turn: 1, step: 1 }), call(2, 'c', 'bash', { command: 'ls' })])
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
