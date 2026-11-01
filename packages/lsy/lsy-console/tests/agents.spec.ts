import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { VoiceError } from '@deepseek-ai/dsh-lsy-voice'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActionError, AgentsView } from '../src/views.ts'
import { FakeClaudeCode, FakeService, closedUrl, mountConsole, tempDir } from './fixtures.ts'

const PATH = '/api/lsy.agents'
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function setup(
  config: Record<string, unknown> = {},
  provide: Record<string, unknown> = {},
  claudeCode: FakeClaudeCode | null = new FakeClaudeCode(),
) {
  const mounted = await mountConsole({ config })
  const all = claudeCode === null ? provide : { lsyClaudeCode: claudeCode, ...provide }
  for (const [name, value] of Object.entries(all)) mounted.ctx.provide(name as never, value as never)
  const get = async (): Promise<AgentsView> => await (await mounted.call(PATH)).json() as AgentsView
  const post = (body: unknown) => mounted.call(PATH, { method: 'POST', body })
  return { ...mounted, get, post, claudeCode }
}

describe('Claude Code card', () => {
  it('shows what lsy-cc-admin reports: the login state, sessions, and the tmux sessions started', async () => {
    const claudeCode = new FakeClaudeCode()
    claudeCode.view_ = {
      enabled: true, login: 'full', maxSessions: 3, started: ['review-1'],
      sessions: [{ name: 'review-1', pid: 111, status: 'idle', cwd: '/work/cc', updatedAt: 5, managed: true }],
    }
    const { get } = await setup({}, {}, claudeCode)
    expect((await get()).cc).toEqual(claudeCode.view_)
  })

  it('is null when the service is absent or switched off', async () => {
    expect((await (await setup({}, {}, null)).get()).cc).toBeNull()
    const off = new FakeClaudeCode()
    off.enabled = false
    expect((await (await setup({}, {}, off)).get()).cc).toBeNull()
  })

  it('answers the rest of the page when reading the sessions fails, and logs only the error class', async () => {
    const claudeCode = new FakeClaudeCode()
    claudeCode.view = () => Promise.reject(new TypeError('secret path /Users/x'))
    const { get, logs } = await setup({}, {}, claudeCode)
    expect((await get()).cc).toBeNull()
    expect(logs.join('\n')).toContain('reading Claude Code sessions failed: TypeError')
    expect(logs.join('\n')).not.toContain('/Users/x')
  })
})

describe('cc.start and cc.stop', () => {
  it('starts a named session with the first task, answers the fresh view, and logs without the task', async () => {
    const { post, claudeCode, logs } = await setup()
    const response = await post({ action: 'cc.start', name: 'review-1', task: 'read the logs' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, cc: { login: 'token' } })
    expect(claudeCode!.calls).toEqual(['start review-1 read the logs'])
    expect(logs.filter(line => line.includes('lsy-console: cc.start'))).toEqual([expect.stringMatching(/^info lsy-console: cc\.start review-1 -> ok \(\d+ ms\)$/u)])
    expect(logs.join('\n')).not.toContain('read the logs')
  })

  it('starts without a task, and refuses names that are not lower-case words and tasks beyond the tool\'s limit before calling the service', async () => {
    const { post, claudeCode } = await setup()
    expect((await post({ action: 'cc.start', name: 'review-1' })).status).toBe(200)
    expect(claudeCode!.calls).toEqual(['start review-1'])
    for (const name of ['Bad Name', 'x;rm', '', 'a'.repeat(32)]) expect((await post({ action: 'cc.start', name })).status).toBe(400)
    const long = await post({ action: 'cc.start', name: 'ok', task: 'a'.repeat(8001) })
    expect([long.status, await long.json()]).toEqual([400, { error: 'invalid_request', detail: 'task' }])
    expect(claudeCode!.calls).toHaveLength(1)
  })

  it.each([
    ['limit_reached', 429, undefined],
    ['invalid_request', 400, 'a session named two is already running'],
    ['start_failed', 502, 'tmux could not start the session'],
  ] as const)('relays the service\'s %s refusal', async (error, status, detail) => {
    const claudeCode = new FakeClaudeCode()
    claudeCode.next = { ok: false, error, ...detail === undefined ? {} : { detail } }
    const { post, logs } = await setup({}, {}, claudeCode)
    const response = await post({ action: 'cc.start', name: 'two' })
    expect([response.status, await response.json()]).toEqual([status, detail === undefined ? { error } : { error, detail }])
    expect(logs.some(line => line.startsWith(`warn lsy-console: cc.start two -> ${error}`))).toBe(true)
  })

  it('stops a session and relays not_found and failures', async () => {
    const claudeCode = new FakeClaudeCode()
    const { post } = await setup({}, {}, claudeCode)
    expect((await post({ action: 'cc.stop', name: 'review-1' })).status).toBe(200)
    expect(claudeCode.calls).toEqual(['stop review-1'])
    claudeCode.next = { ok: false, error: 'not_found', detail: 'no session named review-1 was started by cc_start' }
    expect((await post({ action: 'cc.stop', name: 'review-1' })).status).toBe(404)
    claudeCode.next = { ok: false, error: 'stop_failed' }
    expect((await post({ action: 'cc.stop', name: 'review-1' })).status).toBe(502)
    expect((await post({ action: 'cc.stop', name: 'Bad Name' })).status).toBe(400)
  })

  it('says unavailable when the service is absent or switched off', async () => {
    const { post } = await setup({}, {}, null)
    expect(await (await post({ action: 'cc.start', name: 'x' })).json()).toEqual({ error: 'unavailable', detail: 'cc' })
    const off = new FakeClaudeCode()
    off.enabled = false
    expect((await (await setup({}, {}, off)).post({ action: 'cc.stop', name: 'x' })).status).toBe(503)
  })

  it('refuses an unknown action', async () => {
    const { post } = await setup()
    expect(await (await post({ action: 'cc.explode', name: 'x' })).json()).toEqual({ error: 'invalid_request', detail: 'action' })
  })
})

