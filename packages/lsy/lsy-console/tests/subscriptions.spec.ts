import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { disposeAll, harness, release } from '../../lsy-event-bus/tests/harness.ts'
import type { ActionError, SubscriptionsView } from '../src/views.ts'
import { mountConsole } from './fixtures.ts'

const PATH = '/api/lsy.subscriptions'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-01T12:00:00.000Z'))
})
afterEach(async () => {
  await disposeAll()
  vi.useRealTimers()
})

async function setup(options: { schedule?: unknown; sensor?: unknown } = {}) {
  const h = await harness()
  if (options.schedule !== undefined) h.ctx.provide('schedule' as never, options.schedule as never)
  if (options.sensor !== undefined) h.ctx.provide('lsyGithubSensor' as never, options.sensor as never)
  const mounted = await mountConsole({ ctx: h.ctx })
  const get = async (): Promise<SubscriptionsView> => await (await mounted.call(PATH)).json() as SubscriptionsView
  const post = (body: unknown, extra: { contentType?: string | null; raw?: string } = {}) => mounted.call(PATH, { method: 'POST', body, ...extra })
  return { ...h, ...mounted, get, post }
}

const notifyForm = { id: 'octo-tags', kinds: ['github.tag'], subjects: ['octo/repo'], mode: 'notify' }

describe('GET /api/lsy.subscriptions', () => {
  it('lists configuration rows as read-only config and run-time rows with who made them, how often they fired, and when', async () => {
    const { get, bus, notes } = await setup()
    await bus.subscribe({ id: 'mine', sources: ['github'], kinds: ['github.release'], subjects: [], action: 'notify', coalesceMs: 1000, maxPerHour: 5 }, { createdBy: 'session-7' })
    await bus.publish(release(1))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(notes).toHaveLength(2)
    const view = await get()
    expect(view.subscriptions).toMatchObject([
      { id: 'releases', origin: 'config', mode: 'notify', paused: false, createdBy: null, createdAt: null, fireCount: 1, lastStatus: 'delivered' },
      { id: 'mine', origin: 'agent', mode: 'notify', paused: false, createdBy: 'session-7', fireCount: 1, pending: 0, lastStatus: 'delivered' },
    ])
    expect(view.subscriptions![1]!.lastFiredAt).toBeGreaterThan(view.subscriptions![1]!.createdAt!)
    expect(view.schedules).toBeNull()
    expect(view.defaults).toEqual({
      coalesceSeconds: 60, notifyMaxPerHour: 12, sessionMaxPerHour: 4, agentPreset: 'unattended', workspacePath: '/Users/dsh-runtime/work',
    })
  })

  it('lists Host schedule reminders without their prompts', async () => {
    const schedule = {
      catalog: () => Promise.resolve([
        { id: 's1', kind: 'every', title: 'Check backups', prompt: 'PRIVATE PROMPT', everySeconds: 1800, scheduledAt: '2026-11-01T12:30:00.000Z', status: 'active', target: {}, involvedSessionIds: [], lastDelivery: { deliveredAt: '2026-11-01T12:00:00.000Z' } },
        { id: 's2', kind: 'daily', title: 'Morning', prompt: 'x', time: '09:00:00.000', timeZone: 'Asia/Shanghai', scheduledAt: '2026-11-02T01:00:00.000Z', status: 'paused', target: {}, involvedSessionIds: [] },
        { id: 's3', kind: 'weekly', title: 'Weekly', prompt: 'x', time: '08:30:00.000', timeZone: 'UTC', weekdays: [1, 3], scheduledAt: '2026-11-02T08:30:00.000Z', status: 'active', target: {}, involvedSessionIds: [] },
      ]),
    }
    const { get } = await setup({ schedule })
    const view = await get()
    expect(JSON.stringify(view)).not.toContain('PRIVATE PROMPT')
    expect(view.schedules).toEqual([
      { id: 's1', title: 'Check backups', rule: 'every', detail: '1800 s', status: 'active', nextAt: Date.parse('2026-11-01T12:30:00.000Z'), lastFiredAt: Date.parse('2026-11-01T12:00:00.000Z') },
      { id: 's2', title: 'Morning', rule: 'daily', detail: '09:00:00 Asia/Shanghai', status: 'paused', nextAt: Date.parse('2026-11-02T01:00:00.000Z'), lastFiredAt: null },
      { id: 's3', title: 'Weekly', rule: 'weekly', detail: '1,3 08:30:00 UTC', status: 'active', nextAt: Date.parse('2026-11-02T08:30:00.000Z'), lastFiredAt: null },
    ])
  })
})

