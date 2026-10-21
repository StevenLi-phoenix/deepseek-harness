/* oxlint-disable typescript/no-unsafe-assignment -- Vitest asymmetric matchers are typed as any. */
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import LsyEventBus, { LSY_EVENT_KIND, LsySubscriptionError, subscriptionProblem } from '../src/index.ts'
import type { Subscription } from '../src/types.ts'
import { HOUR, baseConfig, disposeAll, harness, release, sessionEvents } from './harness.ts'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'))
})

afterEach(async () => {
  await disposeAll()
  vi.useRealTimers()
})

const tags: Subscription = {
  id: 'octo-tags',
  sources: ['github'],
  kinds: ['github.tag'],
  subjects: ['octo/repo'],
  action: 'notify',
  coalesceMs: 30_000,
  maxPerHour: 3,
}

const triage: Subscription = {
  id: 'octo-triage',
  sources: ['github'],
  kinds: ['github.release'],
  subjects: ['octo/repo'],
  action: 'session',
  coalesceMs: 1_000,
  maxPerHour: 4,
  session: {
    workspacePath: '/Users/dsh-runtime/work',
    agentPreset: 'unattended',
    permissionPreset: 'danger-full-access',
    instructions: 'Read the release notes and tell me whether to upgrade.',
    maxPromptEvents: 50,
    maxTextChars: 2000,
  },
}

function tag(name: string) {
  return release(1, { kind: 'github.tag', key: `octo/repo:tag:${name}`, title: `tag ${name}` })
}

describe('LsyEventBus agent subscriptions', () => {
  it('routes events to a subscription created at run time and records who created it', async () => {
    const { bus, notes } = await harness()
    const view = await bus.subscribe(tags, { createdBy: 'session-1' })
    expect(view).toMatchObject({ id: 'octo-tags', origin: 'agent', createdAt: Date.now(), createdBy: 'session-1', status: { pending: 0, batchesLastHour: 0 } })

    expect(await bus.publish(tag('v1'))).toBe('accepted')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(notes).toEqual([expect.objectContaining({ title: 'octo-tags: 1 event(s)' })])
    expect(bus.batches()).toMatchObject([{ subscription: 'octo-tags', status: 'delivered' }])
  })

  it('lists config and agent subscriptions with their origin', async () => {
    const { bus } = await harness()
    await bus.subscribe(tags)
    const listed = bus.listSubscriptions()
    expect(listed.map(entry => [entry.id, entry.origin])).toEqual([['releases', 'config'], ['octo-tags', 'agent']])
    expect(listed[0]).not.toHaveProperty('createdAt')
    expect(listed[1]).not.toHaveProperty('createdBy')
  })

  it('rejects an id already used by config or by a stored subscription', async () => {
    const { bus } = await harness()
    await bus.subscribe(tags)
    for (const id of ['releases', 'octo-tags']) {
      const error = await bus.subscribe({ ...tags, id }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(LsySubscriptionError)
      expect(error).toMatchObject({ code: 'duplicate_id' })
    }
  })

  it('rejects an invalid subscription with the shared validation message', async () => {
    const { bus } = await harness()
    const error = await bus.subscribe({ ...triage, session: { ...triage.session!, workspacePath: 'relative' } }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'invalid_subscription', message: expect.stringMatching(/absolute session.workspacePath/) })
    expect(bus.listSubscriptions()).toHaveLength(1)
  })

  it('keeps agent subscriptions and their pending events across restarts', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness({ pool })
    await first.bus.subscribe(tags, { createdBy: 's1' })
    await first.bus.publish(tag('v1'))
    await first.ctx.fiber.dispose()

    const second = await harness({ pool })
    expect(second.bus.listSubscriptions().map(entry => entry.id)).toEqual(['releases', 'octo-tags'])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(second.notes).toEqual([expect.objectContaining({ title: 'octo-tags: 1 event(s)' })])
    expect(await second.bus.publish(tag('v2'))).toBe('accepted')
  })

  it('starts Sessions for a session subscription created at run time', async () => {
    const { bus, runtime, notes, emit } = await harness()
    await bus.subscribe(triage)
    await bus.publish(release(7))
    await vi.advanceTimersByTimeAsync(1_000)
    const delivery = runtime.deliveries.find(entry => entry.source === 'octo-triage')!
    expect(delivery.kind).toBe(LSY_EVENT_KIND)
    const request = await runtime.rules[0]!.run(delivery, new AbortController().signal)
    expect(request).toMatchObject({ workspacePath: '/Users/dsh-runtime/work', agentPreset: 'unattended', title: 'octo-triage: octo/repo v7.0.0' })
    expect(request!.prompt.startsWith('Read the release notes')).toBe(true)

    emit('w1', sessionEvents.webhook(delivery.deliveryId, 'octo-triage'))
    emit('w1', sessionEvents.assistant('Upgrade when convenient.'))
    emit('w1', sessionEvents.turnEnd())
    await vi.advanceTimersByTimeAsync(0)
    expect(notes.at(-1)).toMatchObject({ title: '✅ octo-triage: octo/repo v7.0.0', body: 'Upgrade when convenient.' })
  })
})

