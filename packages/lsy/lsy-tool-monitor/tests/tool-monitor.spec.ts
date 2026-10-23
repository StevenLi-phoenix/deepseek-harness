import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as Monitor from '../src/index.ts'
import { monitorDomain, type MonitorRecord } from '../src/storage.ts'

const contexts: Context[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** One stored Session; what its agent received outlives a host restart. */
interface FakeSession {
  readonly id: string
  readonly agent: {
    status: 'idle' | 'running'
    session: { id: string; header: { cwd: string; origin?: 'subagent' } }
    followup: (message: UserMessage) => void
    inject: (message: UserMessage) => void
  }
  readonly followups: UserMessage[]
  readonly injected: UserMessage[]
}

/** What survives a host restart: the storage medium and the stored Sessions. */
interface World {
  readonly pool: MemoryMediaPool
  readonly sessions: Map<string, FakeSession>
}

const newWorld = (): World => ({ pool: new MemoryMediaPool(), sessions: new Map() })

/** Store a Session in the world, as Session persistence would. */
function addSession(world: World, id: string, origin?: 'subagent'): FakeSession {
  const followups: UserMessage[] = []
  const injected: UserMessage[] = []
  const session: FakeSession = {
    id,
    agent: {
      status: 'idle',
      session: { id, header: { cwd: tmpdir(), ...origin === undefined ? {} : { origin } } },
      followup: (message) => { followups.push(message) },
      inject: (message) => { injected.push(message) },
    },
    followups,
    injected,
  }
  world.sessions.set(id, session)
  return session
}

/** Mount the memory storage backend and the domain facility on `ctx`. */
async function mountStorage(ctx: Context, pool: MemoryMediaPool): Promise<DomainFacility> {
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  ctx.effect(() => async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => { await facility.closeAll(); unmount() }
  })
  return facility
}

/** Read or change the stored monitor records while no host holds them. */
async function withRecords<T>(world: World, use: (records: Map<string, MonitorRecord>) => T | Promise<T>): Promise<T> {
  const ctx = new Context()
  const facility = await mountStorage(ctx, world.pool)
  const domain = await facility.open(monitorDomain)
  try {
    const table = domain.table('monitors')
    const records = new Map(table.entries())
    const result = await use(records)
    for (const id of [...table.keys()]) if (!records.has(id)) await table.delete(id)
    for (const [id, record] of records) if (table.get(id) !== record) await table.put(id, record)
    return result
  } finally {
    await domain.close()
    await ctx.fiber.dispose()
  }
}

const storedIds = (world: World): Promise<string[]> => withRecords(world, records => [...records.keys()].sort())

/** Printf-style log arguments as the console logger would show them. */
const logText = (args: unknown[]): string => {
  const [head, ...rest] = args
  return String(head).replace(/%[sdo]/gu, () => String(rest.shift()))
}

const until = async (predicate: () => boolean | Promise<boolean>, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => { setTimeout(resolve, 20) })
  }
}

/**
 * Start one host process over `world`. No agent is loaded until something
 * resolves its Session through the Session controller, as after a restart.
 */
async function mount(world: World, options: { storageDomain?: unknown; resolveDelayMs?: number } = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const logs: { type: string; text: string }[] = []
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (message) => { logs.push({ type: message.type, text: logText(message.args) }) },
  })
  const loaded = new Map<string, FakeSession['agent']>()
  const resolved: string[] = []
  ctx.provide('systemPrompt', { tools: () => () => {} } as never)
  ctx.provide('agents', { get: (id: string) => loaded.get(id) } as never)
  ctx.provide('sessionPersistence', {
    stat: (id: string) => {
      const session = world.sessions.get(id)
      return Promise.resolve(session === undefined ? undefined : { header: session.agent.session.header, revision: 1 })
    },
  } as never)
  ctx.provide('sessionController', {
    resolveAgent: async (id: string) => {
      resolved.push(id)
      await new Promise((resolve) => { setTimeout(resolve, options.resolveDelayMs ?? 0) })
      const session = world.sessions.get(id)
      if (session === undefined) return { error: Object.assign(new Error(`session "${id}" not found`), { code: 'session/not-found' }) }
      loaded.set(id, session.agent)
      return { agent: session.agent }
    },
  } as never)
  if (options.storageDomain === undefined) await mountStorage(ctx, world.pool)
  else ctx.provide('storageDomain', options.storageDomain as never)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Monitor)
  const call = async (session: FakeSession | undefined, name: string, args: unknown): Promise<Record<string, unknown>> => {
    const result = await ctx.tools.execute({
      callId: ToolCallId(`${name}-call`),
      signal: new AbortController().signal,
      name,
      arguments: args,
      ...session === undefined ? {} : { agent: session.agent as never },
    })
    const block = result.content.find(item => item.type === 'text')
    return block?.type === 'text' ? JSON.parse(block.text) as Record<string, unknown> : {}
  }
  const listed = async (session: FakeSession): Promise<Record<string, unknown>[]> =>
    (await call(session, 'monitor_list', {}))['monitors'] as Record<string, unknown>[]
  const logged = (text: string): boolean => logs.some(line => line.text.includes(text))
  return { ctx, call, listed, loaded, resolved, logs, logged }
}

