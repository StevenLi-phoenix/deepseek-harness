import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FRAME_SAMPLES, type PcmAudio } from '../src/audio.ts'
import { Conversation, type ConversationOptions, type SpeechModes } from '../src/conversation.ts'
import type { CallMedia, MediaClosed } from '../src/media.ts'
import type { CallSpeech } from '../src/speech.ts'
import type { TranscriptLine } from '../src/storage.ts'
import type { VadConfig } from '../src/vad.ts'

const VAD: VadConfig = {
  onsetMs: 40, endSilenceMs: 100, minSpeechMs: 60, maxUtteranceMs: 2000, preRollMs: 40, minLevel: 300, floorRatio: 3,
}

/** A media leg that records what the conversation sends and lets the test play the app's side. */
class FakeMedia implements CallMedia {
  readonly frames: Array<{ payload: Buffer; marker: boolean }> = []
  readonly controls: Array<Record<string, unknown>> = []
  private audio: (frame: Int16Array) => void = () => undefined
  private control: (frame: string) => void = () => undefined
  answer(): Promise<string> { return Promise.resolve('') }
  onAudio(listener: (frame: Int16Array) => void): void { this.audio = listener }
  onControl(listener: (frame: string) => void): void { this.control = listener }
  onConnected(): void {}
  onClosed(_listener: (reason: MediaClosed) => void): void {}
  sendFrame(payload: Buffer, marker: boolean): void { this.frames.push({ payload, marker }) }
  sendControl(frame: string): boolean {
    this.controls.push(JSON.parse(frame) as Record<string, unknown>)
    return true
  }
  close(): void {}
  /** The app sends a control message. */
  app(message: Record<string, unknown>): void { this.control(JSON.stringify({ v: 1, ...message })) }
  raw(frame: string): void { this.control(frame) }
  /** The owner's audio arrives: `loud` frames of speech, then `quiet` frames of silence. */
  talk(loud: number, quiet = 0): void {
    for (let index = 0; index < loud; index += 1) this.audio(tone())
    for (let index = 0; index < quiet; index += 1) this.audio(new Int16Array(FRAME_SAMPLES))
  }
  types(): unknown[] { return this.controls.map(control => control['type']) }
  states(): unknown[] { return this.controls.filter(control => control['type'] === 'state').map(control => control['state']) }
}

function tone(): Int16Array {
  const frame = new Int16Array(FRAME_SAMPLES)
  for (let index = 0; index < frame.length; index += 1) frame[index] = Math.round(8000 * Math.sin(index / 3))
  return frame
}

/** Speech whose synthesis the test resolves piece by piece. */
function fakeSpeech(options: { maxChars?: number } = {}) {
  const pending: Array<{ text: string; signal: AbortSignal; resolve: (audio: PcmAudio) => void; reject: (error: unknown) => void }> = []
  const transcribe = vi.fn(async (_audio: PcmAudio, _signal: AbortSignal): Promise<string> => '你好')
  const speech: CallSpeech = {
    name: 'fake',
    maxChars: options.maxChars ?? 200,
    transcribe,
    synthesize: (text, signal) => new Promise<PcmAudio>((resolve, reject) => { pending.push({ text, signal, resolve, reject }) }),
  }
  /** One 40 ms piece at 16 kHz, resampled to two call frames. */
  const audio = (): PcmAudio => ({ samples: new Int16Array(640).fill(1000), sampleRate: 16_000 })
  return { speech, pending, transcribe, audio }
}

const logs: Array<[string, string]> = []

function conversation(modes: SpeechModes, overrides: Partial<ConversationOptions> = {}) {
  const media = new FakeMedia()
  const lines: TranscriptLine[] = []
  const prompts: string[] = []
  const hangup = vi.fn()
  const fake = fakeSpeech()
  const options: ConversationOptions = {
    media,
    modes,
    speech: fake.speech,
    vad: VAD,
    bargeIn: true,
    maxUtteranceChars: 10,
    prompt: async (text) => { prompts.push(text) },
    record: (line) => { lines.push(line) },
    hangup,
    log: (level, message) => { logs.push([level, message]) },
    now: Date.now,
    ...overrides,
  }
  const talk = new Conversation(options)
  return { talk, media, lines, prompts, hangup, ...fake }
}

