import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { createDelivery, SOURCE_KIND, type DeliveryContext } from '../src/delivery.ts'
import { errorText } from '../src/error-text.ts'
import type { MonitorNotice, MonitorView } from '../src/monitor.ts'

const VIEW: MonitorView = { id: 'm1', description: 'globe errors', command: 'tail -F app.log', status: 'running', startedAt: 0, lines: 0, notices: 0 }
const LINES: MonitorNotice = { kind: 'lines', lines: ['boom'], dropped: 0 }

interface World {
  readonly loaded?: 'idle' | 'running'
  /** What Session persistence says: a stored header, nothing, or a failure. */
  readonly stored?: { header: { origin?: 'subagent' } } | 'missing' | 'error'
  readonly resolved?: 'agent' | 'not-found' | 'broken' | 'error-instance' | 'code-only'
  stopped?: boolean
  /** Disposal begins while the agent is loading. */
  readonly stopWhileLoading?: boolean
}

/** A context with just the services delivery reads, and what the agent and the logger received. */
function fixture(world: World) {
  const followups: UserMessage[] = []
  const injected: UserMessage[] = []
  const warnings: string[] = []
  const agent = { status: world.loaded ?? 'idle', followup: (message: UserMessage) => { followups.push(message) }, inject: (message: UserMessage) => { injected.push(message) } }
  const resolveAgent = vi.fn(() => {
    if (world.stopWhileLoading === true) world.stopped = true
    return Promise.resolve(
      world.resolved === 'not-found' ? { error: { code: 'session/not-found' } }
        : world.resolved === 'broken' ? { error: { code: 'session/busy', message: 'held by another writer' } }
          : world.resolved === 'error-instance' ? { error: Object.assign(new Error('resume failed: lock timeout'), { code: 'session/busy' }) }
            : world.resolved === 'code-only' ? { error: { code: 'session/unavailable' } }
              : { agent },
    )
  })
  const ctx = {
    get: (service: string) => service === 'agents' ? { get: () => world.loaded === undefined ? undefined : agent } : undefined,
    sessionPersistence: {
      stat: () => world.stored === 'error' ? Promise.reject(new Error('index offline')) : Promise.resolve(world.stored === 'missing' ? undefined : world.stored ?? { header: {} }),
    },
    sessionController: { resolveAgent },
    logger: { info: () => {}, warn: (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) } },
  } satisfies DeliveryContext
  const delivery = createDelivery(ctx, () => world.stopped ?? false)
  return { delivery, followups, injected, warnings, resolveAgent }
}

describe('delivery', () => {
  it('wakes a loaded idle agent and injects into a busy one, as a notice from the plugin', async () => {
    const idle = fixture({ loaded: 'idle' })
    expect(idle.delivery.deliver('s1', VIEW, LINES)).toBe(true)
    expect(idle.followups).toHaveLength(1)
    expect(idle.followups[0]!.source).toMatchObject({ kind: SOURCE_KIND, form: 'notice', summary: 'monitor m1: 1 line(s)' })

    const busy = fixture({ loaded: 'running' })
    expect(busy.delivery.deliver('s1', VIEW, { kind: 'ended', reason: 'exit 0', stderr: [] })).toBe(true)
    expect(busy.injected).toHaveLength(1)
    expect(busy.injected[0]!.source).toMatchObject({ summary: 'monitor m1 ended' })
    expect(busy.followups).toHaveLength(0)
  })

  it('loads an unloaded agent that persistence knows, then sends', async () => {
    const world = fixture({ stored: { header: {} } })
    expect(await world.delivery.deliver('s1', VIEW, LINES)).toBe(true)
    expect(world.resolveAgent).toHaveBeenCalledOnce()
    expect(world.followups).toHaveLength(1)
  })

  it('reports a gone Session: unknown to persistence, a subagent\'s, or not found on load', async () => {
    expect(await fixture({ stored: 'missing' }).delivery.deliver('s1', VIEW, LINES)).toBe(false)
    expect(await fixture({ stored: { header: { origin: 'subagent' } } }).delivery.deliver('s1', VIEW, LINES)).toBe(false)
    expect(await fixture({ stored: { header: {} }, resolved: 'not-found' }).delivery.deliver('s1', VIEW, LINES)).toBe(false)
  })

  it('keeps the monitor when the Session exists but cannot take a notice now, and says so', async () => {
    const world = fixture({ stored: { header: {} }, resolved: 'broken' })
    expect(await world.delivery.deliver('s1', VIEW, LINES)).toBe(true)
    expect(world.followups).toHaveLength(0)
    expect(world.warnings.join('\n')).toContain('cannot take a notice now')

    const offline = fixture({ stored: 'error' })
    expect(await offline.delivery.deliver('s1', VIEW, LINES)).toBe(true)
    expect(offline.warnings.join('\n')).toContain('index offline')
  })

  it('keeps the monitor and logs the Error itself, or the code when the failure has no message', async () => {
    const thrown = fixture({ stored: { header: {} }, resolved: 'error-instance' })
    expect(await thrown.delivery.deliver('s1', VIEW, LINES)).toBe(true)
    expect(thrown.warnings.join('\n')).toContain('resume failed: lock timeout')

    const bare = fixture({ stored: { header: {} }, resolved: 'code-only' })
    expect(await bare.delivery.deliver('s1', VIEW, LINES)).toBe(true)
    expect(bare.warnings.join('\n')).toContain('session/unavailable')
    expect(bare.followups).toHaveLength(0)
  })

  it('drops a notice whose agent finished loading after disposal began', async () => {
    const world = fixture({ stored: { header: {} }, stopWhileLoading: true })
    expect(await world.delivery.deliver('s1', VIEW, LINES)).toBe(true)
    expect(world.resolveAgent).toHaveBeenCalledOnce()
    expect(world.followups).toHaveLength(0)
    expect(world.injected).toHaveLength(0)
  })

  it('delivers nothing once disposal has begun', async () => {
    const world = fixture({ stored: { header: {} }, stopped: true })
    expect(await world.delivery.deliver('s1', VIEW, LINES)).toBe(true)
    expect(world.resolveAgent).not.toHaveBeenCalled()
    expect(world.followups).toHaveLength(0)
  })

  it('counts a loaded agent as alive, asks persistence otherwise, and treats a failed lookup as no answer', async () => {
    expect(await fixture({ loaded: 'idle', stored: 'missing' }).delivery.alive('s1')).toBe(true)
    expect(await fixture({ stored: { header: {} } }).delivery.alive('s1')).toBe(true)
    expect(await fixture({ stored: 'missing' }).delivery.alive('s1')).toBe(false)
    const failing = fixture({ stored: 'error' })
    expect(await failing.delivery.alive('s1')).toBe(true)
    expect(failing.warnings.join('\n')).toMatch(/cannot tell whether session .* index offline/u)
    expect(await fixture({ stored: 'missing', stopped: true }).delivery.alive('s1')).toBe(true)
  })
})

describe('errorText', () => {
  it('reads the message of an Error and the string form of anything else', () => {
    expect(errorText(new Error('boom'))).toBe('boom')
    expect(errorText('plain')).toBe('plain')
    expect(errorText(42)).toBe('42')
  })
})
