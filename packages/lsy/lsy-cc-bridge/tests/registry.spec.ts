import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Registry, processStart, publicView, type StartOf } from '../src/registry.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'ccb-registry-'))
  roots.push(root)
  return root
}

const OWN_PID = 1
const ALIVE: StartOf = pid => Promise.resolve(pid === 666 ? undefined : pid === 667 ? 'other start' : 'S')

/** Write a record that counts as live, with `extra` laid over it. */
function record(dir: string, pid: number, extra: Record<string, unknown> = {}): void {
  writeFileSync(join(dir, `${String(pid)}.json`), JSON.stringify({
    pid, kind: 'interactive', procStart: 'S', messagingSocketPath: `/socks/${String(pid)}.sock`, ...extra,
  }))
}

describe('Registry.sessions', () => {
  it('finds nothing when the directory cannot be read', async () => {
    expect(await new Registry(join(tempDir(), 'missing'), OWN_PID, ALIVE).sessions()).toEqual([])
  })

  it('counts only live, addressable sessions of a listable kind', async () => {
    const dir = tempDir()
    record(dir, 100, { name: 'live' })
    writeFileSync(join(dir, 'notes.txt'), 'not a record')
    writeFileSync(join(dir, '101.json'), '{ not json')
    record(dir, OWN_PID, { name: 'itself' })
    record(dir, 102, { name: 'renamed-file', pid: 999 })
    record(dir, 103, { name: 'no-socket', messagingSocketPath: 42 })
    record(dir, 104, { name: 'spare', spare: true })
    record(dir, 105, { name: 'bridge', dshBridge: true })
    record(dir, 106, { name: 'daemon', kind: 'daemon' })
    record(dir, 107, { name: 'kindless', kind: 7 })
    record(dir, 666, { name: 'dead' })
    record(dir, 667, { name: 'pid-reused' })
    const sessions = await new Registry(dir, OWN_PID, ALIVE).sessions()
    expect(sessions.map(session => session.name)).toEqual(['live'])
  })

  it('names a session after its working directory, then its pid, when it has no name', async () => {
    const dir = tempDir()
    record(dir, 100, { name: 'given', cwd: '/work/ignored', updatedAt: 3 })
    record(dir, 101, { cwd: '/work/app', updatedAt: 2 })
    record(dir, 102, { updatedAt: 1 })
    const sessions = await new Registry(dir, OWN_PID, ALIVE).sessions()
    expect(sessions.map(session => session.name)).toEqual(['given', 'app', 'pid-102'])
  })

  it('names a session after the last part of a working directory with a trailing slash, and after its pid at the root', async () => {
    const dir = tempDir()
    record(dir, 100, { cwd: '/work/app/', updatedAt: 2 })
    record(dir, 101, { cwd: '/', updatedAt: 1 })
    const sessions = await new Registry(dir, OWN_PID, ALIVE).sessions()
    expect(sessions.map(session => session.name)).toEqual(['app', 'pid-101'])
  })

  it('keeps optional fields of the right type and omits the rest', async () => {
    const dir = tempDir()
    record(dir, 100, {
      name: 'full', kind: 'bg', sessionId: 'abc', cwd: '/w', status: 'busy', version: '2.1', tmux: 'pane', startedAt: 1, updatedAt: 2,
    })
    record(dir, 101, { name: 'wrong-types', sessionId: 1, cwd: 2, status: 3, version: 4, tmux: 5, startedAt: 'a', updatedAt: 'b' })
    const sessions = await new Registry(dir, OWN_PID, ALIVE).sessions()
    expect(sessions).toEqual([
      {
        name: 'full', pid: 100, socketPath: '/socks/100.sock', kind: 'bg',
        sessionId: 'abc', cwd: '/w', status: 'busy', version: '2.1', tmux: 'pane', startedAt: 1, updatedAt: 2,
      },
      { name: 'wrong-types', pid: 101, socketPath: '/socks/101.sock', kind: 'interactive' },
    ])
  })

  it('orders by newest activity, a session without activity last', async () => {
    const dir = tempDir()
    record(dir, 100, { name: 'unknown' })
    record(dir, 101, { name: 'older', updatedAt: 10 })
    record(dir, 102, { name: 'newer', updatedAt: 20 })
    record(dir, 103, { name: 'also-unknown' })
    const names = (await new Registry(dir, OWN_PID, ALIVE).sessions()).map(session => session.name)
    expect(names.slice(0, 2)).toEqual(['newer', 'older'])
    expect(names.slice(2).sort()).toEqual(['also-unknown', 'unknown'])
  })

  it('serves the cached list until the TTL passes or a refresh is asked for', async () => {
    const dir = tempDir()
    let now = 1000
    const registry = new Registry(dir, OWN_PID, ALIVE, 50, () => now)
    record(dir, 100, { name: 'first' })
    expect(await registry.sessions()).toHaveLength(1)
    record(dir, 101, { name: 'second' })
    now += 50
    expect(await registry.sessions()).toHaveLength(1)
    expect(await registry.sessions(true)).toHaveLength(2)
    record(dir, 102, { name: 'third' })
    now += 51
    expect(await registry.sessions()).toHaveLength(3)
  })
})