const settle = async (ms = 0): Promise<void> => { await vi.advanceTimersByTimeAsync(ms) }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
  vi.setSystemTime(new Date('2026-11-25T12:00:00.000Z'))
  logs.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Conversation with speech on the device', () => {
  it('prompts what the app recognized, records it, and shows the agent thinking', async () => {
    const h = conversation({ stt: 'device', tts: 'device' })
    h.talk.start()
    h.media.app({ type: 'utterance', text: '  帮我查一下明天的天气好吗  ' })
    h.media.app({ type: 'utterance', text: '   ' })
    await settle()
    // Cut to maxUtteranceChars code points.
    expect(h.prompts).toEqual(['帮我查一下明天的天气'])
    expect(h.lines).toEqual([{ role: 'owner', text: '帮我查一下明天的天气', at: Date.now() }])
    expect(h.media.controls).toEqual([
      { v: 1, type: 'state', state: 'listening' },
      { v: 1, type: 'transcript', role: 'owner', text: '帮我查一下明天的天气' },
      { v: 1, type: 'state', state: 'thinking' },
    ])
  })

  it('has the app speak each answer and stop when the owner talks over it', async () => {
    const h = conversation({ stt: 'device', tts: 'device' })
    h.talk.start()
    h.talk.turnStarted()
    await h.talk.say('**好的**，明天[晴天](https://weather.example)。')
    expect(h.media.controls.slice(-3)).toEqual([
      { v: 1, type: 'state', state: 'thinking' },
      { v: 1, type: 'transcript', role: 'agent', text: '好的，明天晴天。' },
      { v: 1, type: 'say', text: '好的，明天晴天。' },
    ])
    h.media.app({ type: 'speaking' })
    expect(h.media.controls.at(-1)).toEqual({ v: 1, type: 'stop-speaking' })
    h.talk.turnSettled()
    await h.talk.say('还有别的吗')
    expect(h.media.states()).toEqual(['listening', 'thinking', 'listening'])
    expect(h.lines.map(line => line.role)).toEqual(['agent', 'agent'])
  })

  it('says nothing for an answer that is only markup', async () => {
    const h = conversation({ stt: 'device', tts: 'device' })
    h.talk.start()
    await h.talk.say('```\ncode\n```')
    expect(h.media.types()).toEqual(['state'])
    expect(h.lines).toEqual([])
  })

  it('ignores recognized text from the app when the service recognizes speech itself, and frames it does not know', async () => {
    const h = conversation({ stt: 'server', tts: 'device' })
    h.talk.start()
    h.media.app({ type: 'utterance', text: 'hello' })
    h.media.raw('not json')
    h.media.app({ type: 'future-type' })
    await settle()
    expect(h.prompts).toEqual([])
    expect(logs.filter(([level]) => level === 'debug').map(([, message]) => message)).toEqual([
      'voice-call: ignored a control frame of 8 chars',
      'voice-call: ignored a control frame of 28 chars',
    ])
  })

  it('stops the agent on the interrupt button even without barge-in, and hangs up when the app asks', () => {
    const h = conversation({ stt: 'device', tts: 'device' }, { bargeIn: false })
    h.talk.start()
    h.media.app({ type: 'speaking' })
    expect(h.media.types()).toEqual(['state'])
    h.media.app({ type: 'interrupt' })
    expect(h.media.types()).toEqual(['state', 'stop-speaking'])
    h.media.app({ type: 'hangup' })
    expect(h.hangup).toHaveBeenCalledOnce()
  })

  it('stops the agent when the line hears the owner start talking, and drops what it hears otherwise', async () => {
    const h = conversation({ stt: 'device', tts: 'device' })
    h.talk.start()
    h.media.talk(4, 6)
    await settle()
    expect(h.media.types()).toContain('stop-speaking')
    expect(h.prompts).toEqual([])
    expect(h.transcribe).not.toHaveBeenCalled()
  })
})

