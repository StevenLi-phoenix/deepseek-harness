/**
 * `owner_push`: the agent pushes an urgent message to the owner's phone, or queues one line for the daily email
 * digest, through the API platform's message bus (`MessageBus`). The bus already turns a message into a phone push
 * (Bark, through its notification service) and keeps the daily digest; this tool only chooses the priority, names
 * the matter with a caller-scoped idempotency key so a later run that finds the same matter pushes nothing new,
 * and reports what the bus answered. WeChat stays the channel for reports; a push is for what is lost within hours.
 *
 * @module @deepseek-ai/dsh-tool-push
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
// Type-only: ctx.credentials.
import type {} from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { BusError, MessageBus, type BusPost } from './bus.ts'

export { BusError, MessageBus } from './bus.ts'
export type * from './bus.ts'

/** Plugin name. */
export const name = 'tool-push'

/** Mounted inside an agent preset's scope, like other tool plugins. */
export const inject = ['tools', 'credentials']

/** Plugin configuration. */
export interface Config {
  /** Platform base, without a trailing slash. */
  apiBase: string
  /** Name of the PAT that may post to the message bus. */
  tokenEnv: string
  /** `source` of every message. */
  source: string
  /** Bus channel the messages are kept in. */
  channel: string
  /** Priority of a push. */
  pushPriority: number
  /** Timeout of one post, in milliseconds. */
  requestTimeoutMs: number
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  apiBase: z.string().default('https://api.lishuyu.app').description('API platform base, without a trailing slash.'),
  tokenEnv: z.string().default('MESSAGE_PAT').description('Name of the PAT that may post to the message bus, in the credential store or $DSH_HOME/.env.'),
  source: z.string().default('dsh').description('`source` of every message (1-24 characters).'),
  channel: z.string().default('dsh').description('Bus channel the messages are kept in; never `display`, which the bus does not push.'),
  pushPriority: z.natural().min(1).max(9).default(6)
    .description('Priority of a push. The bus pushes at or above its notify threshold (5); 7 or more also takes over the e-ink display and emails.'),
  requestTimeoutMs: z.natural().min(1000).default(15_000).description('Timeout of one post, in milliseconds.'),
})

/** A matter's name: lowercase words joined by hyphens, dots or underscores. */
const KEY = /^[a-z0-9][a-z0-9._-]{0,99}$/u

/** Longest message the bus keeps, in code points. */
const MAX_TEXT = 500

const DESCRIPTION = [
  'Push one message to the owner\'s phone now, through the API platform\'s message bus, for something that is lost if the owner does not act within hours:',
  'an interview time to confirm today, a deadline that falls today, a run that cannot go on without the owner.',
  'Anything that can wait belongs in your WeChat report, or set digest for one line in the next daily email digest; a deadline a day or more away is not urgent.',
  'key names the matter (for example eight-sleep-assessment-deadline), and the bus takes one message per key, so a later run that finds the same matter sends nothing new.',
  'The result says whether the bus took it, its message id, and whether it went out as a push or a digest line.',
].join(' ')

const OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        posted: { type: 'boolean', required: true },
        id: { type: 'number', required: true },
        as: { type: 'string', required: true, enum: ['push', 'digest'] },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: { notPosted: { type: 'string', required: true } },
    },
  ],
} as const

/** What the model reads. */
export type PushOutput = { posted: true; id: number; as: 'push' | 'digest' } | { notPosted: string }

/** What one call asks for. */
interface PushArgs {
  readonly text: string
  readonly key: string
  readonly digest?: boolean
}

/**
 * Check the arguments and build the bus message.
 * @param args - the model's arguments.
 * @param config - source, channel and push priority.
 * @returns the message, or why nothing is posted.
 */
export function pushMessage(args: PushArgs, config: Pick<Config, 'source' | 'channel' | 'pushPriority'>): BusPost | { notPosted: string } {
  const text = args.text.trim()
  if (text === '') return { notPosted: 'text is empty' }
  if (Array.from(text).length > MAX_TEXT) return { notPosted: `text is longer than ${String(MAX_TEXT)} characters; say it shorter` }
  const key = args.key.trim()
  if (!KEY.test(key)) return { notPosted: 'key must be lowercase letters, digits, dots, hyphens or underscores, at most 100 characters, for example eight-sleep-assessment-deadline' }
  const base = { source: config.source, text, channel: config.channel, idempotency_key: `owner-push:${key}` }
  return args.digest === true
    ? { ...base, priority: 0, digest: true, digest_key: key }
    : { ...base, priority: config.pushPriority }
}

/**
 * What a failed post tells the model.
 * @param error - the bus error.
 * @param key - the matter's name.
 * @returns one sentence, with what to do instead.
 */
function failureText(error: BusError, key: string): string {
  if (error.failure === 'duplicate') return `the bus already took a message for key ${key}; nothing new was sent, so do not send it again`
  if (error.failure === 'not-configured' || error.failure === 'auth') return `${error.message}; tell the owner in your WeChat report instead`
  return `${error.message}; tell the owner in your WeChat report instead, and do not retry in a loop`
}

/**
 * Register `owner_push`.
 * @param ctx - the preset scope's context.
 * @param config - platform, credential, and message settings.
 */
export function apply(ctx: Context, config: Config): void {
  if (!/^https?:\/\/\S+[^/]$/u.test(config.apiBase)) throw new Error('tool-push: apiBase must be an http(s) URL without a trailing slash')
  if (config.channel === 'display') throw new Error('tool-push: channel "display" is never pushed by the bus')
  const ref = credentialRef(config.tokenEnv)
  const bus = new MessageBus({
    apiBase: config.apiBase,
    timeoutMs: config.requestTimeoutMs,
    token: async () => (await ctx.credentials.resolve(ref))?.value,
  })
  ctx.tools.register(defineTool({
    name: 'owner_push',
    description: DESCRIPTION,
    parameters: {
      text: { type: 'string', required: true, description: 'What the owner must know and do, in one or two sentences of plain text, at most 500 characters.' },
      key: { type: 'string', required: true, description: 'A stable name for the matter, lowercase words joined by hyphens; use the same key for the same matter.' },
      digest: { type: 'boolean', description: 'true puts one line in the next daily email digest instead of pushing now.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
    async execute(args, exec): Promise<PushOutput> {
      const message = pushMessage(args, config)
      if ('notPosted' in message) return message
      const as = message.digest === true ? 'digest' : 'push'
      try {
        const { id } = await bus.post(message, exec.signal)
        ctx.logger.info(`tool-push: the bus took message ${String(id)} as a ${as}, key ${args.key}, ${String(Array.from(message.text).length)} chars`)
        return { posted: true, id, as }
      } catch (error: unknown) {
        if (!(error instanceof BusError)) throw error
        ctx.logger.warn(`tool-push: ${as} for key ${args.key} not posted (${error.failure}): ${error.message}`)
        return { notPosted: failureText(error, args.key) }
      }
    },
    presentCall: args => ({ card: 'generic', title: args.digest === true ? 'Add a line to the owner\'s digest' : 'Push to the owner\'s phone', kind: 'other', rawInput: args.text }),
  }))
}
