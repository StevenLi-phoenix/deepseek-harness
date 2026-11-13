/**
 * Claude Code of the service account as one root-level service, `ctx.claudeCodeSessions`: the live sessions from Claude Code's own
 * session registry, the sessions started in the bridge's tmux server, the login state from file existence alone (no credential
 * is opened), and start and stop. `cc-bridge`'s tools live in a preset mount that nothing else can reach, so the Settings
 * page reaches Claude Code through this service instead. It reuses the bridge's `Registry` and `Spawner`, so the name rules,
 * the session limit, and the cleaned environment are those of `cc_start` and `cc_stop`, and its defaults come from the bridge's
 * own configuration schema. It never opens the bridge's inbox, so a first task is Claude Code's prompt argument, not a peer message.
 */

import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { Config as BridgeConfig, Registry, Spawner, type Run } from '@deepseek-ai/dsh-cc-bridge'
import z from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Claude Code sessions of the service account: list, start, and stop. */
    claudeCodeSessions: ClaudeCodeAdmin
  }
}

/** Longest first task, as `cc_start` allows. */
export const MAX_TASK_CHARS = 8000

/** Settings; every default is the bridge's. */
export interface Config {
  /** Turn the service off: the Settings page then shows the bridge as off. */
  enabled: boolean
  /** Claude Code's session registry for this account; empty means `~/.claude/sessions`. */
  sessionsDir: string
  /** The tmux binary that hosts started sessions. */
  tmux: string
  /** The launcher that sets HOME and the token file, then execs Claude Code. */
  command: string
  /** Where started sessions work. */
  workDir: string
  /** The model a started session uses. */
  model: string
  /** Most started sessions running at once. */
  maxSessions: number
}

const BRIDGE = BridgeConfig({} as never)

/** Configuration schema. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  sessionsDir: z.string().default(BRIDGE.sessionsDir),
  tmux: z.string().default(BRIDGE.tmux),
  command: z.string().default(BRIDGE.command),
  workDir: z.string().default(BRIDGE.workDir),
  model: z.string().default(BRIDGE.model),
  maxSessions: z.natural().min(1).max(10).default(BRIDGE.maxSessions),
})

/** A Claude Code session of the service account. */
export interface CcSession {
  readonly name: string
  readonly pid: number
  readonly status: string | null
  readonly cwd: string | null
  readonly updatedAt: number | null
  /** The bridge started it in tmux, so it can be stopped from here. */
  readonly managed: boolean
}

/** How the account is signed in to Claude Code: `full` (a claude.ai login, which Remote Control needs), `token`, or `none`. */
export type CcLogin = 'full' | 'token' | 'none'

/** Sessions and limits as the Settings page shows them. */
export interface CcView {
  readonly enabled: boolean
  readonly login: CcLogin
  readonly sessions: readonly CcSession[]
  readonly maxSessions: number
  /** Names of tmux sessions the bridge started, including ones not yet registered. */
  readonly started: readonly string[]
}

/** Outcome of a start or stop. */
export type CcOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: 'invalid_request' | 'limit_reached' | 'not_found' | 'start_failed' | 'stop_failed'; readonly detail?: string }

/** True for a regular file with content. */
function filled(path: string): boolean {
  try {
    const info = statSync(path)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

/** Service behind `ctx.claudeCodeSessions`. */
export class ClaudeCodeAdmin extends Service {
  static Config = Config

  private readonly registry: Registry
  private readonly spawner: Spawner

  /**
   * @param ctx - Host context.
   * @param config - settings.
   * @param home - the service account's home directory; replaced in tests.
   * @param run - replaces the tmux runner in tests.
   */
  constructor(ctx: Context, private readonly config: Config, private readonly home: string = homedir(), run?: Run) {
    super(ctx, 'claudeCodeSessions')
    const sessionsDir = config.sessionsDir === '' ? join(home, '.claude', 'sessions') : config.sessionsDir
    this.registry = new Registry(sessionsDir, process.pid)
    this.spawner = new Spawner({
      tmux: config.tmux, command: config.command, workDir: config.workDir, model: config.model, maxSessions: config.maxSessions, home,
      ...run === undefined ? {} : { run },
    })
    ctx.logger.info(`cc-admin: Claude Code of ${home} ${config.enabled ? `listed from ${sessionsDir}, at most ${config.maxSessions} started here` : 'is turned off'}`)
  }

  /** Whether the service is switched on. */
  get enabled(): boolean {
    return this.config.enabled
  }

  /**
   * How the service account is signed in, from file existence only.
   * @returns the login state.
   */
  login(): CcLogin {
    if (filled(join(this.home, '.claude', '.credentials.json'))) return 'full'
    return filled(join(this.home, '.config', 'claude-code', 'oauth_token')) ? 'token' : 'none'
  }

  /**
   * Live sessions and the tmux sessions the bridge started.
   * @returns the view.
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
   * @returns the outcome; the limit is a code of its own so a page can word it.
   */
  async start(name: string, task: string | undefined): Promise<CcOutcome> {
    if (task !== undefined && task.length > MAX_TASK_CHARS) return { ok: false, error: 'invalid_request', detail: 'task too long' }
    const running = await this.spawner.running()
    if (running.length >= this.config.maxSessions && !running.includes(name)) return { ok: false, error: 'limit_reached' }
    const result = await this.spawner.start(name, task)
    if (result.ok) {
      this.ctx.logger.info(`cc-admin: started ${name}${task === undefined || task.trim() === '' ? '' : ' with a first task'}`)
      return { ok: true }
    }
    this.ctx.logger.warn(`cc-admin: starting ${name} failed: ${result.error}`)
    return { ok: false, error: /name must be|already running/u.test(result.error) ? 'invalid_request' : 'start_failed', detail: result.error }
  }

  /**
   * Stop a session the bridge started.
   * @param name - the name it was started with.
   * @returns the outcome.
   */
  async stop(name: string): Promise<CcOutcome> {
    const result = await this.spawner.stop(name)
    if (result.ok) {
      this.ctx.logger.info(`cc-admin: stopped ${name}`)
      return { ok: true }
    }
    this.ctx.logger.warn(`cc-admin: stopping ${name} failed: ${result.error}`)
    return { ok: false, error: result.error.startsWith('no session named') ? 'not_found' : 'stop_failed', detail: result.error }
  }
}

export default ClaudeCodeAdmin
