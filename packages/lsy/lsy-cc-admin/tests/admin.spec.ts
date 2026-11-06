import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Config as BridgeConfig } from '@deepseek-ai/dsh-lsy-cc-bridge'
import { afterEach, describe, expect, it } from 'vitest'
import type { Run } from '@deepseek-ai/dsh-lsy-cc-bridge'
import ClaudeCodeAdmin, { Config, MAX_TASK_CHARS } from '../src/index.ts'

const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A fake tmux binary: `list-sessions` prints the names in its state file, `new-session -s <name>` adds one,
 * and `kill-session -t <name>` removes it.
 */
function fakeTmux(dir: string): { tmux: string; calls: () => string[] } {
  const tmux = join(dir, 'tmux')
  const state = join(dir, 'tmux-sessions')
  const log = join(dir, 'tmux-calls')
  writeFileSync(state, '')
  writeFileSync(tmux, `#!/bin/bash
echo "$*" >> '${log}'
shift 2
case "$1" in
  list-sessions) [ -s '${state}' ] && cat '${state}' || exit 1 ;;
  new-session) while [ "$1" != "-s" ]; do shift; done; echo "$2" >> '${state}' ;;
  kill-session) grep -vx "$3" '${state}' > '${state}.tmp'; mv '${state}.tmp' '${state}' ;;
esac
exit 0
`)
  chmodSync(tmux, 0o755)
  return { tmux, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) }
}

function setup(overrides: Record<string, unknown> = {}, run?: Run) {
  const home = mkdtempSync(join(tmpdir(), 'lsy-cc-admin-'))
  dirs.push(home)
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true })
  mkdirSync(join(home, '.config', 'claude-code'), { recursive: true })
  const { tmux, calls } = fakeTmux(home)
  const ctx = new Context()
  contexts.push(ctx)
  const logs: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push(`${message.type} ${String(message.args[0])}`) } })
  const admin = new ClaudeCodeAdmin(ctx, Config({ tmux, ...overrides } as never), home, run)
  return { ctx, admin, home, calls, logs, tmuxPath: tmux }
}

describe('configuration', () => {
  it('takes its defaults from the bridge\'s own schema, so the two cannot drift', () => {
    const bridge = BridgeConfig({} as never)
    expect(Config({} as never)).toEqual({
      enabled: true, sessionsDir: bridge.sessionsDir, tmux: bridge.tmux, command: bridge.command, workDir: bridge.workDir,
      model: bridge.model, maxSessions: bridge.maxSessions,
    })
    expect(Config({} as never)).toMatchObject({ tmux: '/opt/homebrew/bin/tmux', command: '/Users/dsh-runtime/bin/claude-dsh', maxSessions: 3 })
  })

  it('provides ctx.lsyClaudeCode when mounted as a plugin', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(ClaudeCodeAdmin, Config({} as never))
    expect(ctx.lsyClaudeCode).toBeInstanceOf(ClaudeCodeAdmin)
    expect(ctx.lsyClaudeCode.enabled).toBe(true)
  })
})

describe('login', () => {
  it('reads the login state from file existence alone', () => {
    const { admin, home } = setup()
    expect(admin.login()).toBe('none')
    writeFileSync(join(home, '.config', 'claude-code', 'oauth_token'), 'sk-ant-oat01-SECRET')
    expect(admin.login()).toBe('token')
    writeFileSync(join(home, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"SECRET2"}}')
    expect(admin.login()).toBe('full')
  })

  it('treats an empty credentials file as not signed in', () => {
    const { admin, home } = setup()
    writeFileSync(join(home, '.claude', '.credentials.json'), '')
    expect(admin.login()).toBe('none')
  })
})

describe('view', () => {
  it('lists the sessions the bridge started, and never carries a credential', async () => {
    const { admin, home } = setup()
    writeFileSync(join(home, '.config', 'claude-code', 'oauth_token'), 'sk-ant-oat01-SECRET')
    expect(await admin.start('review-1', undefined)).toEqual({ ok: true })
    const view = await admin.view()
    expect(view).toEqual({ enabled: true, login: 'token', sessions: [], maxSessions: 3, started: ['review-1'] })
    expect(JSON.stringify(view)).not.toContain('SECRET')
  })

  it('lists live sessions from Claude Code\'s registry and marks the ones tmux hosts', async () => {
    const { admin, home } = setup()
    // The registry skips this process and counts a record when its pid is alive with the recorded start time, so use the parent's.
    const procStart = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.ppid)], { env: { PATH: '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' } }).toString().trim()
    writeFileSync(join(home, '.claude', 'sessions', `${process.ppid}.json`), JSON.stringify({
      pid: process.ppid, procStart, kind: 'interactive', name: 'review-1', cwd: '/work/cc', status: 'idle', updatedAt: 1234, messagingSocketPath: '/tmp/review-1.sock',
    }))
    expect((await admin.view()).sessions).toEqual([{ name: 'review-1', pid: process.ppid, status: 'idle', cwd: '/work/cc', updatedAt: 1234, managed: false }])
    await admin.start('review-1', undefined)
    expect((await admin.view()).sessions[0]).toMatchObject({ name: 'review-1', managed: true })
  })
})

