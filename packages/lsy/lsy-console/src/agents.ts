/**
 * Claude Code and voice, the two agent-side services with something to do on a settings page: the Claude Code sessions of the
 * service account (list, start with a first task, stop) and the voice service (state, and a preview that plays in the browser).
 * The preview is synthesized from one fixed sentence and returned as audio to the caller; it is never sent to a channel.
 */

import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { claudeCodeOf, type CcOutcome } from './claude-code.ts'
import type { Config } from './config.ts'
import { logAction, type Log } from './log.ts'
import { httpProbe, isReachable } from './probe.ts'
import { Refusal, parseBody } from './request.ts'
import { MAX_TASK_CHARS, type AgentsView, type VoiceView } from './views.ts'

const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/u

interface StartBody {
  action: 'cc.start'
  name: string
  task?: string
}

interface StopBody {
  action: 'cc.stop'
  name: string
}

const startSchema: z<StartBody> = z.object({
  action: z.const('cc.start').required(),
  name: z.string().required().pattern(NAME),
  task: z.string(),
})
const stopSchema: z<StopBody> = z.object({
  action: z.const('cc.stop').required(),
  name: z.string().required().pattern(NAME),
})

/** Result of an agents POST: a JSON acknowledgement, or the preview audio. */
export type AgentsResult = { readonly kind: 'ok' } | { readonly kind: 'audio'; readonly bytes: Uint8Array; readonly type: string }

/** Detail clipped for the screen. */
function clip(text: string): string {
  return text.replaceAll(/\s+/gu, ' ').trim().slice(0, 160)
}

async function voiceView(ctx: Context, config: Config, fetchImpl: typeof fetch): Promise<VoiceView | null> {
  const voice = ctx.get('lsyVoice')
  if (voice === undefined) return null
  const summary = voice.describe()
  const probe = (enabled: boolean, url: string): Promise<boolean | null> => enabled
    ? httpProbe(`${url.replace(/\/+$/u, '')}/health`, config.probeTimeoutMs, fetchImpl).then(isReachable)
    : Promise.resolve(null)
  const [ttsUp, asrUp] = await Promise.all([probe(summary.tts.enabled, summary.tts.url), probe(summary.asr.enabled, summary.asr.url)])
  return {
    available: true,
    ttsEnabled: summary.tts.enabled,
    provider: summary.tts.provider,
    format: summary.tts.format,
    ttsUp,
    asrEnabled: summary.asr.enabled,
    engine: summary.asr.engine,
    asrUp,
    previewChars: Array.from(config.previewText).length,
  }
}

/**
 * Read both cards.
 * @param ctx - Host context.
 * @param config - settings.
 * @param fetchImpl - replaceable in tests.
 * @param now - clock.
 * @returns the view; a card is null when its service is not available.
 */
export async function readAgents(
  ctx: Context, config: Config, fetchImpl: typeof fetch = fetch, now: () => number = Date.now,
): Promise<AgentsView> {
  const claudeCode = claudeCodeOf(ctx)
  const [cc, voice] = await Promise.all([
    claudeCode?.enabled === true ? claudeCode.view().catch((error: unknown) => {
      ctx.logger.warn(`lsy-console: reading Claude Code sessions failed: ${error instanceof Error ? error.name : 'error'}`)
      return null
    }) : Promise.resolve(null),
    voiceView(ctx, config, fetchImpl),
  ])
  return { cc, voice, checkedAt: now() }
}

let previewing = false

async function preview(ctx: Context, config: Config): Promise<AgentsResult> {
  const voice = ctx.get('lsyVoice')
  if (voice === undefined) throw new Refusal('unavailable', 'voice')
  if (!voice.ttsEnabled) throw new Refusal('speech_off')
  // The preview waits for the voice service, which takes one job at a time; a second click joins nothing.
  if (previewing) throw new Refusal('limit_reached', 'preview')
  previewing = true
  try {
    const spoken = await voice.speak(config.previewText)
    return { kind: 'audio', bytes: await readFile(spoken.path), type: spoken.format === 'mp3' ? 'audio/mpeg' : 'audio/wav' }
  } catch (error: unknown) {
    // `VoiceError` is told by name: this package imports no runtime value from the voice package.
    if (error instanceof Error && error.name === 'VoiceError') throw new Refusal('speech_failed', clip(error.message))
    throw error
  } finally {
    previewing = false
  }
}

/**
 * Run one POST action.
 * @param ctx - Host context.
 * @param config - settings.
 * @param log - logger.
 * @param body - parsed JSON body.
 * @returns an acknowledgement, or the preview audio.
 * @throws {Refusal} for anything the request or the services refuse.
 */
export async function runAgentsAction(ctx: Context, config: Config, log: Log, body: unknown): Promise<AgentsResult> {
  const requested = typeof body === 'object' && body !== null ? (body as { action?: unknown }).action : undefined
  if (requested === 'voice.preview') return logAction(log, 'voice.preview', '', () => preview(ctx, config))
  if (requested !== 'cc.start' && requested !== 'cc.stop') throw new Refusal('invalid_request', 'action')
  const claudeCode = claudeCodeOf(ctx)
  if (claudeCode?.enabled !== true) throw new Refusal('unavailable', 'cc')
  if (requested === 'cc.start') {
    const { name, task } = parseBody(startSchema, body)
    if ((task?.length ?? 0) > MAX_TASK_CHARS) throw new Refusal('invalid_request', 'task')
    await logAction(log, 'cc.start', name, async () => { refuseUnless(await claudeCode.start(name, task)) })
  } else {
    const { name } = parseBody(stopSchema, body)
    await logAction(log, 'cc.stop', name, async () => { refuseUnless(await claudeCode.stop(name)) })
  }
  return { kind: 'ok' }
}

/** Turn a failed Claude Code outcome into its refusal. */
function refuseUnless(outcome: CcOutcome): void {
  if (!outcome.ok) throw new Refusal(outcome.error, outcome.detail === undefined ? undefined : clip(outcome.detail))
}
