import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import LsyVoice, { Config, VoiceError } from '../src/index.ts'
import { FakeVoiceHost, wavBytes } from './fake-voice.ts'

const FFMPEG = '/opt/homebrew/bin/ffmpeg'
const host = new FakeVoiceHost()
let url = ''
const contexts: Context[] = []
const dirs: string[] = []

beforeAll(async () => { url = await host.start() })
afterAll(async () => { await host.stop() })
beforeEach(() => {
  host.seen.length = 0
  host.failNext = {}
  host.feiyuStatuses = ['success']
  host.asrRaw = undefined
})
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Log { type: string; text: string }

async function mount(overrides: Record<string, unknown> = {}, keys: Record<string, string> = { LSY_FEIYU_API_KEY: 'feiyu-key' }) {
  const dir = mkdtempSync(join(tmpdir(), 'lsy-voice-'))
  dirs.push(dir)
  const ctx = new Context()
  contexts.push(ctx)
  const logs: Log[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push({ type: message.type, text: String(message.args[0]) }) } })
  ctx.provide('credentials', { resolve: async (ref: string) => (keys[ref] === undefined ? undefined : { value: keys[ref], source: 'env' }) } as never)
  const tts = {
    format: 'wav', retryDelayMs: 1, retries: 1,
    feiyu: { baseUrl: `${url}/feiyu`, pollMs: 100 },
    macMini: { baseUrl: `${url}/mini` },
    ...(overrides.tts as object | undefined),
  }
  const asr = { baseUrl: `${url}/asr`, retryDelayMs: 1, retries: 1, ...(overrides.asr as object | undefined) }
  const { tts: _t, asr: _a, ...rest } = overrides
  await ctx.plugin(LsyVoice, Config({ dataDir: dir, tts, asr, ...rest } as never))
  return { ctx, voice: ctx.lsyVoice, dir, logs }
}