describe('voice card', () => {
  it('is null without the voice service', async () => {
    const { get } = await setup()
    expect((await get()).voice).toBeNull()
  })

  it('reports the providers and whether each answers, with no URL or key', async () => {
    const feiyu = new FakeService({ '/health': 200 })
    const url = await feiyu.start()
    cleanups.push(() => feiyu.stop())
    const dead = await closedUrl()
    const voice = {
      describe: () => ({
        tts: { enabled: true, provider: 'feiyu', fallback: 'none', format: 'mp3', maxChars: 200, url },
        asr: { enabled: true, engine: 'whisper', url: dead },
      }),
    }
    const { get } = await setup({}, { lsyVoice: voice })
    const view = await get()
    expect(view.voice).toEqual({
      available: true, ttsEnabled: true, provider: 'feiyu', format: 'mp3', ttsUp: true, asrEnabled: true, engine: 'whisper', asrUp: false, previewChars: Array.from('你好，我是魔女的猫猫。这是一条语音试听。').length,
    })
    expect(JSON.stringify(view)).not.toContain('127.0.0.1')
  })
})

describe('voice.preview', () => {
  function voiceDouble(overrides: Record<string, unknown> = {}) {
    return {
      ttsEnabled: true,
      describe: () => ({ tts: { enabled: true, provider: 'feiyu', fallback: 'none', format: 'mp3', maxChars: 200, url: 'http://x' }, asr: { enabled: false, engine: 'funasr', url: 'http://y' } }),
      speak: vi.fn(),
      ...overrides,
    }
  }

  it('returns the synthesized audio to the caller and sends it nowhere else', async () => {
    const home = tempDir(cleanups)
    const audioPath = join(home, 'preview.mp3')
    writeFileSync(audioPath, Buffer.from([0x49, 0x44, 0x33, 1, 2, 3]))
    const speak = vi.fn(() => Promise.resolve({ path: audioPath, format: 'mp3' }))
    const send = vi.fn()
    const { post, logs } = await setup({}, { lsyVoice: voiceDouble({ speak }), lsyNotifier: { send, sendFile: send } })
    const response = await post({ action: 'voice.preview' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/mpeg')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([0x49, 0x44, 0x33, 1, 2, 3]))
    expect(speak).toHaveBeenCalledWith('你好，我是魔女的猫猫。这是一条语音试听。')
    expect(send).not.toHaveBeenCalled()
    expect(logs.filter(line => line.includes('voice.preview'))).toEqual([expect.stringMatching(/^info lsy-console: voice\.preview -> ok \(\d+ ms\)$/u)])
    expect(logs.join('\n')).not.toContain('魔女')
  })

  it('serves a WAV when that is the format', async () => {
    const home = tempDir(cleanups)
    const audioPath = join(home, 'preview.wav')
    writeFileSync(audioPath, 'RIFF')
    const { post } = await setup({}, { lsyVoice: voiceDouble({ speak: () => Promise.resolve({ path: audioPath, format: 'wav' }) }) })
    expect((await post({ action: 'voice.preview' })).headers.get('content-type')).toBe('audio/wav')
  })

  it('reports speech that is off, unavailable, or failing, with the reason clipped', async () => {
    expect((await (await (await setup()).post({ action: 'voice.preview' })).json())).toEqual({ error: 'unavailable', detail: 'voice' })
    const off = await setup({}, { lsyVoice: voiceDouble({ ttsEnabled: false }) })
    expect((await off.post({ action: 'voice.preview' })).status).toBe(409)
    const failing = await setup({}, { lsyVoice: voiceDouble({ speak: () => Promise.reject(new VoiceError(`feiyu failed ${'x'.repeat(400)}`)) }) })
    const response = await failing.post({ action: 'voice.preview' })
    const body = await response.json() as ActionError
    expect([response.status, body.error, body.detail!.length]).toEqual([502, 'speech_failed', 160])
    const broken = await setup({}, { lsyVoice: voiceDouble({ speak: () => Promise.reject(new TypeError('not a voice failure')) }) })
    expect((await broken.post({ action: 'voice.preview' })).status).toBe(500)
  })

  it('takes one preview at a time', async () => {
    let finish: (value: unknown) => void = () => {}
    const speak = vi.fn(() => new Promise((resolve) => { finish = resolve }))
    const { post } = await setup({}, { lsyVoice: voiceDouble({ speak }) })
    const first = post({ action: 'voice.preview' })
    await vi.waitFor(() => { expect(speak).toHaveBeenCalled() })
    const second = await post({ action: 'voice.preview' })
    expect([second.status, await second.json()]).toEqual([429, { error: 'limit_reached', detail: 'preview' }])
    const home = tempDir(cleanups)
    writeFileSync(join(home, 'a.mp3'), 'x')
    finish({ path: join(home, 'a.mp3'), format: 'mp3' })
    expect((await first).status).toBe(200)
  })
})