describe('POST create', () => {
  it('creates a notify subscription that the bus then routes, with the defaults filled in', async () => {
    const { post, bus, notes, logs } = await setup()
    const response = await post({ action: 'create', subscription: notifyForm })
    expect(response.status).toBe(200)
    const body = await response.json() as { ok: boolean } & SubscriptionsView
    expect(body.ok).toBe(true)
    expect(body.subscriptions!.map(row => row.id)).toEqual(['releases', 'octo-tags'])
    expect(bus.listSubscriptions()[1]).toMatchObject({
      id: 'octo-tags', action: 'notify', kinds: ['github.tag'], subjects: ['octo/repo'], sources: [], coalesceMs: 60_000, maxPerHour: 12, origin: 'agent', createdBy: 'settings',
    })
    expect(await bus.publish(release(1, { kind: 'github.tag', key: 't1' }))).toBe('accepted')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(notes.map(note => note.title)).toContain('octo-tags: 1 event(s)')
    expect(logs.some(line => /^info lsy-console: subscription\.create octo-tags -> ok \(\d+ ms\)$/u.test(line))).toBe(true)
  })

  it('creates a session subscription from instructions, with the configured workspace and presets', async () => {
    const { post, bus } = await setup()
    const response = await post({ action: 'create', subscription: { id: 'triage', sources: ['kaorou'], mode: 'session', instructions: ' Summarize failures. ', coalesceSeconds: 5, maxPerHour: 2 } })
    expect(response.status).toBe(200)
    expect(bus.listSubscriptions()[1]).toMatchObject({
      id: 'triage', action: 'session', coalesceMs: 5000, maxPerHour: 2,
      session: { workspacePath: '/Users/dsh-runtime/work', agentPreset: 'unattended', permissionPreset: 'danger-full-access', instructions: 'Summarize failures.', maxPromptEvents: 50, maxTextChars: 2000 },
    })
  })

  it.each([
    ['an id with capitals', { ...notifyForm, id: 'Bad Id' }, 'invalid_request', 'subscription.id'],
    ['an id that is empty', { ...notifyForm, id: '' }, 'invalid_request', 'subscription.id'],
    ['a selector with whitespace', { ...notifyForm, kinds: ['github tag'] }, 'invalid_request', 'subscription.kinds.0'],
    ['a selector that is not a string', { ...notifyForm, sources: [3] }, 'invalid_request', 'subscription.sources.0'],
    ['an unknown mode', { ...notifyForm, mode: 'email' }, 'invalid_request', 'subscription.mode'],
    ['a fractional window', { ...notifyForm, coalesceSeconds: 1.5 }, 'invalid_request', 'subscription.coalesceSeconds'],
    ['a zero hourly limit', { ...notifyForm, maxPerHour: 0 }, 'invalid_request', 'subscription.maxPerHour'],
    ['no selector at all, which would match every event', { id: 'all', mode: 'notify' }, 'invalid_subscription', 'selector'],
    ['a session subscription without instructions', { id: 'x', kinds: ['a.b'], mode: 'session', instructions: '  ' }, 'invalid_subscription', 'instructions'],
    ['instructions beyond the bound', { id: 'x', kinds: ['a.b'], mode: 'session', instructions: 'a'.repeat(4001) }, 'invalid_subscription', 'instructions'],
  ])('refuses %s', async (_label, subscription, error, detail) => {
    const { post, bus } = await setup()
    const response = await post({ action: 'create', subscription })
    expect(response.status).toBe(error === 'invalid_request' ? 400 : 422)
    expect(await response.json()).toEqual({ error, detail } as ActionError)
    expect(bus.listSubscriptions()).toHaveLength(1)
  })

  it('refuses an id that is already used, by the configuration or by another subscription', async () => {
    const { post } = await setup()
    expect(await (await post({ action: 'create', subscription: { ...notifyForm, id: 'releases' } })).json()).toMatchObject({ error: 'duplicate_id' })
    expect((await post({ action: 'create', subscription: notifyForm })).status).toBe(200)
    const again = await post({ action: 'create', subscription: notifyForm })
    expect(again.status).toBe(409)
    expect(await again.json()).toEqual({ error: 'duplicate_id' })
  })

  it('never echoes request values in a refusal or the log', async () => {
    const { post, logs } = await setup()
    const response = await post({ action: 'create', subscription: { ...notifyForm, id: 'x', kinds: ['LEAK-ME some text'] } })
    expect(JSON.stringify(await response.json())).not.toContain('LEAK-ME')
    expect(logs.join('\n')).not.toContain('LEAK-ME')
  })
})

