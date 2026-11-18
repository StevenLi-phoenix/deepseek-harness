/**
 * The state a Chromium leaves behind in its profile when the process that
 * launched it goes away without closing it.
 *
 * A persistent profile is one directory, and Chromium guards it with three
 * files beside it — `SingletonLock` (a symlink that names the browser's host and
 * pid), `SingletonCookie`, and `SingletonSocket`. A browser that exits cleanly
 * removes them; a browser whose parent was killed mid-run leaves them behind,
 * and the next launch reads that leftover state as "someone else owns this
 * profile". That is the state a host restart hands the next process: a profile
 * that looks usable and a context that cannot open a target.
 *
 * This module reads that state and clears exactly what is stale: the three
 * files when the pid they name is gone, and a Chromium for this profile whose
 * parent is gone. A live browser with a live parent is left alone, because it
 * may be the one this process is using right now.
 *
 * @module @deepseek-ai/dsh-headless-browser/profile
 */

import { execFile } from 'node:child_process'
import { hostname as osHostname } from 'node:os'
import { join } from 'node:path'
import { readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { firstLine } from './error.ts'

/** The three files Chromium keeps beside a profile it owns. */
export const SINGLETON_FILES: readonly string[] = ['SingletonLock', 'SingletonCookie', 'SingletonSocket']

/** The owner marker this plugin writes so a later start can find its browser. */
export const OWNER_FILE = '.dsh-browser-owner.json'

/** One process line: its pid, its parent's pid, and what it runs. */
export interface ProfileProcess {
  readonly pid: number
  readonly ppid: number
  readonly command: string
}

/** What the launcher recorded about the browser it started. */
export interface BrowserOwner {
  /** Pid of the Chromium process. */
  readonly pid: number
  /** Pid of the process that launched it: the DSH process of that moment. */
  readonly ownerPid: number
  /** When it started, in ISO 8601. */
  readonly startedAt: string
}

/** How the check reaches the machine; every part is replaced in a test. */
export interface ProfileProbe {
  /** Every process on the machine. */
  readonly listProcesses?: () => Promise<readonly ProfileProcess[]>
  /** Whether a pid is running. */
  readonly alive?: (pid: number) => boolean
  /** Where a symlink points, or nothing when it does not exist. */
  readonly readLink?: (path: string) => Promise<string | undefined>
  /** Remove one file, ignoring one that is already gone. */
  readonly remove?: (path: string) => Promise<void>
  /** Kill one pid; `SIGKILL` by default. */
  readonly signal?: (pid: number, signal: NodeJS.Signals) => void
  /** The machine's own host name, which the lock file's target starts with. */
  readonly hostname?: string
}

/** What was stale, and what clearing it did. */
export interface StaleProfile {
  /** Profile directory that was checked. */
  readonly profileDir: string
  /** Singleton files that named a pid that is gone, as absolute paths. */
  readonly lockFiles: readonly string[]
  /** Pids a lock named that are no longer running. */
  readonly deadPids: readonly number[]
  /** Chromium processes for this profile whose parent is gone. */
  readonly orphanPids: readonly number[]
  /** One line per fact, for the log. */
  readonly reasons: readonly string[]
}

/** Longest a process listing may take before the check gives up on it. */
const PS_TIMEOUT_MS = 5_000

const execFileAsync = promisify(execFile)

/**
 * Whether a pid is running on this machine.
 * @param pid - pid to test.
 * @returns whether a signal could reach it.
 */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    // EPERM means the process exists and belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Every process the machine is running, read from `ps`.
 * @returns one row per process.
 */
export async function listProcesses(): Promise<readonly ProfileProcess[]> {
  const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,ppid=,command='], { timeout: PS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })
  return parseProcessList(stdout)
}

/**
 * Read `ps -Ao pid=,ppid=,command=` output.
 * @param text - the listing.
 * @returns one row per readable line.
 */
export function parseProcessList(text: string): ProfileProcess[] {
  const rows: ProfileProcess[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line)
    if (match === null) continue
    const command = match[3] ?? ''
    if (command.trim() === '') continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command })
  }
  return rows
}

