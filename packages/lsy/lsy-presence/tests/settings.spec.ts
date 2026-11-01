import { describe, expect, it } from 'vitest'
import { PresenceSettings, type SettingsPresence } from '../src/settings.ts'
import { PRESENCE_PATH, type PresenceAnswer, type PresenceView } from '../src/view.ts'

const VIEW: PresenceView = {
  asleep: true,
  source: 'focus',
  since: 1,
  until: 2,
  manual: null,
  lastFocus: { asleep: true, at: 1 },
  window: { enabled: true, start: '03:30', end: '10:30' },
  deferred: 2,
  urgentKinds: ['host.disk.full'],
  shortcut: { url: 'https://dsh.example/hooks/lsy', path: '/hooks/lsy', header: 'Authorization', tokenEnv: 'LSY_INGEST_TOKEN_PRESENCE', bodyOn: '{}', bodyOff: '{}' },
  timeZone: 'America/New_York',
}

function mount() {
  const calls: unknown[][] = []
  const presence: SettingsPresence = {
    view: () => VIEW,
    setManual: (asleep, until) => { calls.push(['setManual', asleep, until]); return Promise.resolve() },
    quietUntil: (clock) => { calls.push(['quietUntil', clock]); return Promise.resolve(5) },
    clearManual: () => { calls.push(['clearManual']); return Promise.resolve() },
    setWindow: (window) => { calls.push(['setWindow', window]); return Promise.resolve() },
    flushNow: () => { calls.push(['flushNow']); return Promise.resolve(2) },
  }
  const logs: string[] = []
  const logger = { info: (message: string) => { logs.push(message) }, warn: (message: string) => { logs.push(message) } }
  const route = new PresenceSettings({ presence, logger }).route()
  const call = async (body?: unknown, init: { contentType?: string; raw?: string } = {}) => {
    const post = body !== undefined || init.raw !== undefined
    const response = await route.fetch(new Request(`http://127.0.0.1${PRESENCE_PATH}`, post
      ? { method: 'POST', headers: { 'content-type': init.contentType ?? 'application/json' }, body: init.raw ?? JSON.stringify(body) }
      : {}))
    expect(response.headers.get('cache-control')).toBe('no-store')
    return { status: response.status, json: await response.json() as PresenceAnswer & { error?: string } }
  }
  return { route, call, calls, logs }
}

describe('Settings route', () => {
  it('registers GET and POST under /api, buffered, and answers the view', async () => {
    const { route, call } = mount()
    expect([route.path, route.methods, route.requestBody]).toEqual(['/api/lsy.presence', ['GET', 'POST'], 'buffered'])
    expect(await call()).toEqual({ status: 200, json: { view: VIEW, flushed: null } })
  })

  it('runs each button and logs its outcome and duration', async () => {
    const { call, calls, logs } = mount()
    expect((await call({ action: 'sleep.now' })).status).toBe(200)
    expect((await call({ action: 'wake.now' })).status).toBe(200)
    expect((await call({ action: 'quiet.until', until: '08:15' })).status).toBe(200)
    expect((await call({ action: 'manual.clear' })).status).toBe(200)
    expect((await call({ action: 'window.set', enabled: true, start: '23:00', end: '07:00' })).status).toBe(200)
    expect((await call({ action: 'window.set', enabled: false, start: '04:00', end: '04:00' })).status).toBe(200)
    expect(calls).toEqual([
      ['setManual', true, undefined], ['setManual', false, undefined], ['quietUntil', '08:15'], ['clearManual'],
      ['setWindow', { enabled: true, start: '23:00', end: '07:00' }], ['setWindow', { enabled: false, start: '04:00', end: '04:00' }],
    ])
    const ok = /^lsy-presence: settings (sleep\.now|wake\.now|quiet\.until|manual\.clear|window\.set) ok \(\d+ ms\)$/
    expect(logs.filter(line => ok.test(line))).toHaveLength(6)
  })

  it('flushes and says how many went out', async () => {
    const { call, calls } = mount()
    const { json } = await call({ action: 'flush' })
    expect(json.flushed).toBe(2)
    expect(calls).toEqual([['flushNow']])
  })

  it('refuses bad requests without touching the service or repeating the body', async () => {
    const { call, calls, logs } = mount()
    expect((await call(undefined, { raw: 'nope' })).status).toBe(400)
    expect((await call({ action: 'sleep.forever' })).status).toBe(400)
    expect((await call({ action: 'quiet.until', until: '25:00' })).status).toBe(400)
    expect((await call({ action: 'quiet.until', until: '8:15' })).status).toBe(400)
    expect((await call({ action: 'quiet.until' })).status).toBe(400)
    expect((await call({ action: 'window.set', enabled: 'yes', start: '03:30', end: '10:30' })).status).toBe(400)
    expect((await call({ action: 'sleep.now' }, { contentType: 'text/plain' })).status).toBe(415)
    const same = await call({ action: 'window.set', enabled: true, start: '04:00', end: '04:00' })
    expect(same).toMatchObject({ status: 400, json: { error: 'the window must not start and end at the same time' } })
    const echoed = await call({ action: 'quiet.until', until: 'secret-text' })
    expect(JSON.stringify(echoed.json)).not.toContain('secret-text')
    expect(calls).toEqual([])
    expect(logs.every(line => !line.includes('secret-text'))).toBe(true)
  })
})
