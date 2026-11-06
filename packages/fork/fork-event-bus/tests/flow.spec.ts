import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findCycle, flowResultKind, ForkFlowError } from '../src/index.ts'
import type { ForkNote, Subscription } from '../src/types.ts'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { baseConfig, disposeAll, harness, release, sessionEvents, withConfig } from './harness.ts'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-06T00:00:00.000Z'))
})

afterEach(async () => {
  await disposeAll()
  vi.useRealTimers()
})

const session = {
  workspacePath: '/work', agentPreset: 'unattended', permissionPreset: 'danger-full-access', instructions: 'Say what matters.',
  maxPromptEvents: 50, maxTextChars: 2000,
}

const ci: Subscription = {
  id: 'ci', sources: ['github'], kinds: ['github.release'], subjects: [], action: 'session', coalesceMs: 0, maxPerHour: 10, session,
}

const desk: Subscription = {
  id: 'desk', sources: ['host'], kinds: ['host.*'], subjects: [], action: 'session', coalesceMs: 0, maxPerHour: 10, session,
}

const config = withConfig(baseConfig, { subscriptions: [ci, desk] })

describe('findCycle', () => {
  const chain = (id: string, kinds: string[]): Subscription => ({
    ...ci, id, sources: ['flow'], kinds, session: { ...session, result: 'event' },
  })

  it('finds a loop of answers and passes a chain', () => {
    expect(findCycle([chain('a', [flowResultKind('b')]), chain('b', [flowResultKind('a')])])).toEqual(['a', 'b', 'a'])
    expect(findCycle([chain('a', ['flow.other.result']), { ...chain('b', [flowResultKind('a')]), session }])).toBeUndefined()
  })
})

