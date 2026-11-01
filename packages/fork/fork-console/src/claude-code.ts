/**
 * The service account's Claude Code sessions as this page sees them: the live ones from Claude Code's own session registry,
 * the ones the bridge started from its tmux server, and the login state from file existence alone (no credential is opened).
 * Starting and stopping use the bridge's `Spawner`, so the name rules, the session limit, and the cleaned environment are
 * the ones `cc_start` and `cc_stop` use.
 */

import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Registry, Spawner, type Run } from '@deepseek-ai/dsh-fork-cc-bridge'
import { MAX_TASK_CHARS, type CcLogin, type CcSession, type CcView } from './views.ts'
import type { Config } from './config.ts'

/** Outcome of a start or stop. */
export type CcOutcome = { ok: true } | { ok: false; error: 'invalid_request' | 'limit_reached' | 'not_found' | 'start_failed' | 'stop_failed'; detail?: string }

/** True for a regular file with content. */
function filled(path: string): boolean {
  try {
    const info = statSync(path)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

/** Claude Code of the service account. */
export class ClaudeCode {
  private readonly registry: Registry
  private readonly spawner: Spawner

  /**
   * @param config - the `claudeCode` settings.
   * @param home - the service account's home directory.
   * @param run - replaces the tmux runner in tests.
   */
  constructor(private readonly config: Config['claudeCode'], private readonly home: string = homedir(), run?: Run) {
    const sessionsDir = config.sessionsDir === '' ? join(home, '.claude', 'sessions') : config.sessionsDir
    this.registry = new Registry(sessionsDir, process.pid)
    this.spawner = new Spawner({
      tmux: config.tmux, command: config.command, workDir: config.workDir, model: config.model, maxSessions: config.maxSessions, home,
      ...run === undefined ? {} : { run },
    })
  }

  /** Whether the bridge's tools are switched on, which is also when this card is shown. */
  get enabled(): boolean {
    return this.config.enabled
  }

  /**
   * How the service account is signed in to Claude Code, from file existence only: `full` (a claude.ai login, which Remote Control
   * needs), `token` (the inference-only token the launcher exports), or `none`.
   * @returns the login state.
   */
  login(): CcLogin {
    if (filled(join(this.home, '.claude', '.credentials.json'))) return 'full'
    return filled(join(this.home, '.config', 'claude-code', 'oauth_token')) ? 'token' : 'none'
  }

  /**
   * Live sessions and the tmux sessions the bridge started.
   * @returns the card's view.
   */
  async view(): Promise<CcView> {
    const [live, started] = await Promise.all([this.registry.sessions(true), this.spawner.running()])
    const sessions: CcSession[] = live.map(session => ({
      name: session.name,
      pid: session.pid,
      status: session.status ?? null,
      cwd: session.cwd ?? null,
      updatedAt: session.updatedAt ?? null,
      managed: started.includes(session.name),
    }))
    return { enabled: this.config.enabled, login: this.login(), sessions, maxSessions: this.config.maxSessions, started }
  }

  /**
   * Start a session, optionally with a first task.
   * @param name - lower-case letters, digits, and hyphens, at most 31 characters.
   * @param task - the first prompt, at most {@link MAX_TASK_CHARS} characters.
   * @returns the outcome; the limit is checked here so the refusal is a code, not the tool's wording.
   */
  async start(name: string, task: string | undefined): Promise<CcOutcome> {
    if (task !== undefined && task.length > MAX_TASK_CHARS) return { ok: false, error: 'invalid_request', detail: 'task too long' }
    const running = await this.spawner.running()
    if (running.length >= this.config.maxSessions && !running.includes(name)) return { ok: false, error: 'limit_reached' }
    const result = await this.spawner.start(name, task)
    return result.ok ? { ok: true } : { ok: false, error: /name must be|already running/u.test(result.error) ? 'invalid_request' : 'start_failed', detail: result.error }
  }

  /**
   * Stop a session the bridge started.
   * @param name - the name it was started with.
   * @returns the outcome.
   */
  async stop(name: string): Promise<CcOutcome> {
    const result = await this.spawner.stop(name)
    if (result.ok) return { ok: true }
    return { ok: false, error: result.error.startsWith('no session named') ? 'not_found' : 'stop_failed', detail: result.error }
  }
}
