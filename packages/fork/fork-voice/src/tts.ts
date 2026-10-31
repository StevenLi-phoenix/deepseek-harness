/**
 * Text-to-speech providers. Each turns one text into WAV bytes plus the provider's raw metadata;
 * the service writes both to disk before anything is parsed further.
 */

import { callService, VoiceError, type CallOptions } from './http.ts'

/** What a provider hands back. */
export interface Synthesis {
  /** WAV bytes, exactly as the provider sent them. */
  audio: Buffer
  /** The provider's raw job or response metadata, when it has any (JSON text). */
  raw?: string
}

/** One text-to-speech backend. */
export interface TtsProvider {
  readonly name: string
  /**
   * Synthesize one text.
   * @param text - non-empty text, within the provider's limit.
   * @param signal - cancels the call.
   * @throws VoiceError when the provider could not produce audio.
   */
  synthesize(text: string, signal?: AbortSignal): Promise<Synthesis>
}

/** Feiyu voice service (laptop, async jobs, bearer key). */
export interface FeiyuOptions {
  baseUrl: string
  /** Resolves the bearer key per call; the key never enters a log. */
  apiKey: () => Promise<string | undefined>
  voice: string
  style: string
  /** Deadline of the whole job (queue, cold model load, synthesis), in milliseconds. */
  jobTimeoutMs: number
  /** Pause between job polls, in milliseconds. */
  pollMs: number
  call: CallOptions
  now?: () => number
}

const FEIYU_DONE: ReadonlySet<string> = new Set(['success', 'succeeded', 'completed', 'done'])
const FEIYU_FAILED: ReadonlySet<string> = new Set(['failed', 'error', 'cancelled', 'canceled'])

/** Join a base URL and a path without doubling the slash. */
function join(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

/** The feiyu provider: POST a speech job, poll it, fetch the audio. */
export class FeiyuTts implements TtsProvider {
  readonly name = 'feiyu'

  /** @param options - endpoint, key source, voice, and deadlines. */
  constructor(private readonly options: FeiyuOptions) {}

  async synthesize(text: string, signal?: AbortSignal): Promise<Synthesis> {
    const { options } = this
    const key = await options.apiKey()
    if (key === undefined || key === '') throw new VoiceError('feiyu: the API key is not configured')
    const headers = { authorization: `Bearer ${key}` }
    const call = (label: string, url: string, init: RequestInit): Promise<Response> =>
      callService(`feiyu ${label}`, url, { ...init, headers: { ...headers, ...init.headers as Record<string, string> } }, { ...options.call, signal: signal ?? options.call.signal })
    const now = options.now ?? Date.now
    const deadline = now() + options.jobTimeoutMs

    const submit = await call('POST /v1/speech', join(options.baseUrl, '/v1/speech'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, voice: options.voice, style: options.style }),
    })
    const job = await submit.json() as { id?: unknown }
    if (typeof job.id !== 'string' || job.id === '') throw new VoiceError('feiyu POST /v1/speech returned no job id')
    const id = encodeURIComponent(job.id)

    let raw = ''
    for (;;) {
      const response = await call(`GET /v1/jobs/${job.id}`, join(options.baseUrl, `/v1/jobs/${id}`), { method: 'GET' })
      raw = await response.text()
      let status: unknown
      try {
        status = (JSON.parse(raw) as { status?: unknown }).status
      } catch {
        throw new VoiceError(`feiyu job ${job.id} returned a body that is not JSON`)
      }
      if (typeof status === 'string' && FEIYU_DONE.has(status)) break
      if (typeof status === 'string' && FEIYU_FAILED.has(status)) throw new VoiceError(`feiyu job ${job.id} ${status}: ${raw.slice(0, 200)}`)
      if (now() >= deadline) throw new VoiceError(`feiyu job ${job.id} still ${String(status)} after ${options.jobTimeoutMs} ms`)
      await (options.call.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))))(options.pollMs)
    }
    const audio = await call(`GET /v1/jobs/${job.id}/audio`, join(options.baseUrl, `/v1/jobs/${id}/audio`), { method: 'GET' })
    const bytes = Buffer.from(await audio.arrayBuffer())
    if (bytes.byteLength === 0) throw new VoiceError(`feiyu job ${job.id} returned empty audio`)
    return { audio: bytes, raw }
  }
}

/** Mac mini TTS service (Qwen3-TTS, multipart form, answers the WAV directly). */
export interface MacMiniOptions {
  baseUrl: string
  speaker: string
  language: string
  call: CallOptions
}

/** The mac-mini provider. */
export class MacMiniTts implements TtsProvider {
  readonly name = 'mac-mini'

  /** @param options - endpoint, speaker, language, and deadlines. */
  constructor(private readonly options: MacMiniOptions) {}

  async synthesize(text: string, signal?: AbortSignal): Promise<Synthesis> {
    const { options } = this
    const form = new FormData()
    form.set('text', text)
    form.set('language', options.language)
    form.set('speaker', options.speaker)
    const response = await callService('mac-mini POST /synthesize', join(options.baseUrl, '/synthesize'), { method: 'POST', body: form }, { ...options.call, signal: signal ?? options.call.signal })
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength === 0) throw new VoiceError('mac-mini POST /synthesize returned empty audio')
    return { audio: bytes }
  }
}