describe('LsyEventBus unsubscribe', () => {
  it('refuses config-owned ids and reports unknown ids', async () => {
    const { bus } = await harness()
    expect(await bus.unsubscribe('releases')).toBe('config_owned')
    expect(await bus.unsubscribe('missing')).toBe('not_found')
    expect(bus.listSubscriptions().map(entry => entry.id)).toEqual(['releases'])
  })

  it('removes an agent subscription with its pending events and flush timer', async () => {
    const { bus, notes } = await harness()
    await bus.subscribe(tags)
    await bus.publish(tag('v1'))
    expect(bus.pendingCount()).toBe(1)
    expect(await bus.unsubscribe('octo-tags')).toBe('removed')
    expect(bus.pendingCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(notes).toHaveLength(0)
    expect(bus.listSubscriptions().map(entry => entry.id)).toEqual(['releases'])
    expect(await bus.publish(tag('v2'))).toBe('unmatched')
    expect(await bus.unsubscribe('octo-tags')).toBe('not_found')
  })

  it('keeps other subscriptions\' pending events', async () => {
    const { bus, notes } = await harness()
    await bus.subscribe({ ...tags, kinds: ['github.release'] })
    await bus.publish(release(1))
    expect(bus.pendingCount()).toBe(2)
    await bus.unsubscribe('octo-tags')
    expect(bus.pendingCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(notes.map(note => note.title)).toEqual(['releases: 1 event(s)'])
  })

  it('lets an id be reused after it was removed', async () => {
    const { bus } = await harness()
    await bus.subscribe(tags)
    await bus.unsubscribe('octo-tags')
    await expect(bus.subscribe({ ...tags, action: 'session', session: triage.session! })).resolves.toMatchObject({ id: 'octo-tags', action: 'session' })
  })
})

describe('LsyEventBus subscription status', () => {
  it('reports pending events, the next flush, the last batch, and batches in the last hour', async () => {
    const { bus } = await harness()
    await bus.subscribe(tags)
    await bus.publish(tag('v1'))
    expect(bus.listSubscriptions()[1]!.status).toEqual({ pending: 1, batchesLastHour: 0, nextFlushAt: Date.now() + 30_000 })

    await vi.advanceTimersByTimeAsync(30_000)
    const batchAt = Date.now()
    await bus.publish(tag('v2'))
    await vi.advanceTimersByTimeAsync(30_000)
    const status = bus.listSubscriptions()[1]!.status
    expect(status).toMatchObject({ pending: 0, batchesLastHour: 2 })
    expect(status.lastBatch).toMatchObject({ createdAt: batchAt + 30_000, status: 'delivered' })
    expect(status).not.toHaveProperty('nextFlushAt')

    await vi.advanceTimersByTimeAsync(HOUR)
    expect(bus.listSubscriptions()[1]!.status).toMatchObject({ batchesLastHour: 0, lastBatch: { status: 'delivered' } })
  })

  it('reports the Session outcome of the last batch', async () => {
    const { bus, runtime, emit } = await harness()
    await bus.subscribe(triage)
    await bus.publish(release(1))
    await vi.advanceTimersByTimeAsync(1_000)
    emit('w1', sessionEvents.webhook(runtime.deliveries[0]!.deliveryId, 'octo-triage'))
    emit('w1', sessionEvents.turnEnd('error'))
    await vi.advanceTimersByTimeAsync(0)
    expect(bus.listSubscriptions()[1]!.status.lastBatch).toMatchObject({ status: 'completed', outcome: 'error', sessionId: 'w1' })
  })

  it('orders run-time subscriptions by creation and reports failures and title prefixes', async () => {
    const { bus } = await harness({ notifier: false })
    await bus.subscribe(tags)
    vi.setSystemTime(Date.now() + 1_000)
    await bus.subscribe({ ...triage, session: { ...triage.session!, titlePrefix: 'Upgrade check' } })
    await bus.publish(tag('v1'))
    await vi.advanceTimersByTimeAsync(30_000)
    const [, first, second] = bus.listSubscriptions()
    expect(first).toMatchObject({ id: 'octo-tags', status: { lastBatch: { status: 'failed', error: 'no lsyNotifier service is mounted', eventCount: 1 } } })
    expect(second).toMatchObject({ id: 'octo-triage', session: { titlePrefix: 'Upgrade check' } })
  })

  it('lists only config subscriptions before its storage domain opens', async () => {
    // Not registered for teardown: disposal would wait for the never-opening domain.
    const ctx = new Context()
    await ctx.plugin(Timer)
    ctx.provide('storageDomain', { open: () => new Promise(() => {}) } as never)
    await ctx.plugin(LsyEventBus, baseConfig)
    expect(ctx.lsyEventBus.listSubscriptions()).toEqual([
      expect.objectContaining({ id: 'releases', origin: 'config', status: { pending: 0, batchesLastHour: 0 } }),
    ])
  })
})

describe('subscriptionProblem', () => {
  const session = triage.session!
  it.each([
    ['a non-object', null, /must be an object/],
    ['an empty id', { ...tags, id: ' ' }, /id must be non-empty/],
    ['a non-string id', { ...tags, id: 7 }, /id must be non-empty/],
    ['a selector that is not a string list', { ...tags, kinds: [1] }, /kinds must be a list of strings/],
    ['a selector that is not a list', { ...tags, subjects: 'octo/repo' }, /subjects must be a list of strings/],
    ['an unknown action', { ...tags, action: 'email' }, /action must be "notify" or "session"/],
    ['a negative coalesce window', { ...tags, coalesceMs: -1 }, /coalesceMs must be a non-negative integer/],
    ['a fractional coalesce window', { ...tags, coalesceMs: 1.5 }, /coalesceMs must be a non-negative integer/],
    ['a zero hourly limit', { ...tags, maxPerHour: 0 }, /maxPerHour must be a positive integer/],
    ['a session subscription without session settings', { ...triage, session: undefined }, /absolute session.workspacePath/],
    ['a relative workspace', { ...triage, session: { ...session, workspacePath: 'work' } }, /absolute session.workspacePath/],
    ['missing instructions', { ...triage, session: { ...session, instructions: ' ' } }, /needs session.instructions/],
    ['an empty agent preset', { ...triage, session: { ...session, agentPreset: '' } }, /session.agentPreset must be non-empty/],
    ['an empty permission preset', { ...triage, session: { ...session, permissionPreset: '' } }, /session.permissionPreset must be non-empty/],
    ['a zero prompt event bound', { ...triage, session: { ...session, maxPromptEvents: 0 } }, /session.maxPromptEvents must be a positive integer/],
    ['a zero text bound', { ...triage, session: { ...session, maxTextChars: 0 } }, /session.maxTextChars must be a positive integer/],
    ['a non-string title prefix', { ...triage, session: { ...session, titlePrefix: 3 } }, /session.titlePrefix must be a string/],
  ])('reports %s', (_label, value, message) => {
    expect(subscriptionProblem(value)).toMatch(message)
  })

  it('accepts valid notify and session subscriptions', () => {
    expect(subscriptionProblem(tags)).toBeUndefined()
    expect(subscriptionProblem(triage)).toBeUndefined()
    expect(subscriptionProblem({ ...triage, session: { ...session, titlePrefix: 'x' } })).toBeUndefined()
  })
})