describe('editFlow', () => {
  it('changes a configuration route, and a new bus over the same storage keeps the change', async () => {
    const pool = new MemoryMediaPool()
    const { bus, ctx } = await harness({ config, pool })
    const { route, change } = await bus.editFlow({ op: 'set', id: 'ci', patch: { kinds: ['github.*'], session: { instructions: 'New.' } } }, { by: 's1', note: 'wider' })
    expect(route).toMatchObject({ origin: 'config', kinds: ['github.*'], changed: { by: 's1' }, session: { instructions: 'New.', agentPreset: 'unattended' } })
    expect(change).toMatchObject({ op: 'set', route: 'ci', by: 's1', note: 'wider' })
    expect(JSON.parse(change.before ?? '{}')).toMatchObject({ kinds: ['github.release'] })

    await ctx.fiber.dispose()
    const { bus: after } = await harness({ config, pool })
    expect(after.listSubscriptions().find(row => row.id === 'ci')?.kinds).toEqual(['github.*'])
    expect(await after.publish(release(9, { kind: 'github.tag', key: 'x' }))).toBe('accepted')
  })

  it('takes a configuration route out and puts it back as the deployment wrote it', async () => {
    const { bus } = await harness({ config })
    await bus.editFlow({ op: 'set', id: 'ci', patch: { kinds: ['github.tag'] } })
    await bus.editFlow({ op: 'remove', id: 'ci' })
    expect(bus.listSubscriptions().map(row => row.id)).toEqual(['desk'])
    expect(bus.flowRoutes().find(row => row.id === 'ci')?.removed).toBe(true)
    expect(await bus.publish(release(1))).toBe('unmatched')

    const { route } = await bus.editFlow({ op: 'reset', id: 'ci' })
    expect(route).toMatchObject({ kinds: ['github.release'] })
    expect(route?.changed).toBeUndefined()
    expect(await bus.publish(release(2))).toBe('accepted')
  })

  it('pauses a configuration route so it takes no new events', async () => {
    const { bus } = await harness({ config })
    await bus.editFlow({ op: 'pause', id: 'ci' })
    expect(bus.flowRoutes().find(row => row.id === 'ci')?.paused).toBe(true)
    expect(await bus.publish(release(1))).toBe('unmatched')
    await bus.editFlow({ op: 'resume', id: 'ci' })
    expect(await bus.publish(release(2))).toBe('accepted')
  })

  it('creates, changes and removes a run-time route with the fields a watch cannot set', async () => {
    const pool = new MemoryMediaPool()
    const { bus, ctx } = await harness({ config, pool })
    await bus.editFlow({
      op: 'set',
      id: 'new-one',
      patch: {
        sources: ['host'], kinds: ['host.x'], action: 'session',
        session: { ...session, result: 'quiet', model: { provider: 'p', model: 'm' }, persistent: { enabled: true, key: 'subject', rolloverDays: 30, maxSeedChars: 100 } },
      },
    }, { by: 's1' })
    await bus.editFlow({ op: 'set', id: 'new-one', patch: { maxPerHour: 2 } })
    await ctx.fiber.dispose()
    const { bus: again } = await harness({ config, pool })
    expect(again.flowRoutes().find(row => row.id === 'new-one')).toMatchObject({
      origin: 'agent', createdBy: 's1', maxPerHour: 2, result: 'quiet', session: { model: { provider: 'p', model: 'm' }, persistent: { key: 'subject' } },
    })
    const { route } = await again.editFlow({ op: 'remove', id: 'new-one' })
    expect(route).toBeNull()
  })

  it('refuses a route that cannot run, takes everything, or does not exist', async () => {
    const { bus } = await harness({ config })
    const code = async (work: Promise<unknown>): Promise<string> => work.then(() => 'ok', (error: ForkFlowError) => error.code)
    expect(await code(bus.editFlow({ op: 'set', id: 'x', patch: { sources: ['host'], action: 'session', session: { instructions: 'x' } } }))).toBe('invalid_route')
    expect(await code(bus.editFlow({ op: 'set', id: 'x', patch: { action: 'notify' } }))).toBe('invalid_route')
    expect(await code(bus.editFlow({ op: 'set', id: 'ci', patch: { session: { result: 'nope' as 'quiet' } } }))).toBe('invalid_route')
    expect(await code(bus.editFlow({ op: 'remove', id: 'x' }))).toBe('not_found')
    expect(await code(bus.editFlow({ op: 'reset', id: 'x' }))).toBe('not_config')
    expect(bus.flowHistory()).toEqual([])
  })

  it('refuses a loop and leaves the routes as they were', async () => {
    const { bus } = await harness({ config })
    await bus.editFlow({ op: 'set', id: 'ci', patch: { session: { result: 'event' } } })
    await bus.editFlow({ op: 'set', id: 'desk', patch: { sources: ['host', 'flow'], kinds: ['host.*', flowResultKind('ci')], session: { result: 'event' } } })
    await expect(bus.editFlow({ op: 'set', id: 'ci', patch: { sources: ['github', 'flow'], kinds: ['github.release', flowResultKind('desk')] } }))
      .rejects.toThrow(ForkFlowError)
    expect(bus.flowRoutes().find(row => row.id === 'ci')).toMatchObject({ kinds: ['github.release'], downstream: ['desk'] })
  })

  it('warns when nothing takes the answer yet', async () => {
    const { bus } = await harness({ config })
    const { warnings } = await bus.editFlow({ op: 'set', id: 'ci', patch: { session: { result: 'event' } } })
    expect(warnings.join()).toContain('flow.ci.result')
  })
})