/**
 * The processes launched against one profile directory.
 * @param rows - every process on the machine.
 * @param profileDir - the persistent profile.
 * @returns the rows whose command names it as their user-data directory.
 */
export function processesForProfile(rows: readonly ProfileProcess[], profileDir: string): ProfileProcess[] {
  const flag = `--user-data-dir=${profileDir}`
  return rows.filter(row => row.command.includes(flag) && /chrome|chromium/iu.test(row.command))
}

/**
 * The pid a lock file's target names, when it names one.
 * @param target - the symlink target, such as `host.local-4321`.
 * @param host - this machine's host name.
 * @returns the pid, or nothing when the target names no pid or another machine.
 */
export function lockOwnerPid(target: string | undefined, host: string): number | undefined {
  if (target === undefined) return undefined
  const text = target.trim()
  const cut = text.lastIndexOf('-')
  if (cut <= 0) return undefined
  if (text.slice(0, cut) !== host) return undefined
  const pid = Number(text.slice(cut + 1))
  return Number.isInteger(pid) && pid > 1 ? pid : undefined
}

/**
 * Read one symlink's target without throwing.
 * @param path - the symlink.
 * @returns the target, or nothing when the file does not exist or is not a link.
 */
async function readLinkQuietly(path: string): Promise<string | undefined> {
  try {
    return await readlink(path)
  } catch (error: unknown) {
    void error
    return undefined
  }
}

/**
 * Read the owner marker a previous launch wrote.
 * @param profileDir - the persistent profile.
 * @returns the recorded browser, or nothing when no marker is there.
 */
export async function readBrowserOwner(profileDir: string): Promise<BrowserOwner | undefined> {
  let text: string
  try {
    text = await readFile(join(profileDir, OWNER_FILE), 'utf8')
  } catch (error: unknown) {
    void error
    return undefined
  }
  try {
    const parsed = JSON.parse(text) as Partial<BrowserOwner>
    if (typeof parsed.pid !== 'number' || typeof parsed.ownerPid !== 'number') return undefined
    return { pid: parsed.pid, ownerPid: parsed.ownerPid, startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '' }
  } catch (error: unknown) {
    void error
    return undefined
  }
}

/**
 * The Chromium processes running against one profile directory.
 * @param profileDir - the persistent profile.
 * @param probe - how to reach the machine; the real machine by default.
 * @returns the browser processes, newest listing first as `ps` printed them.
 */
export async function browserProcesses(profileDir: string, probe: ProfileProbe = {}): Promise<readonly ProfileProcess[]> {
  const rows = await (probe.listProcesses ?? listProcesses)()
  return processesForProfile(rows, profileDir)
}

/**
 * Find what one profile's leftovers say, without changing anything.
 * @param profileDir - the persistent profile.
 * @param probe - how to reach the machine; the real machine by default.
 * @returns the stale state, or nothing when the profile is clean.
 */
export async function detectStaleProfile(profileDir: string, probe: ProfileProbe = {}): Promise<StaleProfile | undefined> {
  const alive = probe.alive ?? processAlive
  const link = probe.readLink ?? readLinkQuietly
  const host = probe.hostname ?? osHostname()
  const reasons: string[] = []
  const lockFiles: string[] = []
  const deadPids: number[] = []
  const orphanPids: number[] = []

  const lockStates = await Promise.all(SINGLETON_FILES.map(async (name) => {
    const path = join(profileDir, name)
    return { name, path, target: await link(path) }
  }))
  const present = lockStates.filter(state => state.target !== undefined)
  const lockOwner = lockOwnerPid(present.find(state => state.name === 'SingletonLock')?.target, host)
  if (lockOwner !== undefined && !alive(lockOwner)) {
    deadPids.push(lockOwner)
    reasons.push(`SingletonLock names pid ${String(lockOwner)}, which is not running`)
  }

  let rows: readonly ProfileProcess[] = []
  try {
    rows = await (probe.listProcesses ?? listProcesses)()
  } catch (error: unknown) {
    reasons.push(`the process list could not be read: ${firstLine(error)}`)
  }
  for (const row of processesForProfile(rows, profileDir)) {
    // A browser whose parent is gone cannot be closed by anyone, so it only
    // holds the profile against the next launch.
    if (row.ppid > 1 && alive(row.ppid)) continue
    orphanPids.push(row.pid)
    reasons.push(`chromium pid ${String(row.pid)} runs this profile and its parent ${String(row.ppid)} is gone`)
  }

  if (reasons.length === 0) return undefined
  // Once no browser can own the profile any more, the Singleton files are the
  // leftovers of the one that died: all three belong to one browser.
  if (deadPids.length > 0 || orphanPids.length > 0) {
    for (const state of present) lockFiles.push(state.path)
  }
  return {
    profileDir,
    lockFiles: [...new Set(lockFiles)],
    deadPids,
    orphanPids,
    reasons,
  }
}

