/**
 * The Claude Code sessions of this account, read from `~/.claude/sessions/<pid>.json`. A record counts
 * when its process is alive and its start time equals `ps -o lstart=` under `LC_ALL=C TZ=UTC`, the
 * liveness test Claude Code itself uses.
 */

import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** What the agent may know about a session: no socket path, token, or bridge id. */
export interface SessionView {
  name: string
  pid: number
  sessionId?: string
  cwd?: string
  kind?: string
  status?: string
  version?: string
  startedAt?: number
  updatedAt?: number
  tmux?: string
}

/** A session record with the fields the bridge uses. */
export interface SessionRecord extends SessionView {
  socketPath: string
}

export type StartOf = (pid: number) => Promise<string | undefined>

/** `ps -o lstart=` for one pid, or undefined when it does not exist. */
export const processStart: StartOf = pid => new Promise((resolve) => {
  execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { PATH: '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' }, timeout: 2000 }, (error, stdout) => {
    const text = stdout.trim()
    resolve(error === null && text !== '' ? text : undefined)
  })
})

/** Kinds that take messages from the agent; daemons and spares do not. */
const LISTABLE = new Set(['interactive', 'bg'])

export class Registry {
  private cache: SessionRecord[] = []
  private loadedAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly dir: string,
    private readonly ownPid: number,
    private readonly startOf: StartOf = processStart,
    private readonly ttlMs = 15_000,
    private readonly now: () => number = Date.now,
  ) {}

  private async read(): Promise<SessionRecord[]> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return []
    }
    const out: SessionRecord[] = []
    for (const file of names) {
      const m = /^(\d+)\.json$/u.exec(file)
      if (m === null) continue
      const pid = Number(m[1])
      if (pid === this.ownPid) continue
      let rec: Record<string, unknown>
      try {
        rec = JSON.parse(await readFile(join(this.dir, file), 'utf8')) as Record<string, unknown>
      } catch {
        continue
      }
      const socketPath = rec['messagingSocketPath']
      if (rec['pid'] !== pid || typeof socketPath !== 'string' || rec['spare'] === true || rec['dshBridge'] === true) continue
      if (typeof rec['kind'] !== 'string' || !LISTABLE.has(rec['kind'])) continue
      const start = await this.startOf(pid)
      if (start === undefined || rec['procStart'] !== start) continue
      const str = (key: string): string | undefined => typeof rec[key] === 'string' ? rec[key] : undefined
      const num = (key: string): number | undefined => typeof rec[key] === 'number' ? rec[key] : undefined
      const cwd = str('cwd')
      const name = str('name') ?? (cwd === undefined ? `pid-${String(pid)}` : cwd.split('/').pop() ?? `pid-${String(pid)}`)
      const sessionId = str('sessionId')
      const status = str('status')
      const version = str('version')
      const tmux = str('tmux')
      const startedAt = num('startedAt')
      const updatedAt = num('updatedAt')
      out.push({
        name, pid, socketPath, kind: rec['kind'],
        ...sessionId === undefined ? {} : { sessionId },
        ...cwd === undefined ? {} : { cwd },
        ...status === undefined ? {} : { status },
        ...version === undefined ? {} : { version },
        ...tmux === undefined ? {} : { tmux },
        ...startedAt === undefined ? {} : { startedAt },
        ...updatedAt === undefined ? {} : { updatedAt },
      })
    }
    return out
  }

  /** Live sessions, newest activity first; cached for `ttlMs` unless `refresh`. */
  async sessions(refresh = false): Promise<SessionRecord[]> {
    if (refresh || this.now() - this.loadedAt > this.ttlMs) {
      this.cache = (await this.read()).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      this.loadedAt = this.now()
    }
    return this.cache
  }

  /** The live session listening on `socketPath`, if any. */
  async bySocket(socketPath: string): Promise<SessionRecord | undefined> {
    for (const refresh of [false, true]) {
      const hit = (await this.sessions(refresh)).find(rec => rec.socketPath === socketPath)
      if (hit !== undefined) return hit
    }
    return undefined
  }

  /** One session for a name, a pid, or a session id prefix; otherwise why not. */
  async resolve(selector: string): Promise<{ session: SessionRecord } | { error: string }> {
    const sel = selector.trim().toLowerCase()
    if (sel === '') return { error: 'name the session to send to (see cc_list_sessions)' }
    const all = await this.sessions(true)
    let hits = all.filter(rec => rec.name.toLowerCase() === sel)
    if (hits.length === 0 && /^(?:pid:)?\d+$/u.test(sel)) hits = all.filter(rec => rec.pid === Number(sel.replace('pid:', '')))
    if (hits.length === 0 && sel.length >= 6) hits = all.filter(rec => rec.sessionId?.toLowerCase().startsWith(sel) === true)
    const [only] = hits
    if (hits.length === 1 && only !== undefined) return { session: only }
    if (hits.length === 0) return { error: `no live Claude Code session matches "${selector.trim()}"` }
    return { error: `"${selector.trim()}" matches ${String(hits.length)} sessions (${hits.map(h => `${h.name} pid ${String(h.pid)}`).join(', ')}); use the pid` }
  }
}

/** The view handed to the agent. */
export function publicView(rec: SessionRecord): SessionView {
  const { socketPath: _socketPath, sessionId: _sessionId, ...view } = rec
  return view
}
