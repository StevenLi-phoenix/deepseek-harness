import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpeakResult, TranscribeResult, VoiceSummary } from '@deepseek-ai/dsh-voice'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readWav, resample, writeWav, type PcmAudio } from '../src/audio.ts'
import { sentences, spokenText, voiceSpeech } from '../src/speech.ts'

const summary: VoiceSummary = {
  tts: { enabled: true, provider: 'feiyu', fallback: 'none', format: 'mp3', maxChars: 150, url: 'http://tts.invalid' },
  asr: { enabled: true, engine: 'funasr', url: 'http://asr.invalid' },
}

function resampleTo(audio: PcmAudio, rate: number): PcmAudio {
  return { samples: resample(audio.samples, audio.sampleRate, rate), sampleRate: rate }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'voice-call-speech-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function speakResult(path: string, format: 'mp3' | 'wav'): SpeakResult {
  return { path, format, bytes: 1, provider: 'feiyu', elapsedMs: 1 }
}

describe('the built-in speech provider', () => {
  it('takes its name and length limit from the voice service', () => {
    const speech = voiceSpeech({
      describe: () => summary,
      speak: () => Promise.reject(new Error('unused')),
      transcribe: () => Promise.reject(new Error('unused')),
    }, dir, resampleTo)
    expect(speech.name).toBe('voice')
    expect(speech.maxChars).toBe(150)
  })

  it('hands the utterance to the asr-service as a 16 kHz WAV and deletes it afterwards', async () => {
    const scratch = join(dir, 'scratch', 'nested')
    let seen: { path: string; audio: PcmAudio; signal: AbortSignal | undefined } | undefined
    const speech = voiceSpeech({
      describe: () => summary,
      speak: () => Promise.reject(new Error('unused')),
      async transcribe(path, options): Promise<TranscribeResult> {
        seen = { path, audio: readWav(await readFile(path)), signal: options?.signal }
        return { text: '  hello there \n', engine: 'funasr', rawPath: '/raw', elapsedMs: 1 }
      },
    }, scratch, resampleTo)
    const controller = new AbortController()
    const text = await speech.transcribe({ samples: new Int16Array(800).fill(1000), sampleRate: 8000 }, controller.signal)
    expect(text).toBe('hello there')
    expect(seen?.path.startsWith(scratch)).toBe(true)
    expect(seen?.path).toMatch(/\.wav$/u)
    expect(seen?.audio.sampleRate).toBe(16_000)
    expect(seen?.audio.samples).toHaveLength(1600)
    expect(seen?.signal).toBe(controller.signal)
    expect(readdirSync(scratch)).toEqual([])
  })

  it('deletes the utterance file when transcription fails', async () => {
    const speech = voiceSpeech({
      describe: () => summary,
      speak: () => Promise.reject(new Error('unused')),
      transcribe: () => Promise.reject(new Error('asr down')),
    }, dir, resampleTo)
    await expect(speech.transcribe({ samples: new Int16Array(160), sampleRate: 8000 }, new AbortController().signal)).rejects.toThrow('asr down')
    expect(readdirSync(dir)).toEqual([])
  })

  it('still answers when the utterance file is already gone', async () => {
    const speech = voiceSpeech({
      describe: () => summary,
      speak: () => Promise.reject(new Error('unused')),
      async transcribe(path): Promise<TranscribeResult> {
        rmSync(path)
        return { text: 'ok', engine: 'funasr', rawPath: '/raw', elapsedMs: 1 }
      },
    }, dir, resampleTo)
    await expect(speech.transcribe({ samples: new Int16Array(160), sampleRate: 8000 }, new AbortController().signal)).resolves.toBe('ok')
  })

  it('reads the WAV written beside an MP3 answer', async () => {
    const mp3 = join(dir, 'answer.mp3')
    writeFileSync(mp3, 'not audio')
    writeFileSync(join(dir, 'answer.wav'), writeWav({ samples: Int16Array.from([1, 2, 3]), sampleRate: 24_000 }))
    let signal: AbortSignal | undefined
    const speech = voiceSpeech({
      describe: () => summary,
      speak: (text, options) => {
        expect(text).toBe('Hi.')
        signal = options?.signal
        return Promise.resolve(speakResult(mp3, 'mp3'))
      },
      transcribe: () => Promise.reject(new Error('unused')),
    }, dir, resampleTo)
    const controller = new AbortController()
    const audio = await speech.synthesize('Hi.', controller.signal)
    expect(audio.sampleRate).toBe(24_000)
    expect(Array.from(audio.samples)).toEqual([1, 2, 3])
    expect(signal).toBe(controller.signal)
  })

  it('reads a WAV answer itself', async () => {
    const wav = join(dir, 'answer.wav')
    writeFileSync(wav, writeWav({ samples: Int16Array.from([9]), sampleRate: 16_000 }))
    const speech = voiceSpeech({
      describe: () => summary,
      speak: () => Promise.resolve(speakResult(wav, 'wav')),
      transcribe: () => Promise.reject(new Error('unused')),
    }, dir, resampleTo)
    expect(Array.from((await speech.synthesize('x', new AbortController().signal)).samples)).toEqual([9])
    expect(existsSync(wav)).toBe(true)
  })
})

