import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import LsyEventBus, { LSY_EVENT_KIND, type Config } from '../src/index.ts'
import type { LsyNote } from '../src/types.ts'
import { HOUR, baseConfig, disposeAll, fakeRuntime, harness, release, sessionConfig, withConfig } from './harness.ts'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'))
})

afterEach(async () => {
  await disposeAll()
  vi.useRealTimers()
})

describe('LsyEventBus publish', () => {
  it('accepts a matching event and notifies once after the coalesce window', async () => {
    const { bus, notes } = await harness()
    expect(await bus.publish(release(1))).toBe('accepted')
    await vi.advanceTimersByTimeAsync(59_000)
    expect(notes).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.title).toBe('releases: 1 event(s)')
    expect(bus.batches()).toMatchObject([{ subscription: 'releases', action: 'notify', status: 'delivered', eventIds: ['github:octo/repo:release:1'] }])
  })

  it('reports duplicates and does not dispatch them twice', async () => {
    const { bus, notes } = await harness()
    expect(await bus.publish(release(1))).toBe('accepted')
    expect(await bus.publish(release(1))).toBe('duplicate')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(notes).toHaveLength(1)
    expect(await bus.publish(release(1))).toBe('duplicate')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(notes).toHaveLength(1)
  })

  it('suppresses events caused by the agent itself', async () => {
    const { bus, notes } = await harness()
    expect(await bus.publish(release(1, { actor: 'DSH-Bot' }))).toBe('suppressed')
    expect(await bus.publish(release(2, { text: 'body\n\nDsh-Agent: run-1' }))).toBe('suppressed')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(notes).toHaveLength(0)
    expect(bus.events().map(event => [event.outcome, event.reason])).toEqual([
      ['suppressed', 'actor:dsh-bot'],
      ['suppressed', 'marker:Dsh-Agent:'],
    ])
  })

  it('records unmatched events without dispatching', async () => {
    const { bus, notes } = await harness()
    expect(await bus.publish(release(1, { kind: 'github.commit' }))).toBe('unmatched')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(notes).toHaveLength(0)
    expect(bus.events()[0]!.outcome).toBe('unmatched')
  })

  it('rejects malformed events and bounds stored text', async () => {
    const { bus } = await harness({ config: withConfig(baseConfig, { maxTextChars: 5 }) })
    await expect(bus.publish({ ...release(1), key: ' ' })).rejects.toThrow(/key/)
    await expect(bus.publish({ ...release(1), title: '' })).rejects.toThrow(/title/)
    await bus.publish(release(2, { text: '0123456789' }))
    expect(bus.events()[0]!.text).toBe('01234…')
  })
})

describe('LsyEventBus batching', () => {
  it('coalesces events that arrive within one window into one batch', async () => {
    const { bus, notes } = await harness()
    await bus.publish(release(1))
    await vi.advanceTimersByTimeAsync(30_000)
    await bus.publish(release(2))
    await bus.publish(release(3))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.title).toBe('releases: 3 event(s)')
    expect(bus.batches()[0]!.eventIds).toHaveLength(3)
  })

  it('defers batches beyond maxPerHour until the hourly window frees up', async () => {
    const { bus, notes } = await harness()
    await bus.publish(release(1))
    await vi.advanceTimersByTimeAsync(60_000)
    await bus.publish(release(2))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(notes).toHaveLength(2)
    await bus.publish(release(3))
    await bus.publish(release(4))
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(notes).toHaveLength(2)
    // The first batch left the window at T+60s+1h.
    await vi.advanceTimersByTimeAsync(HOUR - 11 * 60_000 + 60_000)
    expect(notes).toHaveLength(3)
    expect(notes[2]!.title).toBe('releases: 2 event(s)')
  })

  it('restores pending events after a restart and flushes them', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness({ pool })
    await first.bus.publish(release(1))
    await first.ctx.fiber.dispose()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(first.notes).toHaveLength(0)

    const second = await harness({ pool })
    expect(await second.bus.publish(release(1))).toBe('duplicate')
    await vi.advanceTimersByTimeAsync(0)
    expect(second.notes).toHaveLength(1)
    expect(second.notes[0]!.title).toBe('releases: 1 event(s)')
  })

  it('drops pending rows of subscriptions that no longer exist', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness({ pool })
    await first.bus.publish(release(1))
    await first.ctx.fiber.dispose()

    const second = await harness({ pool, config: withConfig(baseConfig, { subscriptions: [] }) })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(second.notes).toHaveLength(0)
    expect(second.bus.pendingCount()).toBe(0)
  })

  it('marks a notify batch failed when no notifier is mounted', async () => {
    const { bus } = await harness({ notifier: false })
    await bus.publish(release(1))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(bus.batches()[0]).toMatchObject({ status: 'failed', error: 'no lsyNotifier service is mounted' })
  })

  it('prunes the oldest settled events beyond retainEvents', async () => {
    const { bus } = await harness({ config: withConfig(baseConfig, { retainEvents: 2 }) })
    await bus.publish(release(1, { kind: 'github.commit' }))
    await bus.publish(release(2, { kind: 'github.commit' }))
    await bus.publish(release(3, { kind: 'github.commit' }))
    expect(bus.events().map(event => event.key)).toEqual(['octo/repo:release:2', 'octo/repo:release:3'])
  })
})

