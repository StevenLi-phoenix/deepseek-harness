import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VoiceError } from '@deepseek-ai/dsh-lsy-voice'
import { ClaudeCode } from '../src/claude-code.ts'
import type { ActionError, AgentsView } from '../src/views.ts'
import { FakeService, closedUrl, fakeTmux, mountConsole, tempHome } from './fixtures.ts'

const PATH = '/api/lsy.agents'
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function setup(config: Record<string, unknown> = {}, provide: Record<string, unknown> = {}) {
  const { home, cleanup } = tempHome()
  cleanups.push(cleanup)
  const tmux = fakeTmux(home)
  const mounted = await mountConsole({ home, config: { claudeCode: { sessionsDir: join(home, '.claude', 'sessions'), tmux: tmux.tmux }, ...config } })
  for (const [name, value] of Object.entries(provide)) mounted.ctx.provide(name as never, value as never)
  const get = async (): Promise<AgentsView> => await (await mounted.call(PATH)).json() as AgentsView
  const post = (body: unknown) => mounted.call(PATH, { method: 'POST', body })
  return { ...mounted, home, tmux, get, post, tmuxCalls: () => (existsSync(tmux.log) ? readFileSync(tmux.log, 'utf8').trim().split('\n') : []) }
}

describe('Claude Code card', () => {
  it('reports the login state from file existence alone', async () => {
    const { home, get } = await setup()
    expect((await get()).cc).toMatchObject({ enabled: true, login: 'none', sessions: [], maxSessions: 3, started: [] })
    writeFileSync(join(home, '.config', 'claude-code', 'oauth_token'), 'sk-ant-oat01-SECRET')
    expect((await get()).cc!.login).toBe('token')
    writeFileSync(join(home, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"SECRET2"}}')
    const view = await get()
    expect(view.cc!.login).toBe('full')
    expect(JSON.stringify(view)).not.toMatch(/SECRET/u)
  })

  it('is null when the bridge is disabled', async () => {
    const { get } = await setup({ claudeCode: { enabled: false } })
    expect((await get()).cc).toBeNull()
  })

  it('lists the tmux sessions the bridge started', async () => {
    const { get, post } = await setup()
    await post({ action: 'cc.start', name: 'review-1' })
    expect((await get()).cc!.started).toEqual(['review-1'])
  })
})

describe('cc.start and cc.stop', () => {
  it('starts a named session in tmux, with the first task as one quoted prompt argument', async () => {
    const { post, tmuxCalls, logs } = await setup()
    const response = await post({ action: 'cc.start', name: 'review-1', task: 'read it; echo \'$HOME\'' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, cc: { started: ['review-1'] } })
    const call = tmuxCalls().find(line => line.includes('new-session'))!
    expect(call).toContain('-s review-1')
    expect(call).toContain('--name review-1 -- \'read it; echo \'\\\'\'$HOME\'\\\'\'\'')
    expect(logs.filter(line => line.includes('lsy-console: cc.start'))).toEqual([expect.stringMatching(/^info lsy-console: cc\.start review-1 -> ok \(\d+ ms\)$/u)])
    // The task is the owner's text: it must not be logged.
    expect(logs.join('\n')).not.toContain('read it')
  })

  it('refuses names that are not lower-case words and tasks beyond the tool\'s limit', async () => {
    const { post, tmuxCalls } = await setup()
    for (const name of ['Bad Name', 'x;rm', '', 'a'.repeat(32)]) expect((await post({ action: 'cc.start', name })).status).toBe(400)
    const long = await post({ action: 'cc.start', name: 'ok', task: 'a'.repeat(8001) })
    expect([long.status, await long.json()]).toEqual([400, { error: 'invalid_request', detail: 'task' }])
    expect(tmuxCalls().filter(line => line.includes('new-session'))).toEqual([])
  })

  it('stops at three running sessions and reports duplicates', async () => {
    const { post } = await setup()
    for (const name of ['one', 'two', 'three']) expect((await post({ action: 'cc.start', name })).status).toBe(200)
    const fourth = await post({ action: 'cc.start', name: 'four' })
    expect([fourth.status, await fourth.json()]).toEqual([429, { error: 'limit_reached' }])
    const duplicate = await post({ action: 'cc.start', name: 'two' })
    expect(duplicate.status).toBe(400)
    expect(await duplicate.json()).toMatchObject({ error: 'invalid_request' })
  })

  it('stops a session it started and refuses one it did not', async () => {
    const { post, get } = await setup()
    await post({ action: 'cc.start', name: 'review-1' })
    expect((await post({ action: 'cc.stop', name: 'review-1' })).status).toBe(200)
    expect((await get()).cc!.started).toEqual([])
    const again = await post({ action: 'cc.stop', name: 'review-1' })
    expect([again.status, (await again.json() as ActionError).error]).toEqual([404, 'not_found'])
  })

  it('reports a tmux that cannot start a session', async () => {
    const { post } = await setup({ claudeCode: { tmux: '/nonexistent/tmux' } })
    const response = await post({ action: 'cc.start', name: 'review-1' })
    expect([response.status, (await response.json() as ActionError).error]).toEqual([502, 'start_failed'])
  })

  it('says unavailable when the bridge is disabled', async () => {
    const { post } = await setup({ claudeCode: { enabled: false } })
    expect((await post({ action: 'cc.start', name: 'x' })).status).toBe(503)
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
    const { home } = tempHome()
    cleanups.push(() => undefined)
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
    const { home } = tempHome()
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
  })

  it('takes one preview at a time', async () => {
    let finish: (value: unknown) => void = () => {}
    const speak = vi.fn(() => new Promise((resolve) => { finish = resolve }))
    const { post } = await setup({}, { lsyVoice: voiceDouble({ speak }) })
    const first = post({ action: 'voice.preview' })
    await vi.waitFor(() => { expect(speak).toHaveBeenCalled() })
    const second = await post({ action: 'voice.preview' })
    expect([second.status, await second.json()]).toEqual([429, { error: 'limit_reached', detail: 'preview' }])
    const { home } = tempHome()
    writeFileSync(join(home, 'a.mp3'), 'x')
    finish({ path: join(home, 'a.mp3'), format: 'mp3' })
    expect((await first).status).toBe(200)
  })
})

describe('ClaudeCode adapter', () => {
  it('keeps the bridge\'s defaults in step with lsy-cc-bridge', async () => {
    const { Config: BridgeConfig } = await import('@deepseek-ai/dsh-lsy-cc-bridge')
    const { Config } = await import('../src/config.ts')
    const bridge = BridgeConfig({} as never)
    const mine = Config({} as never).claudeCode
    expect({ tmux: mine.tmux, command: mine.command, workDir: mine.workDir, model: mine.model, maxSessions: mine.maxSessions })
      .toEqual({
        tmux: bridge.tmux, command: bridge.command, workDir: bridge.workDir, model: bridge.model, maxSessions: bridge.maxSessions,
      })
    expect(typeof ClaudeCode).toBe('function')
  })
})