describe('configured sources', () => {
  it('lists sessions from the configured sessions directory, with nulls for a record that has no status, cwd or update time', async () => {
    const { home, tmuxPath } = setup()
    const ctx = new Context()
    contexts.push(ctx)
    const custom = join(home, 'elsewhere')
    mkdirSync(custom)
    const procStart = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.ppid)], { env: { PATH: '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' } }).toString().trim()
    writeFileSync(join(custom, `${process.ppid}.json`), JSON.stringify({
      pid: process.ppid, procStart, kind: 'interactive', name: 'custom-1', messagingSocketPath: '/tmp/custom-1.sock',
    }))
    const admin = new ClaudeCodeAdmin(ctx, Config({ tmux: tmuxPath, sessionsDir: custom } as never), home)
    expect((await admin.view()).sessions).toEqual([{ name: 'custom-1', pid: process.ppid, status: null, cwd: null, updatedAt: null, managed: false }])
  })

  it('runs tmux through the runner it was given', async () => {
    const seen: string[][] = []
    const run: Run = (_file, args) => {
      seen.push(args)
      return Promise.resolve(args.includes('list-sessions') ? { code: 0, stdout: 'from-runner\n' } : { code: 0, stdout: '' })
    }
    const { admin } = setup({}, run)
    expect((await admin.view()).started).toEqual(['from-runner'])
    expect(seen.some(args => args.includes('list-sessions'))).toBe(true)
  })

  it('says it is off when disabled, and reports that in the view', async () => {
    const { admin, logs } = setup({ enabled: false })
    expect(admin.enabled).toBe(false)
    expect((await admin.view()).enabled).toBe(false)
    expect(logs.some(line => line.startsWith('info lsy-cc-admin: Claude Code of ') && line.endsWith('is turned off'))).toBe(true)
  })
})

describe('start', () => {
  it('starts a named session in tmux with the first task as one quoted prompt argument, and logs without the task', async () => {
    const { admin, calls, logs } = setup()
    expect(await admin.start('review-1', 'read it; echo \'$HOME\'')).toEqual({ ok: true })
    const call = calls().find(line => line.includes('new-session'))!
    expect(call).toContain('-s review-1')
    expect(call).toContain('--name review-1 -- \'read it; echo \'\\\'\'$HOME\'\\\'\'\'')
    expect(logs).toContain('info lsy-cc-admin: started review-1 with a first task')
    expect(logs.join('\n')).not.toContain('read it')
  })

  it('refuses a task beyond the tool\'s limit before touching tmux', async () => {
    const { admin, calls } = setup()
    expect(await admin.start('ok', 'a'.repeat(MAX_TASK_CHARS + 1))).toEqual({ ok: false, error: 'invalid_request', detail: 'task too long' })
    expect(calls().filter(line => line.includes('new-session'))).toEqual([])
  })

  it('refuses bad names and duplicates, and stops at the limit with a code of its own', async () => {
    const { admin } = setup()
    expect(await admin.start('Bad Name', undefined)).toMatchObject({ ok: false, error: 'invalid_request' })
    for (const name of ['one', 'two', 'three']) expect(await admin.start(name, undefined)).toEqual({ ok: true })
    expect(await admin.start('four', undefined)).toEqual({ ok: false, error: 'limit_reached' })
    expect(await admin.start('two', undefined)).toMatchObject({ ok: false, error: 'invalid_request' })
  })

  it('reports a tmux that cannot start a session', async () => {
    const { admin, logs } = setup({ tmux: '/nonexistent/tmux' })
    expect(await admin.start('review-1', undefined)).toMatchObject({ ok: false, error: 'start_failed' })
    expect(logs.some(line => line.startsWith('warn lsy-cc-admin: starting review-1 failed'))).toBe(true)
  })
})

describe('stop', () => {
  it('stops a session it started and says not_found for any other', async () => {
    const { admin } = setup()
    await admin.start('review-1', undefined)
    expect(await admin.stop('review-1')).toEqual({ ok: true })
    expect((await admin.view()).started).toEqual([])
    expect(await admin.stop('review-1')).toMatchObject({ ok: false, error: 'not_found' })
    expect(await admin.stop('../etc')).toMatchObject({ ok: false, error: 'not_found' })
  })

  it('reports stop_failed with tmux\'s reason when tmux cannot kill a session it lists', async () => {
    const run: Run = (_file, args) => Promise.resolve(args.includes('kill-session') ? { code: 1, stdout: '' } : { code: 0, stdout: 'review-1\n' })
    const { admin, logs } = setup({}, run)
    expect(await admin.stop('review-1')).toEqual({ ok: false, error: 'stop_failed', detail: 'tmux could not stop the session' })
    expect(logs).toContain('warn lsy-cc-admin: stopping review-1 failed: tmux could not stop the session')
  })
})
