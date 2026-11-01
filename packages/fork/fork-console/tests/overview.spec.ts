import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverviewView, ServiceCard } from '../src/views.ts'
import { FakeClaudeCode, FakeService, closedUrl, mountConsole } from './fixtures.ts'

const services: FakeService[] = []

async function serve(answers: Record<string, number | 'hang'>): Promise<string> {
  const service = new FakeService(answers)
  services.push(service)
  return service.start()
}

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.stop()))
  vi.restoreAllMocks()
})

const fakeBus = (overrides: Record<string, unknown> = {}) => ({
  stats: () => ({ subscriptions: 4, paused: 1, pending: 2, eventsLastHour: 30, batchesLastHour: 5, rateLimitHitsLastHour: 0 }),
  ...overrides,
})

async function overview(options: Parameters<typeof mountConsole>[0], provide: Record<string, unknown> = {}) {
  const mounted = await mountConsole(options)
  for (const [name, value] of Object.entries(provide)) mounted.ctx.provide(name as never, value as never)
  const response = await mounted.call('/api/fork.overview')
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const view = await response.json() as OverviewView
  const byId = (id: string): ServiceCard => view.cards.find(entry => entry.id === id)!
  return { ...mounted, view, byId, text: JSON.stringify(view) }
}

describe('overview cards', () => {
  it('shows every integrated service healthy, and carries no URL, key, or token', async () => {
    const bili = await serve({ '/healthz': 200 })
    const ams = await serve({ '/': 404 })
    const feiyu = await serve({ '/health': 200 })
    const asr = await serve({ '/health': 404 })
    const claudeCode = new FakeClaudeCode()
    claudeCode.view_ = { ...claudeCode.view_, login: 'token', sessions: [{ name: 'review-1', pid: 7, status: 'idle', cwd: null, updatedAt: null, managed: true }] }
    const voice = {
      describe: () => ({
        tts: { enabled: true, provider: 'feiyu', fallback: 'none', format: 'mp3', maxChars: 200, url: feiyu },
        asr: { enabled: true, engine: 'whisper', url: asr },
      }),
    }
    const { view, byId, text } = await overview(
      { config: { bili: { url: bili }, ams: { url: ams } } },
      {
        forkClaudeCode: claudeCode,
        forkEventBus: fakeBus(),
        forkVoice: voice,
        forkNotifier: { send: async () => {}, outbox: () => [] },
        forkQq: { groupOverview: () => [{ recorded: true }, { recorded: true }, { recorded: false }] },
        bili: {},
      },
    )
    expect(view.cards.map(card => [card.id, card.tone, card.state])).toEqual([
      ['dsh', 'ok', 'up'],
      ['bus', 'ok', 'up'],
      ['bili', 'ok', 'up'],
      ['qq', 'ok', 'mounted'],
      ['wechat', 'ok', 'up'],
      ['voice', 'ok', 'up'],
      ['cc', 'ok', 'up'],
      ['ams', 'ok', 'up'],
    ])
    expect(byId('dsh').facts).toMatchObject({ uptime: expect.any(Number) as number })
    expect(byId('bus').facts).toEqual({ subscriptions: 4, paused: 1, pending: 2, events: 30, batches: 5, limited: 0 })
    expect(byId('qq').facts).toEqual({ groups: 2 })
    expect(byId('voice').facts).toEqual({ provider: 'feiyu', asr: true, engine: 'whisper' })
    expect(byId('cc').facts).toEqual({ sessions: 1, max: 3, login: 'token' })
    for (const forbidden of [bili, ams, feiyu, asr, '127.0.0.1', 'sk-ant', 'http://']) expect(text).not.toContain(forbidden)
  })

  it('turns a service that refuses connections red and leaves the other cards alone', async () => {
    const { byId } = await overview({ config: { bili: { url: await closedUrl() } } }, { forkEventBus: fakeBus() })
    expect(byId('bili')).toMatchObject({ tone: 'down', state: 'down' })
    expect(byId('bus')).toMatchObject({ tone: 'ok' })
    expect(byId('dsh')).toMatchObject({ tone: 'ok' })
  })

  it('does not wait for a service that never answers beyond the probe deadline', async () => {
    const hung = await serve({ '/healthz': 'hang' })
    const started = Date.now()
    const { byId } = await overview({ config: { bili: { url: hung }, probeTimeoutMs: 300 } })
    expect(Date.now() - started).toBeLessThan(2500)
    expect(byId('bili')).toMatchObject({ tone: 'down', state: 'down' })
  })

  it('probes in parallel: slow services cost one deadline, not the sum', async () => {
    const hung = await serve({ '/healthz': 'hang', '/': 'hang', '/health': 'hang' })
    const voice = {
      describe: () => ({
        tts: { enabled: true, provider: 'feiyu', fallback: 'none', format: 'mp3', maxChars: 200, url: hung },
        asr: { enabled: true, engine: 'funasr', url: hung },
      }),
    }
    const started = Date.now()
    const { byId } = await overview({ config: { bili: { url: hung }, ams: { url: hung }, probeTimeoutMs: 400 } }, { forkVoice: voice })
    expect(Date.now() - started).toBeLessThan(1500)
    expect([byId('bili').tone, byId('ams').tone, byId('voice').tone]).toEqual(['down', 'down', 'down'])
  })

  it('marks services that are not mounted as off, not as failures', async () => {
    const { byId } = await overview({ config: { bili: { url: await closedUrl() } } })
    for (const id of ['bus', 'qq', 'wechat', 'voice', 'cc']) expect(byId(id)).toMatchObject({ tone: 'off', state: 'absent' })
  })

  it('leaves the AMS card out unless it is configured', async () => {
    const { view } = await overview({ config: { bili: { url: await closedUrl() }, ams: { url: '' } } })
    expect(view.cards.map(card => card.id)).not.toContain('ams')
  })

  it('shows a card that throws as red and logs only the error class', async () => {
    const { byId, logs } = await overview(
      { config: { bili: { url: await closedUrl() } } },
      { forkEventBus: fakeBus({ stats: () => { throw new TypeError('secret path /Users/x') } }) },
    )
    expect(byId('bus')).toMatchObject({ tone: 'down', state: 'error', facts: {} })
    expect(logs.join('\n')).toContain('the bus card failed: TypeError')
    expect(logs.join('\n')).not.toContain('/Users/x')
  })

  it('warns when a subscription met its hourly limit, the WeChat outbox is waiting, or sign-in is missing', async () => {
    const { byId } = await overview(
      { config: { bili: { url: await closedUrl() } } },
      {
        forkEventBus: fakeBus({
          stats: () => ({ subscriptions: 1, paused: 0, pending: 3, eventsLastHour: 9, batchesLastHour: 4, rateLimitHitsLastHour: 2 }),
        }),
        forkNotifier: { send: async () => {}, outbox: () => [{}, {}] },
        forkClaudeCode: Object.assign(new FakeClaudeCode(), { view_: { enabled: true, login: 'none', sessions: [], maxSessions: 3, started: [] } }),
      },
    )
    expect(byId('bus')).toMatchObject({ tone: 'warn', state: 'limited', facts: { limited: 2 } })
    expect(byId('wechat')).toMatchObject({ tone: 'warn', state: 'queued', facts: { queued: 2 } })
    expect(byId('cc')).toMatchObject({ tone: 'warn', state: 'nologin' })
  })

  it('takes a service\'s own health() report when it has one', async () => {
    const bili = await serve({ '/healthz': 200 })
    const { byId } = await overview(
      { config: { bili: { url: bili } } },
      {
        forkQq: { health: () => Promise.resolve({ state: 'down', detail: 'protocol end offline for 12 min' }) },
        bili: { health: () => ({ state: 'warn', detail: 'gate is read-only' }) },
        forkNotifier: { send: async () => {}, health: () => ({ state: 'down', detail: 'token stale' }) },
      },
    )
    expect(byId('qq')).toMatchObject({ tone: 'down', state: 'down', facts: { detail: 'protocol end offline for 12 min' } })
    expect(byId('bili')).toMatchObject({ tone: 'warn', state: 'warn', facts: { detail: 'gate is read-only' } })
    expect(byId('wechat')).toMatchObject({ tone: 'down', facts: { detail: 'token stale' } })
  })

  it('reports speech off, a down TTS provider, and a down ASR service', async () => {
    const feiyu = await serve({ '/health': 200 })
    const describeWith = (tts: { enabled: boolean; url: string }, asr: { enabled: boolean; url: string }) => ({
      describe: () => ({ tts: { ...tts, provider: 'feiyu', fallback: 'none', format: 'mp3', maxChars: 200 }, asr: { ...asr, engine: 'funasr' } }),
    })
    const dead = await closedUrl()
    const base = { config: { bili: { url: dead } } }
    expect((await overview(base, { forkVoice: describeWith({ enabled: false, url: feiyu }, { enabled: false, url: dead }) })).byId('voice'))
      .toMatchObject({ tone: 'off', state: 'tts_off' })
    expect((await overview(base, { forkVoice: describeWith({ enabled: true, url: dead }, { enabled: false, url: dead }) })).byId('voice'))
      .toMatchObject({ tone: 'down', state: 'tts_down' })
    expect((await overview(base, { forkVoice: describeWith({ enabled: true, url: feiyu }, { enabled: true, url: dead }) })).byId('voice'))
      .toMatchObject({ tone: 'warn', state: 'asr_down' })
  })

  it('says Claude Code is off when the bridge is disabled, without reading any session', async () => {
    const claudeCode = Object.assign(new FakeClaudeCode(), { enabled: false, view: () => Promise.reject(new Error('read nothing')) })
    const { byId } = await overview({ config: { bili: { url: await closedUrl() } } }, { forkClaudeCode: claudeCode })
    expect(byId('cc')).toMatchObject({ tone: 'off', state: 'disabled' })
  })

  it('reads the build identity from the entry path', async () => {
    const { byId } = await overview({ config: { bili: { url: await closedUrl() } } })
    expect(byId('dsh').facts).toHaveProperty('version')
    expect(byId('dsh').facts).toHaveProperty('sha')
  })
})

beforeEach(() => { vi.useRealTimers() })
