/**
 * Voice for the owner's agents: text to speech (`ctx.lsyVoice.speak`) and speech to text
 * (`ctx.lsyVoice.transcribe`), both through the owner's own services over HTTP.
 *
 * Speech goes to feiyu (laptop, the default) or the Mac mini TTS service, with the other as an
 * optional fallback. Speech to text goes to the mini's asr-service and is off until
 * `asr.enabled` is set; nothing here ever opens a microphone, it only reads audio files handed to it.
 * Every provider answer is written to the data directory before it is parsed, and a failed call
 * leaves a log line with the reason.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { isAudioName, transcribeAudio } from './asr.ts'
import { VoiceError, type CallOptions } from './http.ts'
import { FeiyuTts, MacMiniTts, type TtsProvider } from './tts.ts'

export { ASR_EXTENSIONS, isAudioName } from './asr.ts'
export { callService, VoiceError } from './http.ts'
export { FeiyuTts, MacMiniTts } from './tts.ts'
export type { Transcript } from './asr.ts'
export type { Synthesis, TtsProvider } from './tts.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Text to speech and speech to text through the owner's voice services. */
    lsyVoice: LsyVoice
  }
}

const execFileAsync = promisify(execFile)

/** Providers a text can be synthesized by. */
export type TtsProviderName = 'feiyu' | 'mac-mini'

/** Voice configuration. Every field has a default, so a patch entry restates only what it changes. */
export interface Config {
  /** Absolute directory for audio and raw service answers; defaults to `<DSH_HOME>/lsy-voice`. */
  dataDir?: string
  /** Keep files this many days; older ones are removed on the next call. */
  keepDays: number
  /** Text to speech: the `speak` path. */
  tts: {
    /** Turns `speak` off when false. */
    enabled: boolean
    /** First provider to try. */
    provider: TtsProviderName
    /** Provider tried when the first fails; `none` stops after one. */
    fallback: TtsProviderName | 'none'
    /** Delivered file format; `mp3` needs ffmpeg and falls back to `wav` when the conversion fails. */
    format: 'mp3' | 'wav'
    /** Absolute path of the ffmpeg binary used for the mp3 conversion. */
    ffmpegPath: string
    /** Longest text accepted, in characters. */
    maxChars: number
    /** Extra attempts of one HTTP call after the first. */
    retries: number
    /** First pause before a retry, in milliseconds; it doubles each time. */
    retryDelayMs: number
    /** The feiyu voice service on the laptop (async jobs, bearer key). */
    feiyu: {
      /** Base URL of the service. */
      baseUrl: string
      /** Credential reference of the bearer key (in `$DSH_HOME/.env`). */
      apiKeyEnv: string
      /** Voice name sent with each job. */
      voice: string
      /** Style sent with each job (`cute` or `gentle`). */
      style: string
      /** Deadline of one HTTP call, in milliseconds. */
      timeoutMs: number
      /** Deadline of the whole job (queue, cold model load of about 45 s, synthesis), in milliseconds. */
      jobTimeoutMs: number
      /** Pause between job polls, in milliseconds. */
      pollMs: number
    }
    /** The Mac mini TTS service (Qwen3-TTS, answers the WAV directly). */
    macMini: {
      /** Base URL of the service. */
      baseUrl: string
      /** Preset speaker name. */
      speaker: string
      /** Language name the service expects, for example `Chinese`. */
      language: string
      /** Deadline of one call in milliseconds; the first call after idle loads the model. */
      timeoutMs: number
    }
  }
  /** Speech to text on audio files; reads files only and never opens a microphone. */
  asr: {
    /** Transcribe audio files the owner sends; off until set. */
    enabled: boolean
    /** Base URL of the asr-service. */
    baseUrl: string
    /** `funasr` (Chinese) or `whisper` (English and multilingual). */
    engine: 'funasr' | 'whisper'
    /** Whisper language hint, for example `en`. */
    language?: string
    /** Deadline of one call in milliseconds. */
    timeoutMs: number
    /** Extra attempts of one call after the first. */
    retries: number
    /** First pause before a retry, in milliseconds; it doubles each time. */
    retryDelayMs: number
    /** Largest audio file sent, in bytes. */
    maxBytes: number
  }
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  dataDir: z.string(),
  keepDays: z.natural().min(1).default(14),
  tts: z.object({
    enabled: z.boolean().default(true),
    provider: z.union(['feiyu', 'mac-mini'] as const).default('mac-mini'),
    fallback: z.union(['feiyu', 'mac-mini', 'none'] as const).default('feiyu'),
    format: z.union(['mp3', 'wav'] as const).default('mp3'),
    ffmpegPath: z.string().default('/opt/homebrew/bin/ffmpeg'),
    maxChars: z.natural().min(1).max(2000).default(200),
    retries: z.natural().default(2),
    retryDelayMs: z.natural().default(1000),
    feiyu: z.object({
      baseUrl: z.string().default('http://100.117.175.117:19880'),
      apiKeyEnv: z.string().role('credential-ref').default('LSY_FEIYU_API_KEY'),
      voice: z.string().default('feiyu'),
      style: z.string().default('cute'),
      timeoutMs: z.natural().min(1000).default(30_000),
      jobTimeoutMs: z.natural().min(1000).default(180_000),
      pollMs: z.natural().min(100).default(2000),
    }),
    macMini: z.object({
      baseUrl: z.string().default('http://127.0.0.1:8098'),
      speaker: z.string().default('vivian'),
      language: z.string().default('Chinese'),
      timeoutMs: z.natural().min(1000).default(240_000),
    }),
  }),
  asr: z.object({
    enabled: z.boolean().default(false),
    baseUrl: z.string().default('http://127.0.0.1:8099'),
    engine: z.union(['funasr', 'whisper'] as const).default('funasr'),
    language: z.string(),
    timeoutMs: z.natural().min(1000).default(120_000),
    retries: z.natural().default(2),
    retryDelayMs: z.natural().default(1000),
    maxBytes: z.natural().min(1024).default(25 * 1024 * 1024),
  }),
})

