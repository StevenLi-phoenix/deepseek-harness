/**
 * The talking part of one connected call. The owner's audio goes through voice-activity detection
 * and speech recognition (or arrives as text the app recognized) and is prompted into the call
 * Session; each answer the relay hands back is spoken over the line (or sent to the app to speak).
 * Speech from the owner while the agent talks stops the agent at once: barge-in.
 */

import { CALL_RATE, resample, type PcmAudio } from './audio.ts'
import type { CallMedia } from './media.ts'
import { Playout } from './playout.ts'
import { assertNever, parseAppMessage, serverFrame, type AgentActivity, type AppMessage, type SpeechMode } from './protocol.ts'
import { sentences, spokenText, type CallSpeech } from './speech.ts'
import type { TranscriptLine } from './storage.ts'
import { VoiceActivityDetector, type VadConfig } from './vad.ts'

/** Where recognition and synthesis run. */
export interface SpeechModes {
  stt: SpeechMode
  tts: SpeechMode
}

/** What a conversation needs from its call. */
export interface ConversationOptions {
  media: CallMedia
  modes: SpeechModes
  /** Required when either mode is `server`. */
  speech: CallSpeech | undefined
  vad: VadConfig
  /** Stop the agent's speech when the owner starts talking. */
  bargeIn: boolean
  /** Longest owner utterance text prompted, in code points. */
  maxUtteranceChars: number
  /**
   * Prompt the call Session with what the owner said.
   * @param text - the recognized utterance.
   */
  prompt(text: string): Promise<void>
  /** Record one transcript line. */
  record(line: TranscriptLine): void
  /** The app asked to hang up. */
  hangup(): void
  /** Log sink. */
  log(level: 'info' | 'warn' | 'debug', message: string): void
  /** Clock in milliseconds. */
  now(): number
}

/** Human-readable error text. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One connected call's speech loop; created when media connects, stopped when the call ends. */
export class Conversation {
  private readonly vad: VoiceActivityDetector
  private readonly playout: Playout
  private readonly abort = new AbortController()
  /** Aborted on barge-in: cancels the answer being synthesized. */
  private speaking: AbortController | undefined
  /** Recognition runs one utterance at a time, in order. */
  private recognition: Promise<void> = Promise.resolve()
  /** Answers are spoken one at a time, in order. */
  private speech: Promise<void> = Promise.resolve()
  /** Last state sent to the app; undefined before {@link start}. */
  private activity: AgentActivity | undefined
  private turnRunning = false
  private stopped = false

  /** @param options - the call's media, speech, and hooks. */
  constructor(private readonly options: ConversationOptions) {
    this.vad = new VoiceActivityDetector(options.vad)
    this.playout = new Playout((payload, marker) => { options.media.sendFrame(payload, marker) })
    if ((options.modes.stt === 'server' || options.modes.tts === 'server') && options.speech === undefined) {
      throw new Error('a server speech mode needs a speech provider')
    }
  }

  /** Start sending audio and listening. */
  start(): void {
    this.playout.start()
    this.options.media.onAudio((frame) => { this.hear(frame) })
    this.options.media.onControl((frame) => {
      const message = parseAppMessage(frame)
      if (message === undefined) this.options.log('debug', `voice-call: ignored a control frame of ${frame.length} chars`)
      else this.onMessage(message)
    })
    this.setActivity('listening')
  }

  /** Stop everything; queued speech is dropped. Idempotent. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.abort.abort(new Error('the call ended'))
    this.speaking?.abort(new Error('the call ended'))
    this.playout.stop()
    this.vad.reset()
  }

  /** The call Session started a turn. */
  turnStarted(): void {
    this.turnRunning = true
    if (this.activity === 'listening') this.setActivity('thinking')
  }

  /** The call Session's turn settled; nothing more is coming for now. */
  turnSettled(): void {
    this.turnRunning = false
    if (this.activity === 'thinking') this.setActivity('listening')
  }

  /**
   * Speak one answer of the call Session, after any answer still being spoken.
   * @param text - the answer as the agent wrote it.
   * @returns settlement once it was spoken, interrupted, or the call ended.
   */
  say(text: string): Promise<void> {
    const run = this.speech.then(() => this.sayNow(text))
    this.speech = run.catch(() => undefined)
    return run
  }

  /**
   * Prompt the opening context of the call (who called and why); the agent's answer is its greeting.
   * @param run - sends the context prompt.
   */
  open(run: () => Promise<void>): void {
    this.setActivity('thinking')
    run().catch((error: unknown) => {
      this.options.log('warn', `voice-call: the opening prompt failed: ${errorText(error)}`)
      this.setActivity('listening')
    })
  }

