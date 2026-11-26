import { describe, expect, it } from 'vitest'
import { FRAME_SAMPLES } from '../src/audio.ts'
import { VoiceActivityDetector, type VadConfig, type VadEvent } from '../src/vad.ts'

const config: VadConfig = {
  onsetMs: 60,
  endSilenceMs: 100,
  minSpeechMs: 200,
  maxUtteranceMs: 1000,
  preRollMs: 40,
  minLevel: 500,
  floorRatio: 3,
}

/** A frame of constant level whose first sample marks which frame it is. */
function frame(level: number, tag = 0): Int16Array {
  const samples = new Int16Array(FRAME_SAMPLES).fill(level)
  samples[0] = tag === 0 ? level : tag
  return samples
}

const quiet = (tag?: number): Int16Array => frame(50, tag)
const loud = (tag?: number): Int16Array => frame(5000, tag)

function feed(vad: VoiceActivityDetector, frames: Int16Array[]): VadEvent[] {
  return frames.flatMap(each => vad.push(each))
}

describe('voice-activity detection', () => {
  it('starts speech only after the onset run and reports it once', () => {
    const vad = new VoiceActivityDetector(config)
    expect(vad.push(loud())).toEqual([])
    expect(vad.push(loud())).toEqual([])
    expect(vad.inSpeech).toBe(false)
    expect(vad.push(loud())).toEqual([{ kind: 'speech-start' }])
    expect(vad.inSpeech).toBe(true)
    expect(vad.push(loud())).toEqual([])
  })

  it('emits an utterance with its pre-roll once the silence lasts long enough', () => {
    const vad = new VoiceActivityDetector(config)
    feed(vad, [quiet(1), quiet(2), quiet(3)])
    const speech = Array.from({ length: 12 }, (_, index) => loud(100 + index))
    const events = feed(vad, [...speech, quiet(), quiet(), quiet(), quiet()])
    expect(events.map(event => event.kind)).toEqual(['speech-start'])
    const [ended] = vad.push(quiet())
    expect(ended?.kind).toBe('utterance')
    if (ended?.kind !== 'utterance') return
    expect(ended.durationMs).toBe(12 * 20)
    // Two pre-roll frames (the last two quiet ones), then the twelve voiced frames; trailing silence is dropped.
    const tags = Array.from({ length: ended.samples.length / FRAME_SAMPLES }, (_, index) => ended.samples[index * FRAME_SAMPLES])
    expect(tags).toEqual([2, 3, ...speech.map((_, index) => 100 + index)])
    expect(vad.inSpeech).toBe(false)
  })

  it('keeps an utterance open through pauses shorter than the end silence', () => {
    const vad = new VoiceActivityDetector({ ...config, preRollMs: 0 })
    const run = (make: () => Int16Array, count: number): Int16Array[] => Array.from({ length: count }, make)
    const events = feed(vad, [...run(loud, 3), ...run(quiet, 2), ...run(loud, 7), ...run(quiet, 5)])
    const utterance = events.find(event => event.kind === 'utterance')
    expect(utterance).toMatchObject({ kind: 'utterance', durationMs: 12 * 20 })
    if (utterance?.kind === 'utterance') expect(utterance.samples).toHaveLength(12 * FRAME_SAMPLES)
  })

  it('discards speech shorter than the minimum', () => {
    const vad = new VoiceActivityDetector(config)
    const events = feed(vad, [loud(), loud(), loud(), quiet(), quiet(), quiet(), quiet(), quiet()])
    expect(events).toEqual([{ kind: 'speech-start' }, { kind: 'discarded', durationMs: 60 }])
    expect(vad.inSpeech).toBe(false)
  })

  it('cuts an utterance at the maximum length', () => {
    const vad = new VoiceActivityDetector({ ...config, preRollMs: 0 })
    const events = feed(vad, [quiet(), quiet(), ...Array.from({ length: 50 }, () => loud())])
    expect(events).toEqual([{ kind: 'speech-start' }, expect.objectContaining({ kind: 'utterance', durationMs: 1000 })])
    // Without a pre-roll the utterance holds the voiced frames alone.
    expect(events[1]).toHaveProperty('samples.length', 50 * FRAME_SAMPLES)
    expect(vad.inSpeech).toBe(false)
  })

  it('folds a loud run shorter than the onset back into the pre-roll', () => {
    const vad = new VoiceActivityDetector({ ...config, preRollMs: 100 })
    feed(vad, [loud(7), loud(8), quiet(9)])
    expect(vad.inSpeech).toBe(false)
    const events = feed(vad, [...Array.from({ length: 12 }, () => loud()), quiet(), quiet(), quiet(), quiet(), quiet()])
    const utterance = events.find(event => event.kind === 'utterance')
    expect(utterance?.kind).toBe('utterance')
    if (utterance?.kind !== 'utterance') return
    const tags = utterance.samples.subarray(0, 3 * FRAME_SAMPLES).filter((_, index) => index % FRAME_SAMPLES === 0)
    expect(Array.from(tags)).toEqual([7, 8, 9])
  })

  it('raises its threshold with the noise floor so steady noise is not speech', () => {
    const vad = new VoiceActivityDetector(config)
    expect(vad.noiseFloor).toBe(200)
    const noise = frame(1200)
    expect(feed(new VoiceActivityDetector(config), [noise, noise, noise])).toEqual([{ kind: 'speech-start' }])
    // A hum under the minimum level never counts as speech but lifts the floor towards its own level.
    for (let round = 0; round < 200; round += 1) vad.push(frame(450))
    expect(vad.noiseFloor).toBeGreaterThan(400)
    expect(feed(vad, [noise, noise, noise, noise])).toEqual([])
    expect(vad.inSpeech).toBe(false)
  })

  it('drops an open utterance on reset and starts over', () => {
    const vad = new VoiceActivityDetector(config)
    feed(vad, [quiet(), loud(), loud(), loud()])
    expect(vad.inSpeech).toBe(true)
    vad.reset()
    expect(vad.inSpeech).toBe(false)
    expect(feed(vad, [quiet(), quiet(), quiet(), quiet(), quiet(), quiet()])).toEqual([])
  })

  it('treats zero durations as single frames', () => {
    const vad = new VoiceActivityDetector({ ...config, onsetMs: 0, endSilenceMs: 0, maxUtteranceMs: 0, minSpeechMs: 0, preRollMs: 0 })
    expect(vad.push(loud())).toEqual([{ kind: 'speech-start' }])
    expect(vad.push(quiet())).toEqual([expect.objectContaining({ kind: 'utterance', durationMs: 20 })])
  })
})
