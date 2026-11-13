import { describe, expect, it } from 'vitest'
import { Spawner, runProgram, type Run } from '../src/spawn.ts'

function fake(sessions: string[] = []) {
  const calls: string[][] = []
  const run: Run = (_file, args) => {
    calls.push(args)
    const tmuxArgs = args.slice(args.indexOf('-L') + 2)
    if (tmuxArgs[0] === 'list-sessions') return Promise.resolve({ code: sessions.length === 0 ? 1 : 0, stdout: sessions.join('\n') })
    if (tmuxArgs[0] === 'new-session') sessions.push(tmuxArgs[tmuxArgs.indexOf('-s') + 1]!)
    return Promise.resolve({ code: 0, stdout: '' })
  }
  const spawner = new Spawner({ tmux: '/opt/homebrew/bin/tmux', command: '/Users/dsh-runtime/bin/claude-dsh', workDir: '/Users/dsh-runtime/work/cc', model: 'sonnet', maxSessions: 2, home: '/Users/dsh-runtime', run })
  return { spawner, calls }
}

describe('Spawner', () => {
  it('starts a detached tmux session from a cleaned environment', async () => {
    const { spawner, calls } = fake()
    expect(await spawner.start('review-1')).toEqual({ ok: true })
    const call = calls.at(-1)!
    expect(call.slice(0, 5)).toEqual(['-i', 'HOME=/Users/dsh-runtime', 'PATH=/opt/homebrew/bin:/usr/bin:/bin', 'LANG=en_US.UTF-8', 'TERM=xterm-256color'])
    expect(call).toContain('/opt/homebrew/bin/tmux')
    expect(call.at(-1)).toBe('/Users/dsh-runtime/bin/claude-dsh --model sonnet --name review-1')
    expect(call[call.indexOf('-c') + 1]).toBe('/Users/dsh-runtime/work/cc')
  })

  it('passes a first task as the launcher\'s prompt argument, quoted so the shell sees one word', async () => {
    const { spawner, calls } = fake()
    expect(await spawner.start('review-1', 'read it; echo \'$HOME\' `id`\nthen stop')).toEqual({ ok: true })
    expect(calls.at(-1)!.at(-1)).toBe(
      '/Users/dsh-runtime/bin/claude-dsh --model sonnet --name review-1 -- \'read it; echo \'\\\'\'$HOME\'\\\'\' `id`\nthen stop\'',
    )
  })

  it('starts without a prompt argument when the task is blank', async () => {
    const { spawner, calls } = fake()
    await spawner.start('review-1', '  \n ')
    expect(calls.at(-1)!.at(-1)).toBe('/Users/dsh-runtime/bin/claude-dsh --model sonnet --name review-1')
  })

  it('refuses names that could carry shell syntax, duplicates, and more than the limit', async () => {
    const { spawner } = fake()
    expect(await spawner.start('a b; rm -rf /')).toMatchObject({ ok: false })
    expect(await spawner.start('Upper')).toMatchObject({ ok: false })
    await spawner.start('one')
    expect(await spawner.start('one')).toMatchObject({ ok: false, error: expect.stringContaining('already running') as string })
    await spawner.start('two')
    expect(await spawner.start('three')).toMatchObject({ ok: false, error: expect.stringContaining('limit is 2') as string })
  })

  it('stops only sessions it started', async () => {
    const { spawner, calls } = fake(['one'])
    expect(await spawner.stop('other')).toMatchObject({ ok: false })
    expect(await spawner.stop('one')).toEqual({ ok: true })
    expect(calls.at(-1)).toContain('kill-session')
  })

  it('refuses to start when the configured model name could carry shell syntax', async () => {
    const calls: string[][] = []
    const run: Run = (_file, args) => { calls.push(args); return Promise.resolve({ code: 0, stdout: '' }) }
    const spawner = new Spawner({ tmux: 't', command: 'c', workDir: '/w', model: 'sonnet; id', maxSessions: 2, home: '/h', run })
    expect(await spawner.start('review-1')).toEqual({ ok: false, error: 'the configured model name is not valid' })
    expect(calls).toEqual([])
  })

  it('reports tmux failing to create or kill a session', async () => {
    const run: Run = (_file, args) =>
      Promise.resolve(args.includes('list-sessions') ? { code: 0, stdout: 'one\n' } : { code: 1, stdout: '' })
    const spawner = new Spawner({ tmux: 't', command: 'c', workDir: '/w', model: 'sonnet', maxSessions: 2, home: '/h', run })
    expect(await spawner.start('two')).toEqual({ ok: false, error: 'tmux could not start the session' })
    expect(await spawner.stop('one')).toEqual({ ok: false, error: 'tmux could not stop the session' })
  })

  it('refuses to stop a name that could not have been started, without asking tmux', async () => {
    const { spawner, calls } = fake(['one'])
    expect(await spawner.stop('Not Valid')).toEqual({ ok: false, error: 'no session named Not Valid was started by cc_start' })
    expect(calls).toEqual([])
  })
})

describe('runProgram', () => {
  it('runs with only a minimal PATH and returns the output', async () => {
    expect(await runProgram('/bin/sh', ['-c', 'printf %s "$PATH"'])).toEqual({ code: 0, stdout: '/usr/bin:/bin' })
  })

  it('returns the exit code of a failing program', async () => {
    expect(await runProgram('/bin/sh', ['-c', 'printf partial; exit 3'])).toEqual({ code: 3, stdout: 'partial' })
  })

  it('resolves with code 1 when the program cannot run at all', async () => {
    expect(await runProgram('/nonexistent/program', [])).toEqual({ code: 1, stdout: '' })
  })
})
