/**
 * The `forkSubagentActivity` projection unit: a pure fold of one subagent Session's own events into
 * what it is doing now (model, tool, retry, idle), since when, its newest words, and how its latest
 * turn ended. Ordinary Sessions keep the `null` view, so their summaries carry nothing.
 *
 * Only events that change what the panel shows produce a new view; the rest (job bookkeeping,
 * request headers, injected context) return the same state reference, so the control stream stays
 * quiet between steps.
 *
 * @module @deepseek-ai/dsh-fork-subagents/projection
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { ACTIVITY_KEY, NOTE_CHARS, PREVIEW_CHARS, type ActivityTool, type ForkSubagentActivity } from './activity.ts'

/** One dispatched call still waiting for its result. */
interface OpenCall extends ActivityTool {
  /** Dispatch time, in ms. */
  readonly at: number
}

/** Fold state: whether this Session is a subagent, its current view, and the calls still running. */
export interface ActivityState {
  /** A subagent Session (header `origin: 'subagent'`, or a descriptor seen). */
  readonly on: boolean
  /** The wire value; the same reference while nothing visible changed. */
  readonly view: ForkSubagentActivity | null
  /** Running calls by callId, in dispatch order. */
  readonly open: Readonly<Record<string, OpenCall>>
}

const toolSchema = z.object({ name: z.string(), preview: z.string() })

/** Wire boundary of the view. */
export const activitySchema = z.object({
  phase: z.enum(['model', 'tool', 'retry', 'idle']),
  since: z.number().nonnegative(),
  at: z.number().nonnegative(),
  step: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  tool: toolSchema.extend({ open: z.number().int().positive() }).optional(),
  retry: z.object({
    attempt: z.number().int().nonnegative(),
    max: z.number().int().nonnegative().optional(),
    reason: z.string(),
  }).optional(),
  lastTool: toolSchema.extend({ error: z.boolean() }).optional(),
  note: z.object({ kind: z.enum(['text', 'thought']), text: z.string() }).optional(),
  ended: z.string().optional(),
  error: z.string().optional(),
}).strict() as unknown as z.ZodType<ForkSubagentActivity>

const stateSchema = z.object({
  on: z.boolean(),
  view: activitySchema.nullable(),
  open: z.record(z.string(), toolSchema.extend({ at: z.number().nonnegative() })),
}) as unknown as z.ZodType<ActivityState>

/** Argument fields worth showing, most telling first. */
const PREVIEW_FIELDS = ['description', 'command', 'cmd', 'file_path', 'filePath', 'path', 'query', 'url', 'pattern', 'prompt', 'task', 'name'] as const

/**
 * Collapse whitespace and cut to `limit` characters with an ellipsis.
 * @param text - any text.
 * @param limit - character budget.
 * @returns one line of at most `limit` characters.
 */
export function shorten(text: string, limit: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= limit ? line : `${line.slice(0, limit - 1).trimEnd()}…`
}

/**
 * One line that tells what a tool call does, from its raw arguments.
 * @param raw - the call's JSON argument string, exactly as the model wrote it.
 * @returns the first telling string field (or the raw text when it is not a JSON object), shortened; `''` when none.
 */
export function previewOf(raw: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return shorten(raw, PREVIEW_CHARS)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return ''
  const record = parsed as Record<string, unknown>
  for (const field of PREVIEW_FIELDS) {
    const value = record[field]
    if (typeof value === 'string' && value.trim() !== '') return shorten(value, PREVIEW_CHARS)
  }
  for (const value of Object.values(record)) {
    if (typeof value === 'string' && value.trim() !== '') return shorten(value, PREVIEW_CHARS)
  }
  return ''
}

/**
 * The newest words of an assembled assistant message: its reply text, else the start of its reasoning.
 * @param content - the message's blocks.
 * @returns the note, or undefined for a message with neither.
 */
export function noteOf(content: readonly unknown[]): ForkSubagentActivity['note'] {
  const texts: string[] = []
  const thoughts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const { type, text } = block as { type?: unknown; text?: unknown }
    if (typeof text !== 'string' || text.trim() === '') continue
    if (type === 'text') texts.push(text)
    else if (type === 'reasoning' || type === 'thinking') thoughts.push(text)
  }
  if (texts.length > 0) return { kind: 'text', text: shorten(texts.join(' '), NOTE_CHARS) }
  if (thoughts.length > 0) return { kind: 'thought', text: shorten(thoughts.join(' '), NOTE_CHARS) }
  return undefined
}

