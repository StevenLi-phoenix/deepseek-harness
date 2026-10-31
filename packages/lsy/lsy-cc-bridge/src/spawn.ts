/**
 * Claude Code sessions the agent starts for itself: detached tmux sessions (their own tmux server, `-L dsh-cc`)
 * running the owner-provisioned launcher, which holds the OAuth token file and the conservative settings of
 * this account. tmux gives the interactive session the terminal Claude Code needs and outlives a restart of
 * the DSH service. The sessions start from a cleaned environment, so none of the service's secrets reach them.
 */

import { execFile } from 'node:child_process'

export interface RunResult {
  code: number
  stdout: string
}

/** Run a program with exactly this environment. */
export type Run = (file: string, args: string[]) => Promise<RunResult>

export const runProgram: Run = (file, args) => new Promise((resolve) => {
  execFile(file, args, { timeout: 15_000, env: { PATH: '/usr/bin:/bin' } }, (error, stdout) => {
    resolve({ code: error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1, stdout })
  })
})

export interface SpawnOptions {
  tmux: string
  /** The launcher that sets HOME and the token, then execs Claude Code. */
  command: string
  workDir: string
  model: string
  maxSessions: number
  home: string
  run?: Run
}

const SOCKET = 'dsh-cc'
const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/u
const MODEL = /^[a-z0-9][a-z0-9.-]{0,40}$/u

export class Spawner {
  private readonly run: Run

  constructor(private readonly o: SpawnOptions) {
    this.run = o.run ?? runProgram
  }

  private tmux(...args: string[]): Promise<RunResult> {
    return this.run('/usr/bin/env', ['-i', `HOME=${this.o.home}`, 'PATH=/opt/homebrew/bin:/usr/bin:/bin', 'LANG=en_US.UTF-8', 'TERM=xterm-256color', this.o.tmux, '-L', SOCKET, ...args])
  }

  /** Names of the tmux sessions this plugin started and that are still there. */
  async running(): Promise<string[]> {
    const result = await this.tmux('list-sessions', '-F', '#{session_name}')
    return result.code === 0 ? result.stdout.split('\n').map(s => s.trim()).filter(Boolean) : []
  }

  /** Start a session named `name`; the caller waits for it to show up in the registry. */
  async start(name: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!NAME.test(name)) return { ok: false, error: 'name must be 1-31 characters: lower-case letters, digits, hyphens' }
    if (!MODEL.test(this.o.model)) return { ok: false, error: 'the configured model name is not valid' }
    const running = await this.running()
    if (running.includes(name)) return { ok: false, error: `a session named ${name} is already running` }
    if (running.length >= this.o.maxSessions) return { ok: false, error: `${String(running.length)} sessions are running; the limit is ${String(this.o.maxSessions)}. Stop one with cc_stop.` }
    const command = `${this.o.command} --model ${this.o.model} --name ${name}`
    const result = await this.tmux('new-session', '-d', '-s', name, '-x', '200', '-y', '50', '-c', this.o.workDir, command)
    return result.code === 0 ? { ok: true } : { ok: false, error: 'tmux could not start the session' }
  }

  /** Stop a session this plugin started. */
  async stop(name: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!NAME.test(name) || !(await this.running()).includes(name)) return { ok: false, error: `no session named ${name} was started by cc_start` }
    const result = await this.tmux('kill-session', '-t', name)
    return result.code === 0 ? { ok: true } : { ok: false, error: 'tmux could not stop the session' }
  }
}