describe('speak', () => {
  it('writes the provider answer to disk, returns the file, and logs it without the text', async () => {
    const { voice, dir, logs } = await mount()
    const result = await voice.speak('今天一切正常。')
    expect(result).toMatchObject({ format: 'wav', provider: 'feiyu' })
    expect(result.path.startsWith(join(dir, 'audio'))).toBe(true)
    expect(readFileSync(result.path).equals(host.audio)).toBe(true)
    const files = readdirSync(join(dir, 'audio'))
    expect(files.some(name => name.endsWith('.job.json'))).toBe(true)
    expect(statSync(result.path).mode & 0o777).toBe(0o600)
    expect(logs.some(line => line.type === 'info' && line.text.startsWith('lsy-voice: spoke 7 chars with feiyu in '))).toBe(true)
    expect(logs.filter(line => line.text.includes('今天一切正常'))).toEqual([])
    expect(logs.some(line => line.text.includes('feiyu-key'))).toBe(false)
  })

  it('converts to mp3 when asked and ffmpeg works', async () => {
    const { voice } = await mount({ tts: { format: 'mp3', ffmpegPath: FFMPEG } })
    const result = await voice.speak('你好')
    expect(result.format).toBe('mp3')
    expect(result.path.endsWith('.mp3')).toBe(true)
    expect(execFileSync(FFMPEG, ['-v', 'error', '-i', result.path, '-f', 'null', '-']).length).toBe(0)
  })

  it('delivers the WAV and warns when the mp3 conversion fails', async () => {
    const { voice, logs } = await mount({ tts: { format: 'mp3', ffmpegPath: '/nonexistent/ffmpeg' } })
    const result = await voice.speak('你好')
    expect(result.format).toBe('wav')
    expect(logs.some(line => line.type === 'warn' && line.text.startsWith('lsy-voice: converting to mp3 failed'))).toBe(true)
  })

  it('falls back to the second provider and says why', async () => {
    host.failNext.feiyu = [500, 500]
    const { voice, logs } = await mount()
    const result = await voice.speak('你好')
    expect(result.provider).toBe('mac-mini')
    expect(result.fellBackFrom).toContain('feiyu: feiyu POST /v1/speech answered HTTP 500')
    expect(logs.some(line => line.type === 'warn' && line.text.includes('feiyu could not speak'))).toBe(true)
    expect(logs.some(line => line.text.includes('retrying feiyu after attempt 1'))).toBe(true)
  })

  it('stops after one provider when fallback is none, and the provider order is configurable', async () => {
    host.failNext.feiyu = [500, 500]
    const { voice } = await mount({ tts: { fallback: 'none' } })
    await expect(voice.speak('你好')).rejects.toThrow(/^speech failed \(feiyu: /)
    expect(host.requests('/mini/synthesize')).toHaveLength(0)
    const mini = await mount({ tts: { provider: 'mac-mini', fallback: 'feiyu' } })
    expect((await mini.voice.speak('你好')).provider).toBe('mac-mini')
  })

  it('reports every provider failure when all fail, as an error log', async () => {
    host.failNext.feiyu = [500, 500]
    host.failNext.mini = [500, 500]
    const { voice, logs } = await mount()
    await expect(voice.speak('你好')).rejects.toThrow(/feiyu: .*; mac-mini: /)
    expect(logs.some(line => line.type === 'error' && line.text.startsWith('lsy-voice: no provider could speak'))).toBe(true)
  })

  it('refuses when off, empty, or too long, without calling a service', async () => {
    const off = await mount({ tts: { enabled: false } })
    await expect(off.voice.speak('hi')).rejects.toThrow('turned off')
    const { voice } = await mount({ tts: { maxChars: 5 } })
    await expect(voice.speak('   ')).rejects.toThrow('no text')
    await expect(voice.speak('一二三四五六')).rejects.toThrow('6 characters; speech takes at most 5')
    expect(host.seen).toHaveLength(0)
  })

  it('runs calls one at a time', async () => {
    host.feiyuStatuses = ['running', 'success']
    const { voice } = await mount()
    const [a, b] = await Promise.all([voice.speak('一'), voice.speak('二')])
    expect(a.path).not.toBe(b.path)
    const order = host.seen.filter(item => item.path === '/feiyu/v1/speech' || item.path === '/feiyu/v1/jobs/job1/audio').map(item => item.path)
    expect(order).toEqual(['/feiyu/v1/speech', '/feiyu/v1/jobs/job1/audio', '/feiyu/v1/speech', '/feiyu/v1/jobs/job1/audio'])
  })

  it('removes files older than keepDays', async () => {
    const { voice, dir } = await mount({ keepDays: 2 })
    const first = await voice.speak('旧的')
    const old = new Date(Date.now() - 3 * 86_400_000)
    for (const name of readdirSync(join(dir, 'audio'))) utimesSync(join(dir, 'audio', name), old, old)
    host.audio = wavBytes(300, 2)
    const second = await voice.speak('新的')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(existsSync(first.path)).toBe(false)
    expect(existsSync(second.path)).toBe(true)
  })
})

describe('transcribe', () => {
  it('is off by default', async () => {
    const { voice, dir } = await mount()
    expect(voice.asrEnabled).toBe(false)
    const file = join(dir, 'a.wav')
    writeFileSync(file, wavBytes())
    await expect(voice.transcribe(file)).rejects.toThrow('transcription is turned off')
    expect(host.seen).toHaveLength(0)
  })

  it('transcribes a file once enabled, keeping the raw answer on disk', async () => {
    const { voice, dir, logs } = await mount({ asr: { enabled: true } })
    const file = join(dir, 'note.wav')
    const audio = wavBytes(400, 3)
    writeFileSync(file, audio)
    host.transcripts.set(host.sha(audio).slice(0, 8), '提醒我下午三点开会')
    const result = await voice.transcribe(file)
    expect(result).toMatchObject({ text: '提醒我下午三点开会', engine: 'funasr' })
    expect((JSON.parse(readFileSync(result.rawPath, 'utf8')) as { full_text: string }).full_text).toBe('提醒我下午三点开会')
    expect(logs.some(line => line.type === 'info' && line.text.startsWith('lsy-voice: transcribed note.wav'))).toBe(true)
  })

  it('rejects relative paths, other formats, and missing or oversized files', async () => {
    const { voice, dir } = await mount({ asr: { enabled: true, maxBytes: 1024 } })
    await expect(voice.transcribe('note.wav')).rejects.toThrow('absolute')
    await expect(voice.transcribe(join(dir, 'a.silk'))).rejects.toThrow('not an audio format')
    await expect(voice.transcribe(join(dir, 'missing.wav'))).rejects.toThrow('cannot read the audio (ENOENT)')
    const big = join(dir, 'big.wav')
    writeFileSync(big, wavBytes(500))
    await expect(voice.transcribe(big)).rejects.toThrow('exceeds 1024 bytes')
    expect(host.seen).toHaveLength(0)
  })

  it('logs a failing service as a warning and rethrows a VoiceError', async () => {
    host.failNext.asr = [400]
    const { voice, dir, logs } = await mount({ asr: { enabled: true } })
    const file = join(dir, 'a.wav')
    writeFileSync(file, wavBytes())
    await expect(voice.transcribe(file)).rejects.toBeInstanceOf(VoiceError)
    expect(logs.some(line => line.type === 'warn' && line.text.includes('transcribing a.wav failed: asr POST /transcribe answered HTTP 400'))).toBe(true)
  })
})

describe('round trip', () => {
  it('feeds the exact bytes speak produced into the ASR', async () => {
    const { voice } = await mount({ asr: { enabled: true } })
    const spoken = await voice.speak('把灯关掉')
    host.transcripts.set(host.sha(readFileSync(spoken.path)).slice(0, 8), '把灯关掉')
    expect((await voice.transcribe(spoken.path)).text).toBe('把灯关掉')
  })

  it.skipIf(process.env.LSY_VOICE_LIVE !== '1')('speaks with the live feiyu service and hears it back through the live asr-service', async () => {
    const { voice } = await mount({
      tts: { format: 'wav', feiyu: { baseUrl: process.env.LSY_VOICE_LIVE_TTS ?? 'http://100.117.175.117:19880', pollMs: 2000 } },
      asr: { enabled: true, baseUrl: process.env.LSY_VOICE_LIVE_ASR ?? 'http://stevens-mac-mini.tailc2559b.ts.net:8099', engine: 'funasr', timeoutMs: 120_000 },
    }, { LSY_FEIYU_API_KEY: process.env.LSY_FEIYU_API_KEY ?? '' })
    const spoken = await voice.speak('今天天气很好，我们去公园散步吧。')
    const heard = await voice.transcribe(spoken.path)
    console.log(`live round trip: spoke ${spoken.path} via ${spoken.provider} in ${spoken.elapsedMs} ms; heard "${heard.text}" with ${heard.engine} in ${heard.elapsedMs} ms`)
    expect(heard.text.replace(/[，。,.\s]/g, '')).toContain('天气很好')
  }, 300_000)
})
