/** A channel's Sessions: reuse, creation, forgetting, and the relay claim. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { forgetOldest, joinRelay, openPresetSession, unavailableReason } from '../src/index.ts'

/** A context with scripted Session services and a recording logger. */
function services(resolve: (id: string) => object) {
  const calls: string[] = []
  const logs: string[] = []
  const ctx = {
    sessionController: {
      create: vi.fn(async (request: { cwd: string; agentPreset: string }) => { calls.push(`create ${request.cwd} ${request.agentPreset}`); return { sessionId: 'new-1' } }),
      resolveAgent: vi.fn(async (id: string) => resolve(id)),
    },
    permissionPresets: {
      resolve: vi.fn((name: string) => { calls.push(`resolve ${name}`); if (name === 'unknown') throw new Error('unknown preset') }),
      set: vi.fn((_session: unknown, name: string) => { calls.push(`set ${name}`) }),
    },
    sessionTitle: { rename: vi.fn((_session: unknown, title: string) => { calls.push(`title ${title}`) }) },
    logger: { info: (text: string) => { logs.push(`info ${text}`) }, warn: (text: string) => { logs.push(`warn ${text}`) } },
  } as never as Context
  return { ctx, calls, logs }
}

const preset = { workspacePath: '/w', agentPreset: 'bot', permissionPreset: 'unattended' }

describe('unavailableReason', () => {
  it('keeps a Session that resolves, names why one does not, and throws a transient failure', async () => {
    const errors: Record<string, { code: string }> = { gone: { code: 'session/not-found' }, busy: { code: 'session/agent-busy' }, held: { code: 'session/writer-held' } }
    const { ctx } = services(id => (id in errors ? { error: errors[id] } : { agent: {} }))
    await expect(unavailableReason(ctx, 'ok' as SessionId)).resolves.toBeUndefined()
    await expect(unavailableReason(ctx, 'gone' as SessionId)).resolves.toBe('session/not-found')
    await expect(unavailableReason(ctx, 'busy' as SessionId)).rejects.toBe(errors['busy'])
    await expect(unavailableReason(ctx, 'held' as SessionId)).rejects.toBe(errors['held'])
  })
})

describe('openPresetSession', () => {
  it('checks the permission preset first, then creates, configures, and titles the Session', async () => {
    const { ctx, calls } = services(() => ({ agent: { session: {} } }))
    await expect(openPresetSession(ctx, preset, 'Chat')).resolves.toBe('new-1')
    expect(calls).toEqual(['resolve unattended', 'create /w bot', 'set unattended', 'title Chat'])
  })

  it('creates nothing for an unknown preset and throws the new Session\'s resolve error', async () => {
    const unknown = services(() => ({ agent: { session: {} } }))
    await expect(openPresetSession(unknown.ctx, { ...preset, permissionPreset: 'unknown' }, 'Chat')).rejects.toThrow('unknown preset')
    expect(unknown.calls).toEqual(['resolve unknown'])
    const failure = { code: 'session/not-found' }
    const broken = services(() => ({ error: failure }))
    await expect(openPresetSession(broken.ctx, preset, 'Chat')).rejects.toBe(failure)
    expect(broken.calls).toEqual(['resolve unattended', 'create /w bot'])
  })
})

describe('forgetOldest', () => {
  it('deletes the oldest Sessions beyond the limit and reports each', async () => {
    const rows = new Map([['c', { createdAt: 3 }], ['a', { createdAt: 1 }], ['b', { createdAt: 2 }]])
    const forgotten: string[] = []
    const sessions = { entries: () => rows.entries(), get size() { return rows.size }, delete: async (id: string) => rows.delete(id) }
    await forgetOldest(sessions, 1, (id) => { forgotten.push(id) })
    expect(forgotten).toEqual(['a', 'b'])
    expect([...rows.keys()]).toEqual(['c'])
    await forgetOldest(sessions, 5, (id) => { forgotten.push(id) })
    expect(forgotten).toEqual(['a', 'b'])
  })
})

describe('joinRelay', () => {
  it('claims the stored Sessions once they are known, and nothing after the channel left', async () => {
    const { ctx, logs } = services(() => ({}))
    const claimed: string[] = []
    const unregister = vi.fn()
    const relay = { registerChannel: vi.fn(() => unregister), claim: (id: string, name: string) => { claimed.push(`${id}@${name}`) } }
    const channel = { name: 'chat' }
    const leave = joinRelay(ctx, relay, channel, Promise.resolve(['s1', 's2']), 'svc')
    expect(relay.registerChannel).toHaveBeenCalledWith(channel)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(claimed).toEqual(['s1@chat', 's2@chat'])
    expect(logs).toEqual(['info svc: the relay carries 2 chat Session(s) through channel chat'])
    leave()
    expect(unregister).toHaveBeenCalledTimes(1)

    let open!: (ids: readonly string[]) => void
    const late = joinRelay(ctx, relay, channel, new Promise((resolve) => { open = resolve }), 'svc')
    late()
    open(['s3'])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(claimed).toEqual(['s1@chat', 's2@chat'])
  })

  it('logs a storage failure and claims nothing', async () => {
    const { ctx, logs } = services(() => ({}))
    const relay = { registerChannel: () => () => {}, claim: vi.fn() }
    joinRelay(ctx, relay, { name: 'chat' }, Promise.reject(new Error('storage closed')), 'svc')
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a non-Error rejection is the case under test.
    joinRelay(ctx, relay, { name: 'chat' }, Promise.reject('plain'), 'svc')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(relay.claim).not.toHaveBeenCalled()
    expect(logs).toEqual(['warn svc: chat Sessions not claimed with the relay: storage closed', 'warn svc: chat Sessions not claimed with the relay: plain'])
  })
})