describe('spoken text', () => {
  it('removes Markdown marks, links, images, code, and URLs', () => {
    const answer = [
      '# Title',
      '',
      'Here is **bold**, _italic_ and ~~gone~~ text.',
      'See [the docs](https://example.com/docs) and ![a chart](chart.png) here.',
      '- first item',
      '* second item',
      '+ third item',
      '2) numbered item',
      '> quoted line',
      'Run `pnpm test` now.',
      '```ts',
      'const secret = 1',
      '```',
      'Visit https://example.com/path?q=1 today.',
    ].join('\n')
    expect(spokenText(answer)).toBe([
      'Title',
      'Here is bold, italic and gone text.',
      'See the docs and here.',
      'first item',
      'second item',
      'third item',
      'numbered item',
      'quoted line',
      'Run pnpm test now.',
      'Visit today.',
    ].join('\n'))
  })

  it('removes emoji and their variation selectors and collapses spaces', () => {
    expect(spokenText('Done 🎉  and   ok 👍️ !')).toBe('Done and ok !')
  })

  it('is empty for an answer that is only marks', () => {
    expect(spokenText('```\ncode\n```\n\n🎉')).toBe('')
  })
})

describe('sentence cutting', () => {
  it('splits at Chinese and English sentence ends', () => {
    expect(sentences('你好。今天怎么样？很好！Yes. Really? Wow! Go; 分号；完', 100)).toEqual(['你好。', '今天怎么样？', '很好！', 'Yes.', 'Really?', 'Wow!', 'Go;', '分号；', '完'])
  })

  it('splits at new lines and at an ellipsis, but not at a dot inside a word', () => {
    expect(sentences('First line\nsecond line…third\n\nv1.2 works.', 100)).toEqual(['First line', 'second line…', 'third', 'v1.2 works.'])
  })

  it('drops empty pieces', () => {
    expect(sentences('', 10)).toEqual([])
    expect(sentences('。。\n\n  ', 10)).toEqual(['。', '。'])
  })

  it('cuts a long sentence at the last comma or space of the allowed length', () => {
    expect(sentences('one two three, four five six seven eight', 20)).toEqual(['one two three, four', 'five six seven eight'])
    expect(sentences('alpha beta,gammadeltaepsilon', 14)).toEqual(['alpha beta,', 'gammadeltaepsi', 'lon'])
    expect(sentences('第一部分内容，第二部分内容，第三部分', 10)).toEqual(['第一部分内容，', '第二部分内容，', '第三部分'])
  })

  it('cuts anywhere when no comma falls past the first third', () => {
    expect(sentences('a,bcdefghijklmnopqrst', 10)).toEqual(['a,bcdefghi', 'jklmnopqrs', 't'])
    expect(sentences('abcdefghijklmnopqrstuvwxyz', 10)).toEqual(['abcdefghij', 'klmnopqrst', 'uvwxyz'])
  })

  it('counts code points, not UTF-16 units', () => {
    expect(sentences('😀😀😀😀😀', 5)).toEqual(['😀😀😀😀😀'])
  })
})