const textOf = (message: UserMessage | undefined): string => {
  const block = message?.content[0]
  return block?.type === 'text' ? block.text : ''
}

describe('monitor tools', () => {
  it('wakes an idle session with lines and injects into a busy one', async () => {
    const world = newWorld()
    const owner = addSession(world, 'session-1')
    const host = await mount(world)
    host.loaded.set(owner.id, owner.agent)
    const started = await host.call(owner, 'monitor_start', { command: 'echo first; sleep 0.8; echo second; sleep 30', description: 'demo' })
    expect(started).toMatchObject({ status: 'running', description: 'demo' })
    await until(() => owner.followups.length === 1)
    expect(textOf(owner.followups[0])).toContain('printed 1 new line(s)')
    expect(textOf(owner.followups[0])).toContain('\nfirst')
    expect(owner.followups[0]?.source).toMatchObject({ kind: 'lsy-tool-monitor', form: 'notice' })
    owner.agent.status = 'running'
    await until(() => owner.injected.length === 1)
    expect(textOf(owner.injected[0])).toContain('\nsecond')
    expect(await host.listed(owner)).toEqual([expect.objectContaining({ id: started['id'], status: 'running', lines: 2 })])
    expect(await host.call(owner, 'monitor_stop', { id: started['id'] })).toEqual({ stopped: started['id'] })
    expect(await host.call(owner, 'monitor_stop', { id: started['id'] })).toMatchObject({ error: expect.stringContaining('no running monitor') as string })
    // A loaded agent never needs the Session controller.
    expect(host.resolved).toEqual([])
  })

  it('runs the command without credential-shaped variables', async () => {
    process.env['LSY_MONITOR_TEST_API_KEY'] = 'leak-me'
    try {
      const world = newWorld()
      const owner = addSession(world, 'session-1')
      const host = await mount(world)
      await host.call(owner, 'monitor_start', { command: 'echo "key=${LSY_MONITOR_TEST_API_KEY:-unset} home=${HOME:+set}"', description: 'env' })
      // The command exits at once, so the lines notice and the ended notice may arrive together.
      await until(() => owner.followups.length >= 1)
      expect(textOf(owner.followups[0])).toContain('key=unset home=set')
      expect(textOf(owner.followups[0])).not.toContain('leak-me')
    } finally {
      delete process.env['LSY_MONITOR_TEST_API_KEY']
    }
  })

  it('validates input and needs a session', async () => {
    const world = newWorld()
    const owner = addSession(world, 'session-1')
    const { call } = await mount(world)
    expect(await call(owner, 'monitor_start', { command: ' ', description: 'x' })).toMatchObject({ error: expect.stringContaining('command') as string })
    expect(await call(owner, 'monitor_start', { command: 'true', description: ' ' })).toMatchObject({ error: expect.stringContaining('description') as string })
    expect(await call(owner, 'monitor_start', { command: 'true', description: 'x', timeout_minutes: 0 })).toMatchObject({ error: expect.stringContaining('timeout_minutes') as string })
    expect(await call(undefined, 'monitor_start', { command: 'true', description: 'x' })).toEqual({ error: 'monitors need an agent session to report to' })
  })
})