/** What {@link LsyVoice.speak} produced. */
export interface SpeakResult {
  /** Absolute path of the delivered audio file. */
  path: string
  format: 'mp3' | 'wav'
  bytes: number
  /** Provider that produced the audio. */
  provider: TtsProviderName
  /** The first provider's failure, when the fallback produced the audio. */
  fellBackFrom?: string
  elapsedMs: number
}

/** What {@link LsyVoice.transcribe} produced. */
export interface TranscribeResult {
  text: string
  engine: string
  durationS?: number
  /** Absolute path of the raw service answer. */
  rawPath: string
  elapsedMs: number
}

const DAY_MS = 86_400_000

/** Human-readable error text. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `YYYYMMDD-HHMMSS` of a date, in the process time zone. */
function stamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** Service behind `ctx.lsyVoice`. */
export class LsyVoice extends Service {
  static inject = ['credentials']
  static Config = Config

  private readonly dataDir: string
  private readonly abort = new AbortController()
  /** `speak` calls run one at a time: the feiyu GPU takes one job, and a burst should not pile up retries. */
  private chain: Promise<unknown> = Promise.resolve()
  private readonly providers = new Map<TtsProviderName, TtsProvider>()
  /** Replaced by tests. */
  now: () => Date = () => new Date()

  /**
   * @param ctx - the context providing `credentials`.
   * @param config - providers, switches, and limits.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'lsyVoice')
    if (config.dataDir !== undefined && !isAbsolute(config.dataDir)) throw new Error('lsy-voice: dataDir must be an absolute path')
    this.dataDir = config.dataDir ?? join(resolveDshHome(undefined, process.env), 'lsy-voice')
    ctx.effect(() => () => { this.abort.abort(new Error('lsy-voice is stopping')) }, 'lsyVoice.lifecycle()')
    ctx.logger.info(`lsy-voice: speech ${config.tts.enabled ? `on (${config.tts.provider}, fallback ${config.tts.fallback}, ${config.tts.format})` : 'off'}; transcription ${config.asr.enabled ? `on (${config.asr.engine} at ${config.asr.baseUrl})` : 'off'}; data in ${this.dataDir}`)
  }

  /** Whether `speak` is turned on. */
  get ttsEnabled(): boolean {
    return this.config.tts.enabled
  }

  /** Whether `transcribe` is turned on. */
  get asrEnabled(): boolean {
    return this.config.asr.enabled
  }

  /**
   * Whether `transcribe` would take this file: transcription is on and the extension is a format the asr-service reads.
   * @param path - file name or path.
   * @returns true when `transcribe` would accept the file.
   */
  canTranscribe(path: string): boolean {
    return this.config.asr.enabled && isAudioName(path)
  }