describe('POST pause, resume, delete', () => {
  it('pauses and resumes a run-time subscription, and a paused one stops matching', async () => {
    const { post, bus, get } = await setup()
    await post({ action: 'create', subscription: notifyForm })
    expect((await post({ action: 'pause', target: 'subscription', id: 'octo-tags' })).status).toBe(200)
    expect((await get()).subscriptions![1]).toMatchObject({ id: 'octo-tags', paused: true })
    expect(await bus.publish(release(1, { kind: 'github.tag', key: 'p1' }))).toBe('unmatched')
    await post({ action: 'resume', target: 'subscription', id: 'octo-tags' })
    expect((await get()).subscriptions![1]).toMatchObject({ paused: false })
    expect(await bus.publish(release(2, { kind: 'github.tag', key: 'p2' }))).toBe('accepted')
  })

  it('deletes a run-time subscription', async () => {
    const { post, get } = await setup()
    await post({ action: 'create', subscription: notifyForm })
    const response = await post({ action: 'delete', target: 'subscription', id: 'octo-tags' })
    expect(response.status).toBe(200)
    expect((await get()).subscriptions!.map(row => row.id)).toEqual(['releases'])
  })

  it('stops the repository poll a watch started when it deletes the watch', async () => {
    const unwatch = vi.fn(() => Promise.resolve(true))
    const sensor = { watchedRepos: () => [{ origin: 'agent', ref: 'octo-tags' }, { origin: 'config', ref: 'releases' }], unwatch }
    const { post } = await setup({ sensor })
    await post({ action: 'create', subscription: notifyForm })
    await post({ action: 'delete', target: 'subscription', id: 'octo-tags' })
    expect(unwatch).toHaveBeenCalledWith('octo-tags')
  })

  it('refuses to change what the configuration owns, and reports unknown ids', async () => {
    const { post } = await setup()
    for (const action of ['pause', 'delete']) {
      const response = await post({ action, target: 'subscription', id: 'releases' })
      expect([response.status, await response.json()]).toEqual([409, { error: 'config_owned' }])
    }
    const missing = await post({ action: 'delete', target: 'subscription', id: 'nope' })
    expect([missing.status, await missing.json()]).toEqual([404, { error: 'not_found' }])
    expect((await post({ action: 'resume', target: 'subscription', id: 'nope' })).status).toBe(404)
  })

  it('pauses, resumes, and deletes reminders through the schedule service', async () => {
    const edit = vi.fn((request: { id: string; action: string }) => Promise.resolve(request.id === 'gone' ? { id: request.id, code: 'schedule_not_found' } : { id: request.id, deleted: true }))
    const { post } = await setup({ schedule: { catalog: () => Promise.resolve([]), edit } })
    expect((await post({ action: 'pause', target: 'schedule', id: 's1' })).status).toBe(200)
    expect((await post({ action: 'resume', target: 'schedule', id: 's1' })).status).toBe(200)
    expect((await post({ action: 'delete', target: 'schedule', id: 's1' })).status).toBe(200)
    expect(edit.mock.calls.map(([request]) => request)).toEqual([
      { id: 's1', action: 'update', patch: { active: false } },
      { id: 's1', action: 'update', patch: { active: true } },
      { id: 's1', action: 'delete' },
    ])
    expect((await post({ action: 'delete', target: 'schedule', id: 'gone' })).status).toBe(404)
  })

  it('says unavailable when the service behind an action is not mounted', async () => {
    const { post } = await setup()
    const response = await post({ action: 'pause', target: 'schedule', id: 's1' })
    expect([response.status, await response.json()]).toEqual([503, { error: 'unavailable', detail: 'schedule' }])
  })

  it('logs the action, the target, the outcome, and the duration, and nothing else', async () => {
    const { post, logs } = await setup()
    await post({ action: 'create', subscription: notifyForm })
    await post({ action: 'delete', target: 'subscription', id: 'nope' })
    await post({ action: 'pause', target: 'subscription', id: 'releases' })
    const mine = logs.filter(line => line.includes('lsy-console'))
    expect(mine).toEqual([
      expect.stringMatching(/^info lsy-console: subscription\.create octo-tags -> ok \(\d+ ms\)$/u),
      expect.stringMatching(/^warn lsy-console: subscription\.delete nope -> not_found \(\d+ ms\)$/u),
      expect.stringMatching(/^warn lsy-console: subscription\.pause releases -> config_owned \(\d+ ms\)$/u),
    ])
  })
})

describe('POST validation', () => {
  it('reads only application/json bodies', async () => {
    const { post } = await setup()
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', null]) {
      const response = await post({ action: 'delete', target: 'subscription', id: 'x' }, { contentType })
      expect([response.status, await response.json()]).toEqual([400, { error: 'invalid_request', detail: 'content-type' }])
    }
  })

  it('refuses invalid JSON, an oversized body, an unknown action, and a body that is not an object', async () => {
    const { post } = await setup()
    expect(await (await post(undefined, { raw: '{nope' })).json()).toEqual({ error: 'invalid_request', detail: 'json' })
    expect(await (await post(undefined, { raw: JSON.stringify({ action: 'delete', pad: 'x'.repeat(70_000) }) })).json()).toEqual({ error: 'invalid_request', detail: 'size' })
    expect((await post({ action: 'explode', target: 'subscription', id: 'x' })).status).toBe(400)
    expect((await post(null, { raw: 'null' })).status).toBe(400)
    expect((await post([1, 2])).status).toBe(400)
    expect((await post({ action: 'delete', target: 'subscription' })).status).toBe(400)
  })

  it('refuses a method the route does not take', async () => {
    const { call } = await setup()
    const response = await call('/api/lsy.overview', { method: 'POST' })
    expect(response.status).toBe(405)
  })
})