describe('monitors across host restarts', () => {
  it('runs stored monitors again under the same ids, and their lines load the Session that owns them', async () => {
    const world = newWorld()
    const owner = addSession(world, 'session-1')
    const first = await mount(world)
    first.loaded.set(owner.id, owner.agent)
    const ticks = await first.call(owner, 'monitor_start', { command: 'sleep 0.2; echo tick; sleep 30', description: 'ticks', persistent: true })
    const timed = await first.call(owner, 'monitor_start', { command: 'sleep 30', description: 'timed', timeout_minutes: 10 })
    expect(timed['deadline']).toBe(Number(timed['startedAt']) + 600_000)
    await until(() => owner.followups.length === 1)
    await first.ctx.fiber.dispose()

    // While the host is down: one stored monitor passes its deadline, another one's Session is deleted.
    await withRecords(world, (records) => {
      records.set('mon-expired', { owner: owner.id, command: 'sleep 30', description: 'expired', cwd: tmpdir(), startedAt: Date.now() - 120_000, deadline: Date.now() - 60_000 })
      records.set('mon-orphan', { owner: 'session-deleted', command: 'sleep 30', description: 'orphan', cwd: tmpdir(), startedAt: Date.now() - 120_000 })
    })

    const second = await mount(world)
    await until(() => second.logs.filter(line => / (restored|dropped)/u.test(line.text)).length === 4)
    expect(second.logged(`monitor ${String(ticks['id'])} restored for session session-1: ticks (persistent)`)).toBe(true)
    expect(second.logged(`monitor ${String(timed['id'])} restored for session session-1: timed (10 minutes left)`)).toBe(true)
    expect(second.logged('monitor mon-expired of session session-1 dropped: its deadline passed')).toBe(true)
    expect(second.logged('monitor mon-orphan of session session-deleted dropped: its session is gone')).toBe(true)
    const running = await second.listed(owner)
    expect(running).toHaveLength(2)
    expect(running).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ticks['id'], status: 'running', startedAt: ticks['startedAt'] }),
      expect.objectContaining({ id: timed['id'], status: 'running', startedAt: timed['startedAt'], deadline: timed['deadline'] }),
    ]))
    expect(running.find(view => view['id'] === ticks['id'])).not.toHaveProperty('deadline')

    // The restarted command prints again; delivery loads the Session first, and says nothing about the restart.
    expect(second.loaded.has(owner.id)).toBe(false)
    await until(() => owner.followups.length === 2)
    expect(second.resolved).toEqual([owner.id])
    expect(owner.followups.map(textOf)).toEqual([
      expect.stringContaining(`Monitor ${String(ticks['id'])} (ticks) printed 1 new line(s).`) as string,
      expect.stringContaining(`Monitor ${String(ticks['id'])} (ticks) printed 1 new line(s).`) as string,
    ])
    expect(textOf(owner.followups[1])).toContain('\ntick')

    // The restored ids stay valid for monitor_stop.
    expect(await second.call(owner, 'monitor_stop', { id: ticks['id'] })).toEqual({ stopped: ticks['id'] })
    await until(() => second.logged(`monitor ${String(ticks['id'])} ended: stopped by monitor_stop`))
    await second.ctx.fiber.dispose()
    expect(await storedIds(world)).toEqual([timed['id']])
  })

  it('forgets a monitor that is stopped or exits, keeps one the host shuts down, and never stores its environment', async () => {
    const world = newWorld()
    const owner = addSession(world, 'session-1')
    const host = await mount(world)
    host.loaded.set(owner.id, owner.agent)
    // Ignores SIGTERM, so it is still running when the host shuts down right after monitor_stop.
    const stopped = await host.call(owner, 'monitor_start', { command: 'trap "" TERM; sleep 30', description: 'stopped' })
    const exited = await host.call(owner, 'monitor_start', { command: 'sleep 0.1', description: 'exits' })
    const kept = await host.call(owner, 'monitor_start', { command: 'sleep 30', description: 'kept', persistent: true })
    await until(() => owner.followups.some(message => textOf(message).includes('ended: exited with code 0')))
    await host.call(owner, 'monitor_stop', { id: stopped['id'] })
    await host.ctx.fiber.dispose()
    const records = await withRecords(world, stored => [...stored.entries()])
    expect(records).toEqual([[kept['id'], { owner: 'session-1', command: 'sleep 30', description: 'kept', cwd: tmpdir(), startedAt: kept['startedAt'] }]])
    expect(exited['id']).not.toBe(kept['id'])
  })

  it('keeps notices of one Session in order while its agent loads', async () => {
    const world = newWorld()
    const owner = addSession(world, 'session-1')
    const host = await mount(world, { resolveDelayMs: 800 })
    await host.call(owner, 'monitor_start', { command: 'echo a; sleep 0.7; echo b; sleep 30', description: 'order' })
    await until(() => owner.followups.length === 2)
    expect(owner.followups.map(message => textOf(message).split('\n').at(-1))).toEqual(['a', 'b'])
    expect(host.resolved).toEqual([owner.id])
  })

  it('stops a monitor at its next notice when its Session is gone', async () => {
    const world = newWorld()
    const deleted = addSession(world, 'session-deleted')
    world.sessions.delete(deleted.id)
    const child = addSession(world, 'session-child', 'subagent')
    const host = await mount(world)
    const gone = await host.call(deleted, 'monitor_start', { command: 'echo hi; sleep 30', description: 'deleted' })
    const orphan = await host.call(child, 'monitor_start', { command: 'echo hi; sleep 30', description: 'released' })
    await until(() => host.logged(`monitor ${String(gone['id'])} ended: its session is gone`) && host.logged(`monitor ${String(orphan['id'])} ended: its session is gone`))
    // A deleted Session is never resolved; a released subagent's Session has nobody to resume it.
    expect(host.resolved).toEqual([])
    expect(deleted.followups).toEqual([])
    expect(child.followups).toEqual([])
    await host.ctx.fiber.dispose()
    expect(await storedIds(world)).toEqual([])
  })

  it('sweeps monitors of gone Sessions but not of Sessions that are only unloaded', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const world = newWorld()
    const unloaded = addSession(world, 'session-unloaded')
    const deleted = addSession(world, 'session-deleted')
    const child = addSession(world, 'session-child', 'subagent')
    const host = await mount(world)
    const started: Record<string, unknown>[] = []
    for (const session of [unloaded, deleted, child]) {
      host.loaded.set(session.id, session.agent)
      started.push(await host.call(session, 'monitor_start', { command: 'sleep 30', description: session.id, persistent: true }))
    }
    // Every agent unloads, and one Session is deleted.
    host.loaded.clear()
    world.sessions.delete(deleted.id)
    await vi.advanceTimersByTimeAsync(60_000)
    await until(() => host.logged(`monitor ${String(started[1]?.['id'])} ended: its session is gone`) && host.logged(`monitor ${String(started[2]?.['id'])} ended: its session is gone`))
    await until(async () => (await host.listed(deleted))[0]?.['status'] === 'ended')
    expect(await host.listed(unloaded)).toEqual([expect.objectContaining({ id: started[0]?.['id'], status: 'running' })])
    expect(await host.listed(deleted)).toEqual([expect.objectContaining({ status: 'ended', ended: 'its session is gone' })])
    // The sweep reads Session persistence; it never loads an agent.
    expect(host.resolved).toEqual([])
    expect(host.loaded.size).toBe(0)
    await host.ctx.fiber.dispose()
    expect(await storedIds(world)).toEqual([started[0]?.['id']])
  })

  it('runs monitors without storage when another instance holds the store', async () => {
    const world = newWorld()
    const owner = addSession(world, 'session-1')
    const held = Object.assign(new Error('domain \'lsy_tool_monitor\' is already open'), { code: 'already-open' })
    const host = await mount(world, { storageDomain: { open: () => Promise.reject(held) } })
    host.loaded.set(owner.id, owner.agent)
    await until(() => host.logs.some(line => line.type === 'warn'))
    expect(host.logs.filter(line => line.type === 'warn').map(line => line.text)).toEqual([
      'monitor store is held by another lsy-tool-monitor instance; monitors started through this preset are not restored after a host restart',
    ])
    await host.call(owner, 'monitor_start', { command: 'echo hi; sleep 30', description: 'plain' })
    await until(() => owner.followups.length === 1)
    expect(textOf(owner.followups[0])).toContain('\nhi')
  })
})