  private async sayNow(answer: string): Promise<void> {
    if (this.stopped) return
    const text = spokenText(answer)
    if (text === '') return
    this.options.record({ role: 'agent', text, at: this.options.now() })
    this.send({ type: 'transcript', role: 'agent', text })
    if (this.options.modes.tts === 'device') {
      this.send({ type: 'say', text })
      this.setActivity(this.turnRunning ? 'thinking' : 'listening')
      return
    }
    const speech = this.options.speech as CallSpeech
    const controller = new AbortController()
    this.speaking = controller
    const signal = AbortSignal.any([controller.signal, this.abort.signal])
    this.setActivity('speaking')
    try {
      // Synthesis of the next sentence overlaps the playout of the current one.
      const pieces = sentences(text, speech.maxChars)
      const synthesize = (index: number): Promise<PcmAudio> | undefined => {
        const piece = pieces[index]
        if (piece === undefined) return undefined
        const audio = speech.synthesize(piece, signal)
        // A prefetched piece may fail after barge-in, when nobody awaits it any more.
        audio.catch(() => undefined)
        return audio
      }
      let next = synthesize(0)
      for (let index = 1; next !== undefined; index += 1) {
        const audio = await next
        next = synthesize(index)
        if (signal.aborted) return
        this.playout.enqueue(toCallRate(audio))
      }
      await this.playout.idle()
    } catch (error: unknown) {
      if (!signal.aborted) this.options.log('warn', `voice-call: speaking ${Array.from(text).length} chars failed: ${errorText(error)}`)
    } finally {
      // Answers are spoken one at a time, so this controller is still the current one.
      this.speaking = undefined
      if (!this.hasStopped() && this.activity === 'speaking') this.setActivity(this.turnRunning ? 'thinking' : 'listening')
    }
  }

  /** Reads `stopped` afresh; a check before an `await` does not narrow it after. */
  private hasStopped(): boolean {
    return this.stopped
  }

  private hear(frame: Int16Array): void {
    if (this.stopped) return
    for (const event of this.vad.push(frame)) {
      if (event.kind === 'speech-start') {
        this.options.log('debug', 'voice-call: the owner started speaking')
        if (this.options.bargeIn) this.bargeIn('speech')
      } else if (event.kind === 'utterance') {
        if (this.options.modes.stt === 'server') this.recognize({ samples: event.samples, sampleRate: CALL_RATE }, event.durationMs)
      } else {
        this.options.log('debug', `voice-call: dropped ${event.durationMs} ms of sound as too short`)
      }
    }
  }

  private onMessage(message: AppMessage): void {
    switch (message.type) {
      case 'utterance':
        if (this.options.modes.stt === 'device') this.heard(message.text)
        break
      case 'speaking':
        if (this.options.bargeIn) this.bargeIn('speech')
        break
      case 'interrupt':
        this.bargeIn('button')
        break
      case 'hangup':
        this.options.hangup()
        break
      /* v8 ignore next 2 -- parseAppMessage returns only the four members above. */
      default:
        assertNever(message, 'voice-call control message')
    }
  }

  /** Stop the agent talking. */
  private bargeIn(cause: 'speech' | 'button'): void {
    const talking = this.playout.speaking || this.speaking !== undefined
    if (talking) this.options.log('info', `voice-call: barge-in (${cause}); the agent stops talking`)
    this.speaking?.abort(new Error('barge-in'))
    this.playout.clear()
    if (this.options.modes.tts === 'device') this.send({ type: 'stop-speaking' })
    if (this.activity === 'speaking') this.setActivity(this.turnRunning ? 'thinking' : 'listening')
  }

  private recognize(audio: PcmAudio, durationMs: number): void {
    const speech = this.options.speech as CallSpeech
    const run = this.recognition.then(async () => {
      if (this.stopped) return
      const started = this.options.now()
      const text = await speech.transcribe(audio, this.abort.signal)
      this.options.log('info', `voice-call: recognized ${durationMs} ms of speech as ${Array.from(text).length} chars in ${this.options.now() - started} ms`)
      this.heard(text)
    })
    this.recognition = run.catch((error: unknown) => {
      if (!this.stopped) this.options.log('warn', `voice-call: recognition failed: ${errorText(error)}`)
    })
  }

  private heard(raw: string): void {
    const text = Array.from(raw.trim()).slice(0, this.options.maxUtteranceChars).join('')
    if (text === '' || this.stopped) return
    this.options.record({ role: 'owner', text, at: this.options.now() })
    this.send({ type: 'transcript', role: 'owner', text })
    this.setActivity('thinking')
    this.options.prompt(text).catch((error: unknown) => {
      this.options.log('warn', `voice-call: prompting the call Session failed: ${errorText(error)}`)
      if (!this.turnRunning) this.setActivity('listening')
    })
  }

  private setActivity(activity: AgentActivity): void {
    if (this.activity === activity) return
    this.activity = activity
    this.send({ type: 'state', state: activity })
  }

  private send(message: Parameters<typeof serverFrame>[0]): void {
    if (!this.stopped) this.options.media.sendControl(serverFrame(message))
  }
}

/** Synthesized audio at the call's rate. */
function toCallRate(audio: PcmAudio): Int16Array {
  return resample(audio.samples, audio.sampleRate, CALL_RATE)
}