/** A view without the optional fields a new phase clears. */
function base(view: ForkSubagentActivity, phase: ForkSubagentActivity['phase'], time: number): ForkSubagentActivity {
  const { tool: _tool, retry: _retry, ended: _ended, error: _error, ...rest } = view
  return { ...rest, phase, since: time, at: time }
}

/** The oldest running call, with the count still open. */
function oldest(open: ActivityState['open']): { call: OpenCall; count: number } | undefined {
  const calls = Object.values(open)
  const first = calls[0]
  return first === undefined ? undefined : { call: first, count: calls.length }
}

/** The empty view of a subagent that has not started a turn. */
function initial(time: number): ForkSubagentActivity {
  return { phase: 'idle', since: time, at: time, step: 0, toolCalls: 0 }
}

/**
 * Fold one event into a subagent's state.
 * @param state - the state covering all prior events.
 * @param event - the next committed event.
 * @returns the next state; the same reference when nothing the panel shows changed.
 */
function apply(state: ActivityState, event: SessionEvent): ActivityState {
  if (!state.on) {
    // The descriptor type belongs to dsh-subagent, which the Host half does not import.
    if ((event.type as string) !== 'subagent/descriptor') return state
    return { on: true, view: initial(event.time), open: {} }
  }
  const view = state.view ?? initial(event.time)
  const time = event.time
  // Events the upstream loop owns but this package does not import types for.
  const type = event.type as string
  if (type === 'llm/retry') {
    const data = event.data as { retry?: unknown; maxRetries?: unknown; failure?: { message?: unknown } }
    const attempt = typeof data.retry === 'number' ? data.retry : 0
    const reason = typeof data.failure?.message === 'string' ? shorten(data.failure.message, PREVIEW_CHARS) : ''
    return {
      ...state,
      view: {
        ...base(view, 'retry', time),
        retry: { attempt, reason, ...typeof data.maxRetries === 'number' ? { max: data.maxRetries } : {} },
      },
    }
  }
  if (type === 'llm/retry-started') {
    return view.phase === 'retry' ? { ...state, view: base(view, 'model', time) } : state
  }
  switch (event.type) {
    case 'turn/start':
      return { ...state, open: {}, view: base(view, 'model', time) }
    case 'step/start':
      return { ...state, open: {}, view: { ...base(view, 'model', time), step: event.data.step } }
    case 'assistant/message': {
      const note = noteOf(event.data.message.content)
      return note === undefined ? state : { ...state, view: { ...view, note, at: time } }
    }
    case 'tool/call': {
      const call: OpenCall = { name: event.data.name, preview: previewOf(event.data.arguments), at: time }
      const open = { ...state.open, [event.data.callId]: call }
      // Open calls keep their insertion order, so an older one still running stays in front.
      const first = Object.values(state.open)[0] ?? call
      return {
        ...state,
        open,
        view: {
          ...base(view, 'tool', first.at),
          at: time,
          toolCalls: view.toolCalls + 1,
          tool: { name: first.name, preview: first.preview, open: Object.keys(open).length },
        },
      }
    }
    case 'tool/result': {
      const callId = event.data.message.toolCallId
      const done = Object.hasOwn(state.open, callId) ? state.open[callId] : undefined
      if (done === undefined) return state
      const open = Object.fromEntries(Object.entries(state.open).filter(([id]) => id !== callId))
      const lastTool = { name: done.name, preview: done.preview, error: event.data.message.isError === true }
      const next = oldest(open)
      return {
        ...state,
        open,
        view: next === undefined
          ? { ...base(view, 'model', time), lastTool }
          : {
            ...base(view, 'tool', next.call.at),
            at: time,
            lastTool,
            tool: { name: next.call.name, preview: next.call.preview, open: next.count },
          },
      }
    }
    case 'turn/end': {
      const { reason } = event.data
      const failure = reason.kind === 'error' ? (reason as { error?: { message?: unknown } }).error?.message : undefined
      return {
        ...state,
        open: {},
        view: {
          ...base(view, 'idle', time),
          ended: reason.kind,
          ...typeof failure === 'string' ? { error: shorten(failure, PREVIEW_CHARS) } : {},
        },
      }
    }
    default:
      return state
  }
}

/** The unit registered on `ctx.sessionProjections` (exported for the unit spec). */
export const activityProjectionDefinition = {
  key: ACTIVITY_KEY,
  stateVersion: 1,
  stateSchema,
  init: (header): ActivityState => ({ on: header.origin === 'subagent', view: null, open: {} }),
  apply,
  wire: {
    viewSchema: activitySchema.nullable(),
    view: state => state.view,
  },
} satisfies ProjectionDefinition<typeof ACTIVITY_KEY, ActivityState>
