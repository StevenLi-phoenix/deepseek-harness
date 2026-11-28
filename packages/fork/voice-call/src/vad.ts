/**
 * Energy voice-activity detection over 20 ms call frames: when the owner starts speaking (for
 * barge-in) and the utterance they finished (for transcription). The threshold follows the line's
 * noise floor, so a noisy room does not count as speech.
 */

import { FRAME_MS, rms } from './audio.ts'

/** Detection settings, all in milliseconds except the levels. */
export interface VadConfig {
  /** Speech this long in a row starts an utterance. */
  onsetMs: number
  /** Silence this long ends it. */
  endSilenceMs: number
  /** Shorter utterances are dropped as noise. */
  minSpeechMs: number
  /** An utterance is cut and emitted at this length. */
  maxUtteranceMs: number
  /** Audio kept from before the onset, so the first syllable is not lost. */
  preRollMs: number
  /** RMS level below which a frame is never speech. */
  minLevel: number
  /** A frame is speech when its RMS exceeds the noise floor times this. */
  floorRatio: number
}

/** What one frame changed. */
export type VadEvent =
  /** Speech began: the owner is talking now. */
  | { kind: 'speech-start' }
  /** An utterance ended; `samples` holds it with its pre-roll. */
  | { kind: 'utterance'; samples: Int16Array; durationMs: number }
  /** Speech ended too short to be an utterance. */
  | { kind: 'discarded'; durationMs: number }

/** Smoothing of the noise floor per non-speech frame. */
const FLOOR_ALPHA = 0.05
/** Floor before any frame was heard. */
const INITIAL_FLOOR = 200

/** One call leg's detector; feed it every received frame in order. */
export class VoiceActivityDetector {
  private floor = INITIAL_FLOOR
  private readonly preRoll: Int16Array[] = []
  private readonly speech: Int16Array[] = []
  private onsetFrames = 0
  private silentFrames = 0
  private speaking = false
  private readonly onsetLimit: number
  private readonly endLimit: number
  private readonly preRollLimit: number
  private readonly maxFrames: number

  /** @param config - detection settings. */
  constructor(private readonly config: VadConfig) {
    this.onsetLimit = Math.max(1, Math.round(config.onsetMs / FRAME_MS))
    this.endLimit = Math.max(1, Math.round(config.endSilenceMs / FRAME_MS))
    this.preRollLimit = Math.max(0, Math.round(config.preRollMs / FRAME_MS))
    this.maxFrames = Math.max(this.onsetLimit, Math.round(config.maxUtteranceMs / FRAME_MS))
  }

  /** Whether an utterance is open. */
  get inSpeech(): boolean {
    return this.speaking
  }

  /** Current noise floor (RMS). */
  get noiseFloor(): number {
    return this.floor
  }

  /**
   * Take one frame.
   * @param frame - 20 ms of samples.
   * @returns what the frame started or ended, usually nothing.
   */
  push(frame: Int16Array): VadEvent[] {
    const level = rms(frame)
    const loud = level > Math.max(this.config.minLevel, this.floor * this.config.floorRatio)
    if (!this.speaking) {
      if (loud) {
        this.onsetFrames += 1
        this.speech.push(frame)
        if (this.onsetFrames >= this.onsetLimit) {
          this.speaking = true
          this.silentFrames = 0
          return [{ kind: 'speech-start' }]
        }
        return []
      }
      // A loud run shorter than the onset folds back into the pre-roll.
      for (const pending of this.speech.splice(0)) this.keepPreRoll(pending)
      this.onsetFrames = 0
      this.floor += (level - this.floor) * FLOOR_ALPHA
      this.keepPreRoll(frame)
      return []
    }
    this.speech.push(frame)
    this.silentFrames = loud ? 0 : this.silentFrames + 1
    if (this.silentFrames >= this.endLimit) return [this.finish(this.speech.length - this.silentFrames)]
    if (this.speech.length >= this.maxFrames) return [this.finish(this.speech.length)]
    return []
  }

  /** Drop any open utterance and its pre-roll; the floor is kept. */
  reset(): void {
    this.speech.length = 0
    this.preRoll.length = 0
    this.onsetFrames = 0
    this.silentFrames = 0
    this.speaking = false
  }

  private keepPreRoll(frame: Int16Array): void {
    if (this.preRollLimit === 0) return
    this.preRoll.push(frame)
    if (this.preRoll.length > this.preRollLimit) this.preRoll.shift()
  }

  /** Close the utterance, keeping `voicedFrames` of speech plus the pre-roll. */
  private finish(voicedFrames: number): VadEvent {
    const durationMs = voicedFrames * FRAME_MS
    const frames = [...this.preRoll, ...this.speech.slice(0, voicedFrames)]
    this.reset()
    if (durationMs < this.config.minSpeechMs) return { kind: 'discarded', durationMs }
    const samples = new Int16Array(frames.reduce((total, frame) => total + frame.length, 0))
    let offset = 0
    for (const frame of frames) {
      samples.set(frame, offset)
      offset += frame.length
    }
    return { kind: 'utterance', samples, durationMs }
  }
}