describe('Registry.bySocket', () => {
  it('re-reads once for a session newer than the cache, then gives up', async () => {
    const dir = tempDir()
    const registry = new Registry(dir, OWN_PID, ALIVE, 60_000, () => 0)
    expect(await registry.sessions()).toEqual([])
    record(dir, 100, { name: 'late' })
    expect(await registry.bySocket('/socks/100.sock')).toMatchObject({ name: 'late' })
    expect(await registry.bySocket('/socks/none.sock')).toBeUndefined()
  })
})

describe('Registry.resolve', () => {
  function registryWithSessions(): Registry {
    const dir = tempDir()
    record(dir, 100, { name: 'Alpha', sessionId: 'ABCDEF-0001' })
    record(dir, 101, { name: 'twin', sessionId: 'ffffff-0002' })
    record(dir, 102, { name: 'twin' })
    return new Registry(dir, OWN_PID, ALIVE)
  }

  it('asks for a name when the selector is blank', async () => {
    expect(await registryWithSessions().resolve('   ')).toEqual({ error: 'name the session to send to (see cc_list_sessions)' })
  })

  it.each([
    ['a name, ignoring case', ' ALPHA '],
    ['a bare pid', '100'],
    ['a pid: selector', 'PID:100'],
    ['a session id prefix of six characters', 'abcdef'],
  ])('finds one session by %s', async (_label, selector) => {
    expect(await registryWithSessions().resolve(selector)).toMatchObject({ session: { name: 'Alpha', pid: 100 } })
  })

  it('reports no match, including a session id prefix under six characters', async () => {
    const registry = registryWithSessions()
    expect(await registry.resolve('abcde')).toEqual({ error: 'no live Claude Code session matches "abcde"' })
    expect(await registry.resolve('999')).toEqual({ error: 'no live Claude Code session matches "999"' })
  })

  it('lists the candidates when a name is ambiguous', async () => {
    const result = await registryWithSessions().resolve('twin')
    expect(result).toHaveProperty('error', expect.stringContaining('"twin" matches 2 sessions'))
    expect(result).toHaveProperty('error', expect.stringContaining('twin pid 101'))
    expect(result).toHaveProperty('error', expect.stringContaining('twin pid 102'))
    expect(result).toHaveProperty('error', expect.stringContaining('use the pid'))
  })
})

describe('processStart', () => {
  it('reads the start time of a running process', async () => {
    expect(await processStart(process.pid)).toMatch(/\d{4}$/u)
  })

  it('resolves undefined for a pid that does not exist', async () => {
    expect(await processStart(2 ** 31 - 2)).toBeUndefined()
  })
})

describe('publicView', () => {
  it('drops the socket path and session id', () => {
    expect(publicView({ name: 'n', pid: 1, socketPath: '/s', sessionId: 'id', cwd: '/w' })).toEqual({ name: 'n', pid: 1, cwd: '/w' })
  })
})