  /**
   * Turn a text into an audio file under the data directory. The provider's answer is written first
   * (`<name>.wav`, plus `<name>.job.json` when the provider has job metadata); the delivered file is
   * that WAV, or its MP3 conversion.
   * @param text - what to say.
   * @param options - `signal` cancels the call.
   * @returns the file and who made it.
   * @throws VoiceError when speech is off, the text is unusable, or every provider failed.
   */
  speak(text: string, options: { signal?: AbortSignal } = {}): Promise<SpeakResult> {
    const run = this.chain.then(() => this.speakNow(text, options.signal), () => this.speakNow(text, options.signal))
    this.chain = run.catch(() => {})
    return run
  }

  private async speakNow(input: string, outer?: AbortSignal): Promise<SpeakResult> {
    const { tts } = this.config
    if (!tts.enabled) throw new VoiceError('speech is turned off (lsy-voice tts.enabled is false)')
    const text = input.trim()
    if (text === '') throw new VoiceError('there is no text to say')
    if (Array.from(text).length > tts.maxChars) throw new VoiceError(`the text is ${Array.from(text).length} characters; speech takes at most ${tts.maxChars}, so say it in parts`)
    const signal = outer === undefined ? this.abort.signal : AbortSignal.any([outer, this.abort.signal])
    const started = Date.now()
    const order: TtsProviderName[] = [tts.provider, ...tts.fallback !== 'none' && tts.fallback !== tts.provider ? [tts.fallback] : []]
    let failed: string | undefined
    for (const name of order) {
      try {
        const synthesis = await this.provider(name).synthesize(text, signal)
        const result = await this.keep(name, text, synthesis, started, failed)
        this.ctx.logger.info(`lsy-voice: spoke ${Array.from(text).length} chars with ${name} in ${result.elapsedMs} ms -> ${result.path} (${result.format}, ${result.bytes} B)${failed === undefined ? '' : `; ${order[0]} failed first`}`)
        void this.prune()
        return result
      } catch (error: unknown) {
        if (signal.aborted) throw new VoiceError('speech was cancelled')
        const reason = errorText(error)
        this.ctx.logger.warn(`lsy-voice: ${name} could not speak ${Array.from(text).length} chars: ${reason}`)
        failed = failed === undefined ? `${name}: ${reason}` : `${failed}; ${name}: ${reason}`
      }
    }
    this.ctx.logger.error(`lsy-voice: no provider could speak ${Array.from(text).length} chars: ${failed ?? ''}`)
    throw new VoiceError(`speech failed (${failed ?? 'no provider'})`)
  }

  /** Write the raw answer, convert, and describe the deliverable. */
  private async keep(
    name: TtsProviderName, text: string, synthesis: { audio: Buffer; raw?: string }, started: number, failed: string | undefined,
  ): Promise<SpeakResult> {
    const dir = join(this.dataDir, 'audio')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const base = join(dir, `${stamp(this.now())}-${createHash('sha256').update(text).digest('hex').slice(0, 8)}-${name}`)
    if (synthesis.raw !== undefined) await writeFile(`${base}.job.json`, synthesis.raw, { mode: 0o600 })
    await writeFile(`${base}.wav`, synthesis.audio, { mode: 0o600 })
    let path = `${base}.wav`
    let format: 'mp3' | 'wav' = 'wav'
    if (this.config.tts.format === 'mp3') {
      try {
        await execFileAsync(this.config.tts.ffmpegPath, ['-y', '-v', 'error', '-i', `${base}.wav`, '-codec:a', 'libmp3lame', '-q:a', '4', '-f', 'mp3', `${base}.mp3.part`], { timeout: 30_000 })
        await rename(`${base}.mp3.part`, `${base}.mp3`)
        path = `${base}.mp3`
        format = 'mp3'
      } catch (error: unknown) {
        this.ctx.logger.warn(`lsy-voice: converting to mp3 failed (${errorText(error).split('\n')[0]}); delivering the WAV`)
        await unlink(`${base}.mp3.part`).catch(() => {})
      }
    }
    return {
      path, format, bytes: (await stat(path)).size, provider: name,
      ...failed === undefined ? {} : { fellBackFrom: failed },
      elapsedMs: Date.now() - started,
    }
  }

