/**
 * The machine side of the stale-profile check: whether a pid runs, what `ps`
 * lists, the owner marker a launch writes, and a recovery that uses the real
 * signal, symlink, and file calls. A child Node process this suite spawns stands
 * in for the orphaned browser, so every kill reaches a process the test owns;
 * the pid that is never running sits above every platform's pid limit.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, lstatSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OWNER_FILE,
  browserProcesses,
  detectStaleProfile,
  killBrowserSync,
  listProcesses,
  lockOwnerPid,
  parseProcessList,
  processAlive,
  readBrowserOwner,
  recoverStaleProfile,
  removeBrowserOwner,
  writeBrowserOwner,
} from '../src/profile.ts'

/** A pid no process can have: Linux caps pids at 2^22 and macOS at 99999. */
const NEVER_RUNNING = 2_147_483_646

const HOST = 'test-host.local'

const temporary: string[] = []
const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A fresh directory for one test's profile. */
function profileDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-machine-'))
  temporary.push(root)
  return root
}

/** Write the three files a Chromium leaves in a profile it owns, its lock naming one host and pid. */
function writeSingletons(dir: string, host: string, pid: number): void {
  symlinkSync(`${host}-${String(pid)}`, join(dir, 'SingletonLock'))
  symlinkSync('1234567890123456789', join(dir, 'SingletonCookie'))
  symlinkSync('/tmp/dsh-test/SingletonSocket', join(dir, 'SingletonSocket'))
}

/** Whether a path exists as itself, a dangling symlink included. */
function present(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error: unknown) {
    void error
    return false
  }
}

/** A child process that idles until it is killed, and the signal that ended it. */
async function idleChild(): Promise<{ child: ChildProcess; pid: number; exited: Promise<NodeJS.Signals | null> }> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' })
  children.push(child)
  const exited = new Promise<NodeJS.Signals | null>((resolve) => { child.once('exit', (_code, signal) => { resolve(signal) }) })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  if (child.pid === undefined) throw new Error('the child process has no pid')
  return { child, pid: child.pid, exited }
}

describe('the machine probe', () => {
  it('reports this process as running and an unused or reserved pid as gone', () => {
    expect(processAlive(process.pid)).toBe(true)
    expect(processAlive(NEVER_RUNNING)).toBe(false)
    expect(processAlive(1)).toBe(false)
    expect(processAlive(0)).toBe(false)
    expect(processAlive(2.5)).toBe(false)
  })

  it('lists this process and its parent from ps', async () => {
    const rows = await listProcesses()
    expect(rows.find(row => row.pid === process.pid)).toMatchObject({ ppid: process.ppid })
  })

  it('skips a ps line whose command is blank', () => {
    expect(parseProcessList('  5     1    \n  6 1 /opt/chromium/chrome --headless')).toEqual([
      { pid: 6, ppid: 1, command: '/opt/chromium/chrome --headless' },
    ])
  })

  it('reads no pid from a lock target without a usable one', () => {
    expect(lockOwnerPid(`${HOST}-abc`, HOST)).toBeUndefined()
    expect(lockOwnerPid(`${HOST}-1`, HOST)).toBeUndefined()
    expect(lockOwnerPid('-4321', HOST)).toBeUndefined()
    expect(lockOwnerPid(`  ${HOST}-4321\n`, HOST)).toBe(4321)
  })
})

describe('the owner marker', () => {
  it('reads back the browser a launch recorded, and forgets it on a clean close', async () => {
    const dir = profileDir()
    const owner = { pid: 4242, ownerPid: 4241, startedAt: '2026-11-25T00:00:00.000Z' }
    await writeBrowserOwner(dir, owner)
    expect(await readBrowserOwner(dir)).toEqual(owner)
    await removeBrowserOwner(dir)
    expect(await readBrowserOwner(dir)).toBeUndefined()
  })

  it('reads no owner from a marker that is missing, not JSON, or lacks a pid', async () => {
    const dir = profileDir()
    expect(await readBrowserOwner(dir)).toBeUndefined()
    writeFileSync(join(dir, OWNER_FILE), '{')
    expect(await readBrowserOwner(dir)).toBeUndefined()
    writeFileSync(join(dir, OWNER_FILE), '{"pid":5}')
    expect(await readBrowserOwner(dir)).toBeUndefined()
    writeFileSync(join(dir, OWNER_FILE), '{"pid":5,"ownerPid":6,"startedAt":7}')
    expect(await readBrowserOwner(dir)).toEqual({ pid: 5, ownerPid: 6, startedAt: '' })
  })
})

