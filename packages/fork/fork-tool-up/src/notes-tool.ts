/**
 * The channel notes: the `bili_channel_note` tool, the guard every note passes, and the block that shows the notes to the
 * persistent Session as data. Notes are about the channel as a whole, never one viewer; only the persistent Session writes them.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
// Type-only: the `compaction/summary` Session event.
import type {} from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { guardOf, type GuardVerdict } from './guard.ts'
import { ChannelNotes, defaultNotesFile, renderNotesBlock, type NoteGate, type NoteOutcome } from './notes.ts'
import type { SessionGate } from './session-gate.ts'
import { assertNever, errorText, str } from './values.ts'

/** Source kind of the channel-notes block; declared in `MessageSourceMap` by the plugin entry. */
const SOURCE_KIND = 'fork-tool-up' as const

const JSON_SCHEMA = { type: 'json' } as const

/** The part of the configuration the notes read. */
export interface NotesConfig {
  callsPerTurn: number
  notes: { file?: string; maxEntries: number; maxChars: number }
}

/**
 * Register `bili_channel_note` and the hook that shows the notes to the persistent Session.
 * @param ctx - the preset scope's context.
 * @param config - the notes file, its limits, and the per-turn limit.
 * @param gate - who may write notes, and how often.
 */
export function mountNotes(ctx: Context, config: NotesConfig, gate: SessionGate): void {
  let warnedNoGuard = false
  /** The guard check of a note. Without fork-guard every note is refused (fail closed), warned once. */
  const guardGate = (sessionId: string): NoteGate => {
    const guard = guardOf(ctx)
    if (guard === undefined) {
      if (!warnedNoGuard) {
        warnedNoGuard = true
        ctx.logger.warn('fork-tool-up: no forkGuard service is mounted; channel notes are refused until it is')
      }
      return () => Promise.reject(new Error('no forkGuard service is mounted'))
    }
    return async (text) => {
      let verdict: GuardVerdict
      try {
        verdict = await guard.check(text, { purpose: 'bili-channel-note', audience: 'channel', sessionId })
      } catch (error: unknown) {
        ctx.logger.warn(`fork-tool-up: forkGuard failed on a channel note of Session ${sessionId}; the note is refused: ${errorText(error)}`)
        throw error
      }
      if (!verdict.ok) ctx.logger.info(`fork-tool-up: forkGuard refused a channel note of Session ${sessionId} (rule ${verdict.rule})`)
      return verdict.ok ? { ok: true } : { ok: false, publicReason: verdict.publicReason }
    }
  }

  const notes = new ChannelNotes(config.notes.file ?? defaultNotesFile(), {
    maxEntries: config.notes.maxEntries,
    maxChars: config.notes.maxChars,
  })

  ctx.tools.register(defineTool({
    name: 'bili_channel_note',
    description: [
      `Keep a short note about this Bilibili channel: its audience, the vibe of the comments, recurring topics and jokes (at most ${config.notes.maxEntries} notes of ${config.notes.maxChars} characters).`,
      'Notes are about the channel as a whole, never about one viewer: no names, nicknames, @handles, UIDs, contact details, schools, employers, or where someone lives; such a note is refused.',
      'op add stores the text; op remove deletes the note with that text (or id). Your notes are shown to you at the start of later turns as data.',
      `At most ${config.callsPerTurn} calls per turn, and only in the channel's persistent Session.`,
    ].join(' '),
    parameters: {
      op: { type: 'string', required: true, enum: ['add', 'remove'], description: 'add or remove.' },
      text: { type: 'string', required: true, description: `The note (add), or the note's text or id (remove); at most ${config.notes.maxChars} characters.` },
    },
    output: { schema: JSON_SCHEMA, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
    async execute(args, exec): Promise<JsonValue> {
      const sessionId = exec.agent?.session.id
      const refused = gate.refusal(sessionId)
      if (refused !== undefined || sessionId === undefined) {
        ctx.logger.info(`fork-tool-up: bili_channel_note refused in Session ${sessionId ?? '(none)'}: ${refused ?? 'no Session'}`)
        return { status: 'refused', reason: 'not_persistent_session', message: refused ?? 'no Session' }
      }
      if (!gate.take(sessionId, 'notes')) {
        ctx.logger.info(`fork-tool-up: bili_channel_note refused in Session ${sessionId}: ${config.callsPerTurn} calls this turn already`)
        return { status: 'refused', reason: 'turn_cap', message: `at most ${config.callsPerTurn} note calls per turn` }
      }
      let outcome: NoteOutcome
      const check = guardGate(sessionId)
      try {
        outcome = args.op === 'remove' ? await notes.remove(str(args.text)) : await notes.add(str(args.text), check)
      } catch (error: unknown) {
        ctx.logger.warn(`fork-tool-up: bili_channel_note ${str(args.op)} failed in Session ${sessionId}: ${errorText(error)}`)
        return { status: 'refused', reason: 'store_error', message: errorText(error) }
      }
      ctx.logger.info(`fork-tool-up: bili_channel_note ${str(args.op)} in Session ${sessionId}: ${outcome.status}${outcome.status === 'refused' ? ` (${outcome.reason}${'pii' in outcome ? `: ${outcome.pii}` : ''})` : ''}; ${outcome.count}/${config.notes.maxEntries} notes`)
      switch (outcome.status) {
        case 'added':
        case 'removed':
          return { status: outcome.status, id: outcome.note.id, count: outcome.count }
        case 'refused':
          return {
            status: 'refused',
            reason: outcome.reason,
            ...('pii' in outcome ? { pii: outcome.pii } : {}),
            // The guard's public reason only; the rule that fired stays in the host log.
            ...('publicReason' in outcome ? { message: outcome.publicReason } : {}),
            ...(outcome.reason === 'guard_unavailable' ? { message: 'the text guard is not available right now, so no note was kept; try again later' } : {}),
            count: outcome.count,
          }
        /* v8 ignore next 2 -- NoteOutcome is a closed union: its four statuses are handled above, so no input reaches the guard. */
        default:
          return assertNever(outcome)
      }
    },
    presentCall: args => ({ card: 'generic', title: `Channel note: ${str(args.op)}`, kind: 'other' }),
  }))

  /** Notes revision last shown to each Session; dropped when a compaction may have shadowed it. */
  const shown = new Map<string, number>()
  ctx.on('session/event', (session, event) => {
    if (event.type === 'compaction/summary') shown.delete(session.id)
  })
  // The notes reach the Session as data: at its first request, again after a compaction, and at the start of a turn once they changed.
  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted
      || agent.session.header.origin === 'subagent'
      || (step === 1 && decision.messages.length === 0)) return decision
    const sessionId = agent.session.id
    const last = shown.get(sessionId)
    if (last !== undefined && step !== 1) return decision
    let state: Awaited<ReturnType<ChannelNotes['read']>>
    try {
      state = await notes.read()
    } catch (error: unknown) {
      ctx.logger.warn(`fork-tool-up: channel notes not loaded for Session ${sessionId}: ${errorText(error)}`)
      return decision
    }
    if (last === state.rev) return decision
    shown.set(sessionId, state.rev)
    const text = renderNotesBlock(state.notes)
    if (text === undefined) return decision
    ctx.logger.info(`fork-tool-up: channel notes (${state.notes.length}, revision ${state.rev}) entered Session ${sessionId}`)
    const block = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: SOURCE_KIND, form: 'notice', summary: `${state.notes.length} channel note(s)` },
    })
    const lastClaimed = decision.messages.findLastIndex(message => messages.includes(message))
    return { ...decision, messages: decision.messages.toSpliced(lastClaimed + 1, 0, block) }
  })
}
