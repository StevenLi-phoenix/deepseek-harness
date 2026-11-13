/** Speech-to-text through the asr-service (`POST /transcribe`, multipart). */

import { basename, extname } from 'node:path'
import { callService, VoiceError, type CallOptions } from './http.ts'

/** Formats the asr-service accepts (it converts them with ffmpeg). */
export const ASR_EXTENSIONS: ReadonlySet<string> = new Set(['.m4a', '.mp3', '.wav', '.flac', '.ogg', '.wma', '.aac', '.webm'])

/** What the service answered, parsed. */
export interface Transcript {
  text: string
  engine: string
  /** Audio length in seconds, when the service reports it. */
  durationS?: number
}

/** The asr-service client. */
export interface AsrOptions {
  baseUrl: string
  /** `funasr` (Chinese, default) or `whisper` (English and multilingual). */
  engine: 'funasr' | 'whisper'
  /** Whisper language hint, for example `en`. */
  language?: string
  call: CallOptions
}

/**
 * Whether the asr-service can read a file by its name.
 * @param name - file name or path.
 * @returns true for a supported audio extension.
 */
export function isAudioName(name: string): boolean {
  return ASR_EXTENSIONS.has(extname(name).toLowerCase())
}

/**
 * Send audio to the asr-service. The raw answer goes to `keepRaw` before it is parsed.
 * @param name - file name, whose extension tells the service the format.
 * @param audio - file content.
 * @param options - endpoint, engine, and deadlines.
 * @param keepRaw - stores the raw response text (called before parsing).
 * @returns the transcript.
 * @throws VoiceError when the service fails or answers something unreadable.
 */
export async function transcribeAudio(
  name: string, audio: Buffer, options: AsrOptions, keepRaw: (raw: string) => Promise<void>,
): Promise<Transcript> {
  if (!isAudioName(name)) throw new VoiceError(`${extname(name) || 'this'} is not an audio format the asr-service reads (${[...ASR_EXTENSIONS].join(' ')})`)
  const form = new FormData()
  form.set('file', new Blob([new Uint8Array(audio)]), basename(name))
  form.set('engine', options.engine)
  if (options.language !== undefined && options.language !== '') form.set('language', options.language)
  const response = await callService('asr POST /transcribe', `${options.baseUrl.replace(/\/+$/, '')}/transcribe`, { method: 'POST', body: form }, options.call)
  const raw = await response.text()
  await keepRaw(raw)
  let parsed: { full_text?: unknown; engine?: unknown; duration_s?: unknown }
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch {
    throw new VoiceError('asr POST /transcribe returned a body that is not JSON')
  }
  if (typeof parsed.full_text !== 'string') throw new VoiceError('asr POST /transcribe returned no full_text')
  return {
    text: parsed.full_text.trim(),
    engine: typeof parsed.engine === 'string' ? parsed.engine : options.engine,
    ...typeof parsed.duration_s === 'number' ? { durationS: parsed.duration_s } : {},
  }
}