describe('LsyEventBus session actuator', () => {
  it('dispatches session subscriptions through the webhook runtime with a rule that builds the request', async () => {
    const { bus, runtime } = await harness({ config: sessionConfig })
    expect(runtime.rules).toHaveLength(1)
    expect(runtime.rules[0]!.kind).toBe(LSY_EVENT_KIND)

    await bus.publish(release(1))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(runtime.deliveries).toHaveLength(1)
    const delivery = runtime.deliveries[0]!
    expect(delivery).toMatchObject({ kind: LSY_EVENT_KIND, source: 'triage', deliveryId: bus.batches()[0]!.id })

    const request = await runtime.rules[0]!.run(delivery, new AbortController().signal)
    expect(request).toMatchObject({ workspacePath: '/work/space', agentPreset: 'unattended', permissionPreset: 'danger-full-access', title: 'triage: octo/repo v1.0.0' })
    expect(request!.prompt).toContain('Triage these events.')
  })

  it('returns null for deliveries of unknown or non-session subscriptions', async () => {
    const subscriptions = [...sessionConfig.subscriptions, ...baseConfig.subscriptions]
    const { runtime } = await harness({ config: withConfig(sessionConfig, { subscriptions }) })
    const rule = runtime.rules[0]!
    const signal = new AbortController().signal
    const delivery = (source: string) => ({ kind: LSY_EVENT_KIND, source, deliveryId: 'x', receivedAt: 1, event: { subscription: source, events: [] } }) as never
    expect(await rule.run(delivery('missing'), signal)).toBeNull()
    expect(await rule.run(delivery('releases'), signal)).toBeNull()
  })

  it('marks a session batch failed when no webhook runtime is mounted', async () => {
    const { bus } = await harness({ config: sessionConfig, runtime: false })
    await bus.publish(release(1))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(bus.batches()[0]).toMatchObject({ status: 'failed', error: 'no webhookRuntime service is mounted' })
  })

  it('notifies the Session result when the webhook Session ends its first turn', async () => {
    const { ctx, bus, notes } = await harness({ config: sessionConfig })
    await bus.publish(release(1))
    await vi.advanceTimersByTimeAsync(1_000)
    const batch = bus.batches()[0]!
    const session = { id: 'webhook-123' }
    const emit = (event: unknown): void => { (ctx.emit as (...args: unknown[]) => void)('session/event', session, event) }

    emit({ type: 'user/message', seq: 1, data: { role: 'user', content: [{ type: 'text', text: 'prompt' }], source: { kind: 'webhook', provider: LSY_EVENT_KIND, source: 'triage', deliveryId: batch.id, ruleId: 'lsy-event', form: 'notice' } } })
    emit({ type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'draft' }] } } })
    emit({ type: 'assistant/message', seq: 3, data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'Final answer.' }] } } })
    emit({ type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.advanceTimersByTimeAsync(0)

    expect(notes).toEqual([{ title: '✅ triage: octo/repo v1.0.0', body: 'Final answer.', url: 'https://dsh.example/' }])
    expect(bus.batches()[0]).toMatchObject({ status: 'completed', sessionId: 'webhook-123', outcome: 'completed' })

    // Later turns of the same Session are not reported again.
    emit({ type: 'turn/end', seq: 5, data: { turn: 2, reason: { kind: 'completed' } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(notes).toHaveLength(1)
  })

  it('ignores Sessions that were not created by this bus', async () => {
    const { ctx, notes } = await harness({ config: sessionConfig })
    const emit = (event: unknown): void => { (ctx.emit as (...args: unknown[]) => void)('session/event', { id: 's' }, event) }
    emit({ type: 'user/message', seq: 1, data: { role: 'user', content: [], source: { kind: 'webhook', provider: 'github', source: 'x', deliveryId: 'y' } } })
    emit({ type: 'user/message', seq: 2, data: { role: 'user', content: [], source: { kind: 'human' } } })
    emit({ type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(notes).toHaveLength(0)
  })
})

describe('LsyEventBus configuration', () => {
  const session = { workspacePath: '/w', agentPreset: 'standard', permissionPreset: 'read-only', instructions: 'Do it.', maxPromptEvents: 5, maxTextChars: 100 }
  const sub = { sources: [], kinds: [], subjects: [], coalesceMs: 0, maxPerHour: 1 }

  it.each([
    ['an empty subscription id', [{ ...sub, id: ' ', action: 'notify' as const }], /id must be non-empty/],
    ['duplicate subscription ids', [{ ...sub, id: 'a', action: 'notify' as const }, { ...sub, id: 'a', action: 'notify' as const }], /duplicate subscription id "a"/],
    ['a session subscription without an absolute workspace', [{ ...sub, id: 'a', action: 'session' as const, session: { ...session, workspacePath: 'relative' } }], /absolute session.workspacePath/],
    ['a session subscription without instructions', [{ ...sub, id: 'a', action: 'session' as const, session: { ...session, instructions: ' ' } }], /needs session.instructions/],
  ])('rejects %s at load', (_label, subscriptions, message) => {
    expect(() => new LsyEventBus(new Context(), withConfig(baseConfig, { subscriptions }))).toThrow(message)
  })
})

describe('LsyEventBus failure handling', () => {
  it('records notifier failures on the batch', async () => {
    const { ctx, bus } = await harness({ notifier: false })
    let calls = 0
    ctx.provide('lsyNotifier', { send: async () => { calls += 1; throw calls === 1 ? new Error('telegram down') : 'plain failure' } })
    await bus.publish(release(1))
    await vi.advanceTimersByTimeAsync(60_000)
    await bus.publish(release(2))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(bus.batches().map(batch => [batch.status, batch.error])).toEqual([['failed', 'telegram down'], ['failed', 'plain failure']])
  })

  it('records webhook dispatch failures on the batch', async () => {
    const runtime = fakeRuntime()
    runtime.dispatch = () => { throw new Error('runtime is closing') }
    const { bus } = await harness({ config: sessionConfig, runtime })
    await bus.publish(release(1))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(bus.batches()[0]).toMatchObject({ status: 'failed', error: 'runtime is closing' })
  })

  it('rejects a publish whose write fails and keeps serving later publishes', async () => {
    const { bus, pool } = await harness()
    pool.failNextWrites = 1
    await expect(bus.publish(release(1))).rejects.toThrow()
    expect(await bus.publish(release(2))).toBe('accepted')
  })

  it('rejects malformed deliveries in the webhook rule', async () => {
    const { runtime } = await harness({ config: sessionConfig })
    const delivery = { kind: LSY_EVENT_KIND, source: 'triage', deliveryId: 'x', receivedAt: 1, event: { subscription: 'triage', events: [{ id: 1 }] } } as never
    expect(await runtime.rules[0]!.run(delivery, new AbortController().signal)).toBeNull()
  })
})

describe('LsyEventBus Session observation', () => {
  async function started(config: Config = sessionConfig, notifier: LsyNote[] | 'none' | 'reject' = []) {
    const h = await harness({ config, notifier: false })
    if (notifier === 'reject') h.ctx.provide('lsyNotifier', { send: async () => { throw new Error('down') } })
    else if (notifier !== 'none') h.ctx.provide('lsyNotifier', { send: async (note: LsyNote) => { h.notes.push(note) } })
    await h.bus.publish(release(1, { actor: 'octocat', text: 'notes', occurredAt: 123 }))
    await vi.advanceTimersByTimeAsync(1_000)
    const batch = h.bus.batches()[0]!
    const emit = (sessionId: string, event: unknown): void => { (h.ctx.emit as (...args: unknown[]) => void)('session/event', { id: sessionId }, event) }
    const userMessage = { type: 'user/message', seq: 1, data: { role: 'user', content: [], source: { kind: 'webhook', provider: LSY_EVENT_KIND, source: 'triage', deliveryId: batch.id, ruleId: 'lsy-event', form: 'notice' } } }
    return { ...h, batch, emit, userMessage }
  }

  it('carries every optional event field into the delivery', async () => {
    const { runtime } = await started()
    expect(runtime.deliveries[0]!.event).toMatchObject({ events: [{ actor: 'octocat', text: 'notes', occurredAt: 123, url: 'https://github.com/octo/repo/releases/v1.0.0' }] })
  })

  it('tracks a Session once and reports missing assistant text', async () => {
    const { emit, userMessage, notes, bus } = await started()
    emit('s1', userMessage)
    emit('s1', userMessage)
    emit('other', { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'not mine' }] } } })
    emit('s1', { type: 'assistant/message', seq: 3, data: { message: { content: [null, { type: 'text', text: '   ' }, { type: 'image' }] } } })
    emit('s1', { type: 'step/start', seq: 4, data: { turn: 1, step: 1 } })
    emit('s1', { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'error' } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(notes).toEqual([{ title: '⚠️ triage: octo/repo v1.0.0 (error)', body: '(no assistant text)', url: 'https://dsh.example/' }])
    expect(bus.batches()[0]).toMatchObject({ status: 'completed', outcome: 'error', sessionId: 's1' })
  })

  it('records the outcome without a message when result notifications are off', async () => {
    const { emit, userMessage, notes, bus } = await started(withConfig(sessionConfig, { notifySessionResult: false }))
    emit('s1', userMessage)
    emit('s1', { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(notes).toHaveLength(0)
    expect(bus.batches()[0]!.status).toBe('completed')
  })

  it('records the outcome when no notifier is mounted', async () => {
    const quiet = await started(sessionConfig, 'none')
    quiet.emit('s1', quiet.userMessage)
    quiet.emit('s1', { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(quiet.bus.batches()[0]!.status).toBe('completed')
  })

  it('survives a notifier that rejects the result message', async () => {
    const h = await started(sessionConfig, 'reject')
    h.emit('s1', h.userMessage)
    h.emit('s1', { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.bus.batches()[0]!.status).toBe('completed')
  })

  it('ignores Session updates for batches that were already pruned', async () => {
    const h = await started(withConfig(sessionConfig, { retainBatches: 1 }))
    await h.bus.publish(release(2))
    await vi.advanceTimersByTimeAsync(1_000)
    h.emit('s1', h.userMessage)
    h.emit('s1', { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.bus.batches().map(batch => batch.id)).not.toContain(h.batch.id)
    expect(h.notes[0]!.title).toBe('✅ triage')
  })
})

describe('LsyEventBus edges', () => {
  it('omits absent optional fields from stored events and deliveries', async () => {
    const { bus, runtime } = await harness({ config: sessionConfig })
    await bus.publish(release(1, { url: undefined }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect('url' in bus.events()[0]!).toBe(false)
    expect('url' in (runtime.deliveries[0]!.event as { events: object[] }).events[0]!).toBe(false)
  })

  it('reads as empty before its storage domain opens', async () => {
    // Not registered for teardown: disposal would wait for the never-opening domain.
    const ctx = new Context()
    await ctx.plugin(Timer)
    ctx.provide('storageDomain', { open: () => new Promise(() => {}) } as never)
    await ctx.plugin(LsyEventBus, baseConfig)
    expect(ctx.lsyEventBus.events()).toEqual([])
    expect(ctx.lsyEventBus.batches()).toEqual([])
    expect(ctx.lsyEventBus.pendingCount()).toBe(0)
  })
})
