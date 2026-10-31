/**
 * `speak`: the agent says something out loud. The text goes through `ctx.lsyVoice` to an audio
 * file; by default the file is then sent to the owner over the notifier channel (WeChat), which
 * enforces the recipient and the reply window itself. WeChat bots cannot send voice bubbles, so the
 * owner receives an audio file attachment.
 */

import { Context } from '@deepseek-ai/cordis'
// Type-only: ctx.lsyNotifier and ctx.lsyVoice.
import type {} from '@deepseek-ai/dsh-lsy-event-bus'
import type {} from '@deepseek-ai/dsh-lsy-voice'
import type { LsyVoice } from '@deepseek-ai/dsh-lsy-voice'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Plugin name. */
export const name = 'lsy-tool-voice'

/** Mounted inside an agent preset's scope, like other tool plugins. */
export const inject = ['tools']

/** What a notifier that can send files offers (the WeChat channel). */
interface FileSender {
  sendFile?: (path: string) => Promise<{ sent: 'image' | 'video' | 'file' } | { notSent: string }>
}

const DESCRIPTION = [
  'Say something out loud: turns the text into speech and, by default, sends the audio to the owner on WeChat as an audio file (WeChat does not let a bot send voice bubbles, so it arrives as an mp3 attachment the owner taps to play).',
  'Use it when the owner asks you to speak, read something aloud, or when a spoken note is warmer than text; keep the text short and natural to say (a sentence or two, within the configured limit of 200 characters by default; a longer text is refused, so split it) because synthesis takes tens of seconds.',
  'Write numbers, units, and symbols the way they are spoken. Sending works only while the owner\'s last WeChat message is recent; otherwise the file is still saved and the result says why it was not sent.',
  'Your final answer still goes out as the text reply.',
].join(' ')

const OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', required: true },
        format: { type: 'string', required: true, enum: ['mp3', 'wav'] },
        bytes: { type: 'number', required: true },
        provider: { type: 'string', required: true },
        sent: { type: 'string', enum: ['image', 'video', 'file'] },
        notSent: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: { error: { type: 'string', required: true } },
    },
  ],
} as const

type SpeakOutput =
  | { path: string; format: 'mp3' | 'wav'; bytes: number; provider: string; sent?: 'image' | 'video' | 'file'; notSent?: string }
  | { error: string }

/** Human-readable error text. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Register `speak` once the voice service is mounted.
 * @param ctx - the preset scope's context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['lsyVoice'], (scoped) => {
    const voice = scoped.lsyVoice as Pick<LsyVoice, 'speak' | 'ttsEnabled'>
    scoped.tools.register(defineTool({
      name: 'speak',
      description: DESCRIPTION,
      parameters: {
        text: { type: 'string', required: true, description: 'What to say, in the language it should be spoken in (Chinese, English, or Japanese).' },
        send: { type: 'boolean', description: 'Send the audio to the owner on WeChat; default true. False only saves the file and returns its path.' },
      },
      output: { schema: OUTPUT_SCHEMA, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
      async execute(args, exec): Promise<SpeakOutput> {
        if (!voice.ttsEnabled) return { error: 'speech is turned off (lsy-voice tts.enabled is false)' }
        let spoken: Awaited<ReturnType<LsyVoice['speak']>>
        try {
          spoken = await voice.speak(args.text, { signal: exec.signal })
        } catch (error: unknown) {
          scoped.logger.warn(`lsy-tool-voice: speak failed: ${errorText(error)}`)
          return { error: errorText(error) }
        }
        const result: SpeakOutput = { path: spoken.path, format: spoken.format, bytes: spoken.bytes, provider: spoken.provider }
        if (args.send === false) {
          scoped.logger.info(`lsy-tool-voice: spoke ${Array.from(args.text).length} chars, saved only (${spoken.path})`)
          return result
        }
        const channel = scoped.get('lsyNotifier') as FileSender | undefined
        if (typeof channel?.sendFile !== 'function') {
          result.notSent = 'the WeChat channel is not mounted'
        } else {
          const outcome = await channel.sendFile(spoken.path)
          if ('sent' in outcome) result.sent = outcome.sent
          else result.notSent = outcome.notSent
        }
        scoped.logger.info(`lsy-tool-voice: spoke ${Array.from(args.text).length} chars with ${spoken.provider}; ${result.sent !== undefined ? `sent as ${result.sent}` : `not sent: ${result.notSent ?? ''}`} (${spoken.path})`)
        return result
      },
      presentCall: args => ({ card: 'generic', title: `Say it out loud (${Array.from(args.text).length} chars)`, kind: 'other', rawInput: args.text }),
    }))
  })
}