describe('where an answer goes', () => {
  /** Mount the bus with a notifier whose main agent records what it is told. */
  async function mounted(tellMainAgent?: (message: { text: string }) => Promise<string>) {
    const told: Array<{ text: string }> = []
    const tell = tellMainAgent ?? (async (message: { text: string }) => { told.push(message); return 'chat' })
    const notes: ForkNote[] = []
    const setup = await harness({ config, notifier: { send: async (note: ForkNote) => { notes.push(note) }, tellMainAgent: tell } })
    return { ...setup, notes, told }
  }

  /** Run the next `ci` batch to its turn end with this answer. */
  async function answer(setup: Awaited<ReturnType<typeof harness>>, session: string, text: string, n = 1): Promise<void> {
    await setup.bus.publish(release(n))
    await vi.advanceTimersByTimeAsync(1)
    const delivery = setup.runtime.deliveries.at(-1)
    setup.emit(session, sessionEvents.webhook(String(delivery?.deliveryId), 'ci'))
    setup.emit(session, sessionEvents.assistant(text))
    setup.emit(session, sessionEvents.turnEnd())
    await vi.advanceTimersByTimeAsync(1)
  }

  it('sends to the notifier by default', async () => {
    const setup = await mounted()
    await answer(setup, 's1', 'Look at this.')
    expect(setup.notes.at(-1)?.body).toContain('Look at this.')
    expect(setup.notes.at(-1)?.urgent).toBeUndefined()
    expect(setup.bus.batches().at(-1)?.notSent).toBeUndefined()
  })

  it('marks an urgent route past the do-not-disturb hold', async () => {
    const setup = await mounted()
    await setup.bus.editFlow({ op: 'set', id: 'ci', patch: { session: { result: 'urgent' } } })
    await answer(setup, 's1', 'Now.')
    expect(setup.notes.at(-1)?.urgent).toBe(true)
  })

  it('keeps a quiet route out of the owner count', async () => {
    const setup = await mounted()
    await setup.bus.editFlow({ op: 'set', id: 'ci', patch: { session: { result: 'quiet' } } })
    await answer(setup, 's1', 'Kept.')
    expect(setup.notes).toHaveLength(0)
    expect(setup.bus.batches().at(-1)?.notSent).toBe(true)
  })

  it('gives the answer to the main agent', async () => {
    const setup = await mounted()
    await setup.bus.editFlow({ op: 'set', id: 'ci', patch: { session: { result: 'main' } } })
    await answer(setup, 's1', 'For main.')
    expect(setup.told.at(-1)?.text).toBe('For main.')
    expect(setup.notes).toHaveLength(0)
    expect(setup.bus.batches().at(-1)?.notSent).toBe(true)
  })

  it('tells the owner when the main agent refuses', async () => {
    const setup = await mounted(async () => { throw new Error('busy') })
    await setup.bus.editFlow({ op: 'set', id: 'ci', patch: { session: { result: 'main' } } })
    await answer(setup, 's1', 'Still for you.')
    expect(setup.notes.at(-1)?.body).toContain('Still for you.')
  })

  it('passes the answer on to the next route, and a silent reply stops it', async () => {
    const setup = await mounted()
    await setup.bus.editFlow({ op: 'set', id: 'ci', patch: { session: { result: 'event' } } })
    await setup.bus.editFlow({ op: 'set', id: 'desk', patch: { sources: ['host', 'flow'], kinds: ['host.*', flowResultKind('ci')] } })
    await answer(setup, 's1', 'First line\nmore')
    expect(setup.notes).toHaveLength(0)
    expect(setup.bus.events().at(-1)).toMatchObject({ source: 'flow', kind: 'flow.ci.result', title: 'First line', subscriptions: ['desk'] })
    expect(setup.bus.batches().find(batch => batch.subscription === 'ci')?.notSent).toBe(true)
    expect(setup.runtime.deliveries.at(-1)?.source).toBe('desk')

    await answer(setup, 's2', 'NO_REPLY', 2)
    expect(setup.bus.events().filter(row => row.source === 'flow')).toHaveLength(1)
  })

  it('tells the owner when nothing takes the answer, so it is not lost', async () => {
    const setup = await mounted()
    await setup.bus.editFlow({ op: 'set', id: 'ci', patch: { session: { result: 'event' } } })
    await answer(setup, 's1', 'Nobody home.')
    expect(setup.notes.at(-1)?.body).toContain('Nobody home.')
    expect(setup.bus.batches().at(-1)?.notSent).toBeUndefined()
  })
})
