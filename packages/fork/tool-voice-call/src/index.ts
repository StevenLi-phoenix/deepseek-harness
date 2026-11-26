/**
 * `call_owner`: the agent phones the owner. `ctx.voiceCall` rings the owner's iPhone through the
 * DSH Call app; a separate call Session talks with the owner, and the tool returns once the call
 * ended, with how it went and what was said.
 */

import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type { RingResult, TranscriptLine, VoiceCall } from '@deepseek-ai/dsh-voice-call'

/** Plugin name. */
export const name = 'tool-voice-call'

/** Mounted inside an agent preset's scope, like other tool plugins. */
export const inject = ['tools']

/** Configuration. */
export interface Config {
  /** Transcript lines returned to the agent, newest kept. */
  maxTranscriptLines: number
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  maxTranscriptLines: z.natural().min(1).default(60),
})

const DESCRIPTION = [
  'Phone the owner: their iPhone rings like a normal call, and when they pick up, a separate call agent talks with them by voice. The tool returns after the call ends, with the outcome and the transcript.',
  'Call only when a voice conversation is clearly better than a message: something urgent the owner must hear now, or a decision that needs a quick back-and-forth. For anything else send a message instead; a call interrupts the owner.',
  'The call agent knows nothing but `reason`, so write in it everything the call has to cover: the facts, what you need from the owner, and the options. Write it in the language of the call (Chinese by default).',
  'Calls are limited per hour, and while the owner sleeps only `urgent` calls ring. A refused, missed, or declined call is not an answer: decide whether to send a message instead.',
].join(' ')

const LINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    role: { type: 'string', required: true, enum: ['owner', 'agent'] },
    text: { type: 'string', required: true },
  },
} as const

const OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        outcome: { type: 'string', required: true, enum: ['completed', 'declined', 'missed', 'failed', 'cancelled'] },
        detail: { type: 'string' },
        durationS: { type: 'number', required: true },
        transcript: { type: 'array', required: true, items: LINE_SCHEMA },
        omittedLines: { type: 'number' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: { refused: { type: 'string', required: true } },
    },
  ],
} as const

/** What the tool returns. */
export type CallOwnerOutput =
  | { outcome: 'completed' | 'declined' | 'missed' | 'failed' | 'cancelled'; detail?: string; durationS: number; transcript: Array<Pick<TranscriptLine, 'role' | 'text'>>; omittedLines?: number }
  | { refused: string }

/**
 * The tool output of a ring result.
 * @param result - what `ctx.voiceCall.ring` returned.
 * @param maxLines - transcript lines kept, newest last.
 * @returns the output the agent reads.
 */
export function callOutput(result: RingResult, maxLines: number): CallOwnerOutput {
  if (result.status === 'refused') return { refused: result.reason }
  const { call, detail, transcript } = result
  const durationS = call.answeredAt === null || call.endedAt === null ? 0 : Math.round((call.endedAt - call.answeredAt) / 1000)
  const kept = transcript.slice(-maxLines).map(line => ({ role: line.role, text: line.text }))
  return {
    outcome: call.outcome ?? 'failed',
    ...detail === null ? {} : { detail },
    durationS,
    transcript: kept,
    ...transcript.length > kept.length ? { omittedLines: transcript.length - kept.length } : {},
  }
}

/**
 * Register `call_owner` once the voice-call service is mounted.
 * @param ctx - the preset scope's context.
 * @param config - transcript limit.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['voiceCall'], (scoped) => {
    const voiceCall = scoped.voiceCall as Pick<VoiceCall, 'ring'>
    scoped.tools.register(defineTool({
      name: 'call_owner',
      description: DESCRIPTION,
      parameters: {
        reason: { type: 'string', required: true, description: 'Everything the call has to cover; the call agent sees nothing else. The first sentence is shown on the incoming-call screen.' },
        urgent: { type: 'boolean', description: 'It cannot wait: ring even while the owner sleeps. Default false.' },
      },
      output: { schema: OUTPUT_SCHEMA, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
      async execute(args, exec): Promise<CallOwnerOutput> {
        const result = await voiceCall.ring({ reason: args.reason, urgent: args.urgent === true }, exec.signal)
        const output = callOutput(result, config.maxTranscriptLines)
        scoped.logger.info(`tool-voice-call: ${'refused' in output ? `refused: ${output.refused}` : `${output.outcome} after ${output.durationS}s, ${output.transcript.length} line(s)`}`)
        return output
      },
      presentCall: args => ({ card: 'generic', title: `Call the owner${args.urgent === true ? ' (urgent)' : ''}`, kind: 'other', rawInput: args.reason }),
    }))
  })
}
