/**
 * `wechat_send_file`: the agent sends a local file to the owner on WeChat. The
 * recipient, the reply window, and every check live in the WeChat channel
 * (`WechatChannel.sendFile`); the tool only passes the path and returns what
 * happened, so nothing here depends on what the model writes in its answer.
 *
 * `defer_deliver`: the agent holds a text for the owner until a time or until the owner
 * wakes (`WechatChannel.holdDelivery`); the channel keeps the text and sends it.
 */

import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.lsyNotifier service the channel provides.
import type {} from '@deepseek-ai/dsh-lsy-event-bus'
import type { HoldResult, SendFileResult, WechatChannel } from '@deepseek-ai/dsh-lsy-wechat'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Plugin name. */
export const name = 'lsy-tool-wechat'

/** Mounted inside an agent preset's scope, like other tool plugins. */
export const inject = ['tools']

const DESCRIPTION = [
  'Send a file from this computer to the owner on WeChat.',
  'A PNG, JPEG, GIF, or WebP image arrives as a picture, an .mp4, .mov, or .m4v file as a video, anything else as a file attachment.',
  'The recipient is always the owner, and sending works only while the owner\'s last WeChat message is recent (about a day) and its reply allowance is not used up; otherwise the result says why nothing was sent.',
  'Use it when the owner asks for a file or picture, or when one says more than text. Your final answer still goes out as the text reply.',
].join(' ')

const OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        sent: { type: 'string', required: true, enum: ['image', 'video', 'file'] },
        name: { type: 'string', required: true },
        bytes: { type: 'number', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: { notSent: { type: 'string', required: true } },
    },
  ],
} as const

const DEFER_DESCRIPTION = [
  'Hold a text for the owner on WeChat instead of sending it now, and let it arrive later.',
  'It goes out at the time you give in until (ISO 8601 with a UTC offset, for example 2026-11-03T09:00:00-05:00, at most 7 days ahead),',
  'or as soon as the owner wakes if that comes first; with no until the owner has to be asleep now, and the text waits for the waking.',
  'Use it for something the owner should read later rather than now: a night-time finding, a result for the morning, a message for a set time.',
  'Do not repeat the text in your final answer; if this was all you had to say, answer exactly NO_REPLY.',
  'Sending then needs an open WeChat reply window; a text it cannot reach waits in the outbox for the owner\'s next message.',
].join(' ')

const DEFER_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        held: { type: 'number', required: true },
        until: { type: 'string' },
        wakes: { type: 'boolean', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: { notHeld: { type: 'string', required: true } },
    },
  ],
} as const

/** An instant with its UTC offset; a time without one would be read in the Host's zone, which the model cannot see. */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u

/** The model-facing form of a hold: the time as ISO text. */
type DeferOutput = { held: number; until?: string; wakes: boolean } | { notHeld: string }

/**
 * Parse the `until` argument.
 * @param until - ISO 8601 text with a UTC offset, or undefined.
 * @returns the epoch milliseconds, `undefined` for no time, or a refusal.
 */
function parseUntil(until: string | undefined): number | undefined | { notHeld: string } {
  if (until === undefined || until === '') return undefined
  const at = ISO_WITH_OFFSET.test(until) ? Date.parse(until) : Number.NaN
  return Number.isNaN(at) ? { notHeld: 'until is not an ISO 8601 time with a UTC offset, for example 2026-11-03T09:00:00-05:00' } : at
}

/** Turn the channel's result into what the model reads. */
function deferOutput(result: HoldResult): DeferOutput {
  if ('notHeld' in result) return result
  return { held: result.held, ...result.until === undefined ? {} : { until: new Date(result.until).toISOString() }, wakes: result.wakes }
}

/**
 * Register `wechat_send_file` and `defer_deliver` once the WeChat channel is mounted.
 * @param ctx - the preset scope's context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['lsyNotifier'], (scoped) => {
    const channel = scoped.lsyNotifier as Partial<Pick<WechatChannel, 'sendFile' | 'holdDelivery'>>
    scoped.tools.register(defineTool({
      name: 'wechat_send_file',
      description: DESCRIPTION,
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute path of a regular file on this computer, at most 25 MiB.' },
      },
      output: { schema: OUTPUT_SCHEMA, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
      async execute(args): Promise<SendFileResult> {
        if (typeof channel.sendFile !== 'function') return { notSent: 'the WeChat channel is not mounted' }
        return await channel.sendFile(args.path)
      },
      presentCall: args => ({ card: 'generic', title: `Send ${basename(args.path)} on WeChat`, kind: 'other', rawInput: args.path }),
    }))
    scoped.tools.register(defineTool({
      name: 'defer_deliver',
      description: DEFER_DESCRIPTION,
      parameters: {
        text: { type: 'string', required: true, description: 'What to tell the owner, as you would write it in a message.' },
        until: { type: 'string', description: 'When to send it: ISO 8601 with a UTC offset, at most 7 days ahead. Leave it out to wait for the owner to wake.' },
      },
      output: { schema: DEFER_OUTPUT_SCHEMA, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
      async execute(args): Promise<DeferOutput> {
        if (typeof channel.holdDelivery !== 'function') return { notHeld: 'the WeChat channel is not mounted' }
        const until = parseUntil(args.until)
        if (typeof until === 'object') return until
        return deferOutput(await channel.holdDelivery(args.text, until))
      },
      presentCall: args => ({ card: 'generic', title: 'Hold a message for the owner', kind: 'other', rawInput: args.text }),
    }))
  })
}
