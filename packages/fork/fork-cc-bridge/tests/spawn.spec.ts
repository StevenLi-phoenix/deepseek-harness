import { describe, expect, it } from 'vitest'
import { Spawner, type Run } from '../src/spawn.ts'

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
})