describe('stale profile recovery', () => {
  it('kills an orphaned browser and removes the files of a dead lock with the real signal, link, and file calls', async () => {
    const dir = profileDir()
    writeSingletons(dir, hostname(), NEVER_RUNNING)
    await writeBrowserOwner(dir, { pid: 1234, ownerPid: NEVER_RUNNING, startedAt: '' })
    const orphan = await idleChild()
    const log = { warn: vi.fn() }

    const stale = await recoverStaleProfile(dir, {
      // The listing is the one fake: it names the child as a Chromium whose parent is gone.
      listProcesses: async () => [{ pid: orphan.pid, ppid: 1, command: `/opt/chromium/chrome --user-data-dir=${dir}` }],
    }, log)

    expect(stale?.deadPids).toEqual([NEVER_RUNNING])
    expect(stale?.orphanPids).toEqual([orphan.pid])
    expect(stale?.lockFiles).toHaveLength(3)
    expect(await orphan.exited).toBe('SIGKILL')
    expect(readdirSync(dir)).toEqual([])
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('reports a kill or a removal that fails and finishes the rest', async () => {
    const dir = profileDir()
    const log = { warn: vi.fn() }
    const stale = await recoverStaleProfile(dir, {
      hostname: HOST,
      alive: () => false,
      readLink: async path => path.endsWith('SingletonLock') ? `${HOST}-4321` : undefined,
      listProcesses: async () => [{ pid: 700, ppid: 1, command: `/opt/chromium/chrome --user-data-dir=${dir}` }],
      signal: () => { throw new Error('kill ESRCH') },
      remove: async () => { throw new Error('EROFS: read-only file system') },
    }, log)

    expect(stale?.lockFiles).toEqual([join(dir, 'SingletonLock')])
    // The owner marker's removal fails too, and that one is not worth a line.
    expect(log.warn.mock.calls).toEqual([
      ['headless-browser: killing the orphaned chromium %d failed: %s', 700, 'kill ESRCH'],
      ['headless-browser: removing the stale %s failed: %s', join(dir, 'SingletonLock'), 'EROFS: read-only file system'],
    ])
  })

  it('keeps the lock of a browser that came back before the files were removed', async () => {
    const dir = profileDir()
    writeSingletons(dir, HOST, 4321)
    let checks = 0
    const stale = await recoverStaleProfile(dir, {
      hostname: HOST,
      // Gone when the profile is checked, running again when its lock is about to go.
      alive: () => checks++ > 0,
      listProcesses: async () => [],
    })

    expect(stale?.deadPids).toEqual([4321])
    expect(present(join(dir, 'SingletonLock'))).toBe(true)
    expect(present(join(dir, 'SingletonCookie'))).toBe(false)
    expect(present(join(dir, 'SingletonSocket'))).toBe(false)
  })

  it('finds no browser and nothing stale for a clean profile on the real machine', async () => {
    const dir = profileDir()
    expect(await browserProcesses(dir)).toEqual([])
    expect(await detectStaleProfile(dir)).toBeUndefined()
    expect(await recoverStaleProfile(dir)).toBeUndefined()
  })

  it('leaves a browser alone while the process that launched it runs', async () => {
    const dir = profileDir()
    const rows = [{ pid: 4242, ppid: process.pid, command: `/opt/chromium/chrome --user-data-dir=${dir}` }]
    expect(await detectStaleProfile(dir, { listProcesses: async () => rows })).toBeUndefined()
  })

  it('reports a process list it cannot read without claiming any lock file', async () => {
    const dir = profileDir()
    const stale = await detectStaleProfile(dir, {
      hostname: HOST,
      alive: () => true,
      readLink: async () => `${HOST}-4321`,
      listProcesses: async () => { throw new Error('ps: command not found') },
    })
    expect(stale).toEqual({
      profileDir: dir,
      lockFiles: [],
      deadPids: [],
      orphanPids: [],
      reasons: ['the process list could not be read: ps: command not found'],
    })
  })
})

describe('the exit-time kill', () => {
  it('kills a running browser pid, and reports a gone or reserved pid as not signalled', async () => {
    const browser = await idleChild()
    expect(killBrowserSync(browser.pid)).toBe(true)
    expect(await browser.exited).toBe('SIGKILL')
    expect(killBrowserSync(NEVER_RUNNING)).toBe(false)
    expect(killBrowserSync(1)).toBe(false)
    expect(killBrowserSync(0.5)).toBe(false)
  })
})