/**
 * Clear what a previous run left behind: kill a browser whose parent is gone,
 * and remove the Singleton files once no browser is left to own them.
 * @param profileDir - the persistent profile.
 * @param probe - how to reach the machine; the real machine by default.
 * @param log - where to report what was cleared, when it was anything.
 * @returns what was stale, or nothing when the profile was clean.
 */
export async function recoverStaleProfile(
  profileDir: string,
  probe: ProfileProbe = {},
  log?: { warn(message: string, ...args: unknown[]): void },
): Promise<StaleProfile | undefined> {
  const stale = await detectStaleProfile(profileDir, probe)
  if (stale === undefined) return undefined
  const signal = probe.signal ?? ((pid: number, name: NodeJS.Signals) => { process.kill(pid, name) })
  const remove = probe.remove ?? (async (path: string) => { await rm(path, { force: true }) })
  const alive = probe.alive ?? processAlive

  for (const pid of stale.orphanPids) {
    try {
      signal(pid, 'SIGKILL')
    } catch (error: unknown) {
      log?.warn('headless-browser: killing the orphaned chromium %d failed: %s', pid, firstLine(error))
    }
  }
  if (stale.orphanPids.length > 0) {
    // The browser needs a moment to release the profile and its own child processes.
    // A plain timer: this wait is part of a launch the caller is waiting for.
    await new Promise<void>((resolve) => { setTimeout(resolve, 250) })
  }
  for (const path of stale.lockFiles) {
    const owner = lockOwnerPid(await readLinkQuietly(path), probe.hostname ?? osHostname())
    if (owner !== undefined && alive(owner)) continue
    try {
      await remove(path)
    } catch (error: unknown) {
      log?.warn('headless-browser: removing the stale %s failed: %s', path, firstLine(error))
    }
  }
  try {
    await remove(join(profileDir, OWNER_FILE))
  } catch (error: unknown) {
    void error
  }
  // The caller reports what was cleared: it knows whether this was a launch or a recovery.
  return stale
}

/**
 * Record which browser pid this process launched, so a later start can find an
 * orphan even when the lock file is already gone.
 * @param profileDir - the persistent profile.
 * @param owner - the browser, the pid that launched it, and when.
 */
export async function writeBrowserOwner(profileDir: string, owner: BrowserOwner): Promise<void> {
  await writeFile(join(profileDir, OWNER_FILE), `${JSON.stringify(owner)}\n`, 'utf8')
}

/**
 * Forget the owner marker of a browser that was closed on purpose.
 * @param profileDir - the persistent profile.
 */
export async function removeBrowserOwner(profileDir: string): Promise<void> {
  await rm(join(profileDir, OWNER_FILE), { force: true })
}

/**
 * Kill one pid from a process-scoped `exit` handler, where only synchronous work
 * is allowed.
 * @param pid - the browser to kill.
 * @returns whether the signal was sent.
 */
export function killBrowserSync(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 'SIGKILL')
    return true
  } catch (error: unknown) {
    void error
    return false
  }
}