describe('Conversation with speech on the service', () => {
  it('needs a speech provider', () => {
    expect(() => conversation({ stt: 'server', tts: 'device' }, { speech: undefined })).toThrow('a server speech mode needs a speech provider')
    expect(() => conversation({ stt: 'device', tts: 'server' }, { speech: undefined })).toThrow('a server speech mode needs a speech provider')
  })

  it('recognizes each utterance in order and prompts it', async () => {
    const h = conversation({ stt: 'server', tts: 'server' })
    h.transcribe.mockResolvedValueOnce('第一句').mockResolvedValueOnce('第二句')
    h.talk.start()
    h.media.talk(5, 6)
    h.media.talk(5, 6)
    await settle()
    expect(h.transcribe).toHaveBeenCalledTimes(2)
    expect(h.transcribe.mock.calls[0]![0].sampleRate).toBe(8000)
    expect(h.prompts).toEqual(['第一句', '第二句'])
    expect(logs.some(([level, message]) => level === 'info' && /^voice-call: recognized 100 ms of speech as 3 chars in \d+ ms$/u.test(message))).toBe(true)
  })

  it('logs a sound too short to be speech, and a failed recognition', async () => {
    const h = conversation({ stt: 'server', tts: 'server' })
    h.transcribe.mockRejectedValueOnce(new Error('asr down'))
    h.talk.start()
    h.media.talk(2, 6)
    h.media.talk(5, 6)
    await settle()
    expect(logs).toContainEqual(['debug', 'voice-call: dropped 40 ms of sound as too short'])
    expect(logs).toContainEqual(['warn', 'voice-call: recognition failed: asr down'])
    expect(h.prompts).toEqual([])
  })

  it('drops recognition that finishes after the call ended, and never starts the next one', async () => {
    const h = conversation({ stt: 'server', tts: 'server' })
    let finish!: (text: string) => void
    h.transcribe.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve }))
    h.talk.start()
    h.media.talk(5, 6)
    h.media.talk(5, 6)
    await settle()
    h.talk.stop()
    finish('太晚了')
    await settle()
    expect(h.prompts).toEqual([])
    expect(h.transcribe).toHaveBeenCalledOnce()
  })

  it('does not report recognition the hang-up aborted', async () => {
    const h = conversation({ stt: 'server', tts: 'server' })
    let fail!: (error: Error) => void
    h.transcribe.mockImplementationOnce(() => new Promise<string>((_resolve, reject) => { fail = reject }))
    h.talk.start()
    h.media.talk(5, 6)
    await settle()
    h.talk.stop()
    fail(new Error('aborted'))
    await settle()
    expect(logs.filter(([level]) => level === 'warn')).toEqual([])
  })

  it('goes back to thinking after barge-in while a turn still runs', async () => {
    const h = conversation({ stt: 'server', tts: 'server' })
    h.talk.start()
    h.talk.turnStarted()
    const spoken = h.talk.say('一句话')
    await settle()
    h.media.app({ type: 'interrupt' })
    h.pending[0]!.reject(new Error('aborted'))
    await spoken
    expect(h.media.states()).toEqual(['listening', 'thinking', 'speaking', 'thinking'])
    h.talk.stop()
  })

  it('keeps listening without barge-in while the owner talks', async () => {
    const h = conversation({ stt: 'server', tts: 'server' }, { bargeIn: false })
    h.talk.start()
    const spoken = h.talk.say('一句话')
    await settle()
    h.media.talk(3)
    await settle()
    expect(h.pending[0]!.signal.aborted).toBe(false)
    h.pending[0]!.resolve(h.audio())
    await settle(100)
    await spoken
    h.talk.stop()
  })

  it('speaks an answer sentence by sentence, synthesizing the next one while the first plays', async () => {
    const h = conversation({ stt: 'server', tts: 'server' })
    h.talk.start()
    h.talk.turnStarted()
    const spoken = h.talk.say('第一句。第二句。')
    await settle()
    expect(h.pending.map(piece => piece.text)).toEqual(['第一句。'])
    h.pending[0]!.resolve(h.audio())
    await settle()
    expect(h.pending.map(piece => piece.text)).toEqual(['第一句。', '第二句。'])
    expect(h.media.states()).toEqual(['listening', 'thinking', 'speaking'])
    h.pending[1]!.resolve(h.audio())
    await settle(200)
    await spoken
    const voiced = h.media.frames.filter(frame => frame.payload.some(byte => byte !== 0xff))
    expect(voiced).toHaveLength(4)
    expect(h.media.frames.filter(frame => frame.marker)).toHaveLength(1)
    expect(h.media.states().at(-1)).toBe('thinking')
    h.talk.turnSettled()
    expect(h.media.states().at(-1)).toBe('listening')
    h.talk.stop()
  })

  it('stops talking at once when the owner starts speaking over it', async () => {
    const h = conversation({ stt: 'server', tts: 'server' })
    h.talk.start()
    const spoken = h.talk.say('第一句。第二句。')
    await settle()
    h.pending[0]!.resolve(h.audio())
    await settle()
    h.media.talk(3)
    await settle()
    expect(h.pending[1]!.signal.aborted).toBe(true)
    h.pending[1]!.reject(new Error('aborted'))
    await spoken
    expect(logs).toContainEqual(['info', 'voice-call: barge-in (speech); the agent stops talking'])
    expect(h.media.states()).toEqual(['listening', 'speaking', 'listening'])
    expect(logs.filter(([level]) => level === 'warn')).toEqual([])
    h.talk.stop()
  })

  it('drops synthesized audio that arrives after barge-in', async () => {
    const h = conversation({ stt: 'device', tts: 'server' })
    h.talk.start()
    const spoken = h.talk.say('只有一句')
    await settle()
    h.media.app({ type: 'interrupt' })
    h.pending[0]!.resolve(h.audio())
    await spoken
    expect(h.media.frames.filter(frame => frame.payload.some(byte => byte !== 0xff))).toEqual([])
    h.talk.stop()
  })

  it('logs a failed synthesis and goes back to listening', async () => {
    const h = conversation({ stt: 'server', tts: 'server' })
    h.talk.start()
    const spoken = h.talk.say('一句话')
    await settle()
    h.pending[0]!.reject(new Error('tts down'))
    await spoken
    expect(logs).toContainEqual(['warn', 'voice-call: speaking 3 chars failed: tts down'])
    expect(h.media.states()).toEqual(['listening', 'speaking', 'listening'])
  })

  it('keeps the owner waiting quietly when the call ends during speech', async () => {
    const h = conversation({ stt: 'server', tts: 'server' })
    h.talk.start()
    const spoken = h.talk.say('一句话')
    await settle()
    h.talk.stop()
    h.pending[0]!.reject(new Error('the call ended'))
    await spoken
    await h.talk.say('之后的话')
    expect(h.pending).toHaveLength(1)
    expect(logs.filter(([level]) => level === 'warn')).toEqual([])
    expect(h.media.states()).toEqual(['listening', 'speaking'])
  })
})

