import { describe, expect, it } from 'vitest'
import { collectActivity } from '../src/activity.ts'

const NOW = Date.UTC(2026, 10, 6, 16, 0)
const HOUR = 3_600_000

const event = (id: string, source: string, age: number, subscriptions: string[], outcome = 'accepted') => ({
  id, source, kind: `${source}.thing`, key: id, subject: 'subject', title: `title ${id}`, text: 'private body',
  receivedAt: NOW - age, outcome, subscriptions,
})
const batch = (id: string, subscription: string, age: number, eventIds: string[], extra: Record<string, unknown>) => ({
  id, subscription, action: 'session', title: id, eventIds, createdAt: NOW - age, status: 'completed', ...extra,
})

const fakeCtx = (bus: unknown, presence?: unknown) => ({
  get: (name: string) => ({ lsyEventBus: bus, lsyPresence: presence } as Record<string, unknown>)[name],
}) as never

const BUS = {
  events: () => [
    event('old', 'github', 3 * 24 * HOUR, ['ci']),
    event('a', 'github', 2 * HOUR, ['ci']),
    event('b', 'github', 30 * 60_000, ['ci']),
    event('c', 'host', 10 * 60_000, ['host-alerts']),
    event('d', 'bili', 5 * 60_000, ['bili-digest']),
    event('e', 'qq', 4 * 60_000, []),
    event('f', 'github', 2 * 60_000, ['ci']),
  ],
  batches: () => [
    batch('b-old', 'ci', 3 * 24 * HOUR, ['old'], { silent: true }),
    batch('b-a', 'ci', 2 * HOUR, ['a'], { silent: true }),
    batch('b-b', 'ci', 30 * 60_000, ['b'], {}),
    batch('b-c', 'host-alerts', 10 * 60_000, ['c'], { action: 'notify', status: 'delivered' }),
    batch('b-d', 'bili-digest', 5 * 60_000, ['d'], { status: 'failed', error: 'boom' }),
  ],
}

describe('flow activity', () => {
  it('counts each window from what the bus holds', () => {
    const view = collectActivity(fakeCtx(BUS), NOW)
    expect(view.windows['1h'].funnel).toEqual({ events: 5, batches: 3, sent: 2, silent: 0, failed: 1 })
    expect(view.windows['24h'].funnel).toEqual({ events: 6, batches: 4, sent: 2, silent: 1, failed: 1 })
    expect(view.windows['7d'].funnel).toEqual({ events: 7, batches: 5, sent: 2, silent: 2, failed: 1 })
    expect(view.windows['24h'].sources['github']).toEqual({ count: 3, lastAt: NOW - 2 * 60_000 })
    expect(view.windows['1h'].subscriptions['ci']).toEqual({ count: 1, lastAt: NOW - 30 * 60_000, sent: 1, silent: 0, failed: 0 })
  })

  it('lists what happened, newest first, with what became of it and without any message body', () => {
    const view = collectActivity(fakeCtx(BUS), NOW)
    expect(view.recent.map(item => [item.id, item.outcome])).toEqual([
      ['f', 'waiting'], ['e', 'unmatched'], ['d', 'failed'], ['c', 'sent'], ['b', 'sent'], ['a', 'silent'], ['old', 'silent'],
    ])
    expect(view.recent[3]).toMatchObject({ source: 'host', title: 'title c', subscriptions: ['host-alerts'], at: NOW - 10 * 60_000 })
    expect(JSON.stringify(view)).not.toContain('private body')
  })

  it('cuts a long title, and answers with empty windows when the bus is not mounted', () => {
    const long = { events: () => [{ ...event('x', 'qq', 1, []), title: '长'.repeat(200) }], batches: () => [] }
    expect(Array.from(collectActivity(fakeCtx(long), NOW).recent[0]!.title).length).toBe(80)
    const none = collectActivity(fakeCtx(undefined), NOW)
    expect(none.windows['24h'].funnel.events).toBe(0)
    expect(none.recent).toEqual([])
    expect(none.presence).toBeNull()
  })

  it('reads whether the owner is asleep and how many messages wait for them', () => {
    const presence = { view: () => ({ asleep: true, deferred: 2, since: 1 }) }
    expect(collectActivity(fakeCtx(BUS, presence), NOW).presence).toEqual({ asleep: true, deferred: 2 })
  })
})