  /**
   * Transcribe an audio file. The service's raw answer is written to `<dataDir>/asr/` before it is parsed.
   * @param path - absolute path of an audio file the asr-service reads (m4a, mp3, wav, flac, ogg, wma, aac, webm).
   * @param options - `signal` cancels the call.
   * @returns the text and where the raw answer lives.
   * @throws VoiceError when transcription is off, the file is unusable, or the service failed.
   */
  async transcribe(path: string, options: { signal?: AbortSignal } = {}): Promise<TranscribeResult> {
    const { asr } = this.config
    if (!asr.enabled) throw new VoiceError('transcription is turned off (lsy-voice asr.enabled is false)')
    if (!isAbsolute(path)) throw new VoiceError('path must be absolute')
    if (!isAudioName(path)) throw new VoiceError(`${extname(path) || 'this file'} is not an audio format the asr-service reads`)
    const info = await stat(path).catch((error: unknown) => {
      throw new VoiceError(`cannot read the audio (${(error as NodeJS.ErrnoException).code ?? errorText(error)})`)
    })
    if (!info.isFile() || info.size === 0) throw new VoiceError('the audio is not a non-empty regular file')
    if (info.size > asr.maxBytes) throw new VoiceError(`the audio exceeds ${asr.maxBytes} bytes`)
    const audio = await readFile(path)
    const started = Date.now()
    const dir = join(this.dataDir, 'asr')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const rawPath = join(dir, `${stamp(this.now())}-${createHash('sha256').update(audio).digest('hex').slice(0, 8)}.json`)
    const signal = options.signal === undefined ? this.abort.signal : AbortSignal.any([options.signal, this.abort.signal])
    try {
      const transcript = await transcribeAudio(basename(path), audio, {
        baseUrl: asr.baseUrl, engine: asr.engine, ...asr.language === undefined ? {} : { language: asr.language },
        call: this.callOptions(asr.timeoutMs, asr.retries, asr.retryDelayMs, signal),
      }, raw => writeFile(rawPath, raw, { mode: 0o600 }))
      const elapsedMs = Date.now() - started
      this.ctx.logger.info(`lsy-voice: transcribed ${basename(path)} (${info.size} B) with ${transcript.engine}: ${Array.from(transcript.text).length} chars in ${elapsedMs} ms; raw ${rawPath}`)
      void this.prune()
      return { ...transcript, rawPath, elapsedMs }
    } catch (error: unknown) {
      this.ctx.logger.warn(`lsy-voice: transcribing ${basename(path)} failed: ${errorText(error)}`)
      throw error instanceof VoiceError ? error : new VoiceError(errorText(error))
    }
  }

  private callOptions(timeoutMs: number, retries: number, retryDelayMs: number, signal: AbortSignal, label?: string): CallOptions {
    return {
      timeoutMs, retries, retryDelayMs, signal,
      onRetry: (attempt, reason) => { this.ctx.logger.warn(`lsy-voice: retrying${label === undefined ? '' : ` ${label}`} after attempt ${attempt}: ${reason}`) },
    }
  }

  private provider(name: TtsProviderName): TtsProvider {
    let provider = this.providers.get(name)
    if (provider !== undefined) return provider
    const { tts } = this.config
    if (name === 'feiyu') {
      const { feiyu } = tts
      const ref = credentialRef(feiyu.apiKeyEnv)
      provider = new FeiyuTts({
        baseUrl: feiyu.baseUrl, voice: feiyu.voice, style: feiyu.style, jobTimeoutMs: feiyu.jobTimeoutMs, pollMs: feiyu.pollMs,
        apiKey: async () => (await this.ctx.credentials.resolve(ref))?.value,
        call: this.callOptions(feiyu.timeoutMs, tts.retries, tts.retryDelayMs, this.abort.signal, 'feiyu'),
      })
    } else {
      const { macMini } = tts
      provider = new MacMiniTts({
        baseUrl: macMini.baseUrl, speaker: macMini.speaker, language: macMini.language,
        call: this.callOptions(macMini.timeoutMs, tts.retries, tts.retryDelayMs, this.abort.signal, 'mac-mini'),
      })
    }
    this.providers.set(name, provider)
    return provider
  }

  /** Remove audio and raw answers older than `keepDays`; failures are logged, never thrown. */
  private async prune(): Promise<void> {
    const cutoff = Date.now() - this.config.keepDays * DAY_MS
    let removed = 0
    for (const sub of ['audio', 'asr']) {
      const dir = join(this.dataDir, sub)
      try {
        for (const name of await readdir(dir)) {
          const file = join(dir, name)
          if ((await stat(file)).mtimeMs < cutoff) {
            await unlink(file)
            removed++
          }
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.ctx.logger.warn(`lsy-voice: pruning ${dir} failed: ${errorText(error)}`)
      }
    }
    if (removed > 0) this.ctx.logger.info(`lsy-voice: removed ${removed} file(s) older than ${this.config.keepDays} days`)
  }
}

export default LsyVoice
