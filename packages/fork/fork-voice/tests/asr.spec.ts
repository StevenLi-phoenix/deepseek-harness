import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { isAudioName, transcribeAudio } from '../src/asr.ts'
import { FakeVoiceHost, wavBytes } from './fake-voice.ts'

const host = new FakeVoiceHost()
let url = ''
beforeAll(async () => { url = await host.start() })
afterAll(async () => { await host.stop() })
beforeEach(() => { host.seen.length = 0; host.failNext = {} })

const options = (extra: Record<string, unknown> = {}) => ({
  baseUrl: `${url}/asr`, engine: 'funasr' as const, call: { timeoutMs: 2000, retries: 1, retryDelayMs: 1, sleep: async () => {} }, ...extra,
})

describe('transcribeAudio', () => {
  it('stores the raw answer before parsing and returns the text', async () => {
    const audio = wavBytes(250, 7)
    host.transcripts.set(host.sha(audio).slice(0, 8), '今天天气不错')
    const order: string[] = []
    const transcript = await transcribeAudio('note.wav', audio, options(), async (raw) => { order.push(`raw:${(JSON.parse(raw) as { full_text: string }).full_text}`) })
    order.push('returned')
    expect(order).toEqual(['raw:今天天气不错', 'returned'])
    expect(transcript).toEqual({ text: '今天天气不错', engine: 'funasr', durationS: 0.3 })
  })

  it('sends the engine and the language hint', async () => {
    await transcribeAudio('en.mp3', wavBytes(), options({ engine: 'whisper', language: 'en' }), async () => {})
    const body = host.requests('/asr/transcribe')[0]!.body.toString('latin1')
    expect(body).toMatch(/name="engine"\r\n\r\nwhisper/)
    expect(body).toMatch(/name="language"\r\n\r\nen/)
    expect(body).toContain('filename="en.mp3"')
  })

  it('refuses a format the service cannot read, without calling it', async () => {
    await expect(transcribeAudio('voice.silk', Buffer.from('x'), options(), async () => {})).rejects.toThrow('not an audio format')
    expect(host.seen).toHaveLength(0)
  })

  it('fails when the answer has no full_text, after keeping it', async () => {
    host.asrRaw = '{"detail":"odd"}'
    const kept: string[] = []
    await expect(transcribeAudio('a.wav', wavBytes(), options(), async (raw) => { kept.push(raw) })).rejects.toThrow('no full_text')
    expect(kept).toEqual(['{"detail":"odd"}'])
    host.asrRaw = 'not json'
    await expect(transcribeAudio('a.wav', wavBytes(), options(), async () => {})).rejects.toThrow('not JSON')
    host.asrRaw = undefined
  })

  it('recognises the formats the service reads', () => {
    expect(isAudioName('A.M4A')).toBe(true)
    expect(isAudioName('a.silk')).toBe(false)
  })
})
