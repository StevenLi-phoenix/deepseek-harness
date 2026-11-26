/**
 * The speech seam of a call: a provider that turns an utterance into text and an answer into audio.
 * The built-in provider adapts `ctx.voice` (the asr-service and the feiyu TTS); another plugin may
 * provide its own as a Host service and name it in the configuration. Also here: how an answer is
 * cleaned up and cut into sentences that are spoken one after another.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Voice } from '@deepseek-ai/dsh-voice'
import { readWav, writeWav, type PcmAudio } from './audio.ts'

/** Turns utterances into text and text into audio for the calls. */
export interface CallSpeech {
  /** Name for the log. */
  readonly name: string
  /** Longest text {@link synthesize} takes, in code points. */
  readonly maxChars: number
  /**
   * Recognize one utterance.
   * @param audio - the owner's speech.
   * @param signal - aborts the call when the owner hangs up.
   * @returns what was said; empty when nothing was recognized.
   */
  transcribe(audio: PcmAudio, signal: AbortSignal): Promise<string>
  /**
   * Say one sentence.
   * @param text - at most {@link maxChars} code points.
   * @param signal - aborts the call on barge-in or hang-up.
   * @returns the audio at any rate.
   */
  synthesize(text: string, signal: AbortSignal): Promise<PcmAudio>
}

/** Sample rate the utterance is written at for the asr-service. */
const ASR_RATE = 16_000

/**
 * The built-in provider over `ctx.voice`. Utterances go to the asr-service as 16 kHz WAV files
 * that are deleted once transcribed; answers use the WAV `ctx.voice` writes next to its MP3.
 * @param voice - the voice service.
 * @param scratchDir - absolute directory for the utterance files.
 * @param resampleTo - rate conversion used for the utterance.
 * @returns the provider.
 */
export function voiceSpeech(
  voice: Pick<Voice, 'speak' | 'transcribe' | 'describe'>,
  scratchDir: string,
  resampleTo: (audio: PcmAudio, rate: number) => PcmAudio,
): CallSpeech {
  return {
    name: 'voice',
    maxChars: voice.describe().tts.maxChars,
    async transcribe(audio, signal) {
      await mkdir(scratchDir, { recursive: true, mode: 0o700 })
      const path = join(scratchDir, `${randomUUID()}.wav`)
      await writeFile(path, writeWav(resampleTo(audio, ASR_RATE)), { mode: 0o600 })
      try {
        return (await voice.transcribe(path, { signal })).text.trim()
      } finally {
        await unlink(path).catch(() => undefined)
      }
    },
    async synthesize(text, signal) {
      const spoken = await voice.speak(text, { signal })
      // speak writes `<name>.wav` before converting it, and the WAV stays beside the MP3.
      const wavPath = spoken.format === 'wav' ? spoken.path : spoken.path.replace(/\.mp3$/u, '.wav')
      return readWav(await readFile(wavPath))
    },
  }
}

/**
 * Turn a chat answer into words to say: Markdown marks, links, code, and emoji out.
 * @param text - the agent's answer.
 * @returns plain spoken text, possibly empty.
 */
export function spokenText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`([^`]*)`/gu, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/https?:\/\/\S+/gu, ' ')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gmu, '')
    .replace(/[*_~]{1,3}([^*_~\n]+)[*_~]{1,3}/gu, '$1')
    .replace(/\p{Extended_Pictographic}️?/gu, '')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\s*\n+\s*/gu, '\n')
    .trim()
}

const SENTENCE_END = /(?<=[。！？!?；;…]|[.](?=\s|$))\s*|\n+/u

/**
 * Cut spoken text into sentences of at most `maxChars` code points, so the first one can be heard
 * while the next is synthesized. A sentence longer than the limit is cut at a comma, then anywhere.
 * @param text - spoken text.
 * @param maxChars - longest piece.
 * @returns the pieces in order, none empty.
 */
export function sentences(text: string, maxChars: number): string[] {
  const out: string[] = []
  for (const sentence of text.split(SENTENCE_END)) {
    let rest = sentence.trim()
    while (rest !== '') {
      const chars = Array.from(rest)
      if (chars.length <= maxChars) {
        out.push(rest)
        break
      }
      const head = chars.slice(0, maxChars).join('')
      const comma = Math.max(...['，', ',', '、', '：', ':', ' '].map(mark => head.lastIndexOf(mark)))
      const cut = comma > head.length / 3 ? comma + 1 : head.length
      out.push(head.slice(0, cut).trim())
      rest = rest.slice(cut).trim()
    }
  }
  return out.filter(piece => piece !== '')
}