describe('Conversation hooks', () => {
  it('opens with a prompt and shows thinking until the turn settles; a failed opening goes back to listening', async () => {
    const h = conversation({ stt: 'device', tts: 'device' })
    h.talk.start()
    h.talk.open(async () => { throw 'session gone' })
    await settle()
    expect(h.media.states()).toEqual(['listening', 'thinking', 'listening'])
    expect(logs).toContainEqual(['warn', 'voice-call: the opening prompt failed: session gone'])
  })

  it('reports a failed prompt and listens again unless a turn is running', async () => {
    const failing = vi.fn(async (_text: string): Promise<void> => { throw new Error('busy') })
    const h = conversation({ stt: 'device', tts: 'device' }, { prompt: failing })
    h.talk.start()
    h.media.app({ type: 'utterance', text: '一' })
    await settle()
    expect(h.media.states()).toEqual(['listening', 'thinking', 'listening'])
    h.talk.turnStarted()
    h.media.app({ type: 'utterance', text: '二' })
    await settle()
    expect(h.media.states()).toEqual(['listening', 'thinking', 'listening', 'thinking'])
    expect(logs.filter(([level]) => level === 'warn')).toHaveLength(2)
    // A turn starting while the agent is not listening leaves the shown state alone.
    h.talk.turnStarted()
    expect(h.media.states()).toHaveLength(4)
  })

  it('keeps speaking later answers after one failed', async () => {
    let fail = true
    const h = conversation({ stt: 'device', tts: 'device' }, {
      record: () => {
        if (fail) {
          fail = false
          throw new Error('disk full')
        }
      },
    })
    h.talk.start()
    await expect(h.talk.say('一')).rejects.toThrow('disk full')
    await h.talk.say('二')
    expect(h.media.controls.at(-1)).toEqual({ v: 1, type: 'say', text: '二' })
  })

  it('leaves a listening state alone when a turn settles', () => {
    const h = conversation({ stt: 'device', tts: 'device' })
    h.talk.start()
    h.talk.turnSettled()
    expect(h.media.states()).toEqual(['listening'])
  })

  it('sends no control frame after the call ended', () => {
    const h = conversation({ stt: 'device', tts: 'device' })
    h.talk.start()
    h.talk.stop()
    h.media.app({ type: 'interrupt' })
    expect(h.media.types()).toEqual(['state'])
  })

  it('sends nothing and hears nothing once stopped; stopping twice is harmless', async () => {
    const h = conversation({ stt: 'server', tts: 'server' })
    h.talk.start()
    h.talk.stop()
    h.talk.stop()
    h.media.talk(5, 6)
    h.media.app({ type: 'utterance', text: 'hi' })
    await h.talk.say('hi')
    await settle()
    expect(h.media.controls).toHaveLength(1)
    expect(h.transcribe).not.toHaveBeenCalled()
  })
})
