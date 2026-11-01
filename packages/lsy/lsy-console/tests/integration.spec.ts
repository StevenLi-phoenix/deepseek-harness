import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ClaudeCodeAdmin, { Config } from '@deepseek-ai/dsh-lsy-cc-admin'
import * as Style from '@deepseek-ai/dsh-lsy-style'
import { StyleStore } from '@deepseek-ai/dsh-lsy-style/src/store.ts'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentsView } from '../src/views.ts'
import { mountConsole } from './fixtures.ts'

const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the page over the real lsy-cc-admin service', () => {
  it('lists, starts with a first task, and stops through ctx.lsyClaudeCode, with a fake tmux underneath', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lsy-console-cc-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude', 'sessions'), { recursive: true })
    const state = join(home, 'sessions')
    const log = join(home, 'calls')
    writeFileSync(state, '')
    const tmux = join(home, 'tmux')
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

    const ctx = new Context()
    contexts.push(ctx)
    // The service takes its home from the process; the sessions directory is configured, and the login files are checked under `home`.
    new ClaudeCodeAdmin(ctx, Config({ tmux, sessionsDir: join(home, '.claude', 'sessions') } as never), home)
    const { call } = await mountConsole({ ctx })

    const view = async (): Promise<AgentsView> => await (await call('/api/lsy.agents')).json() as AgentsView
    expect((await view()).cc).toEqual({ enabled: true, login: 'none', sessions: [], maxSessions: 3, started: [] })

    const started = await call('/api/lsy.agents', { method: 'POST', body: { action: 'cc.start', name: 'review-1', task: 'read the logs' } })
    expect(started.status).toBe(200)
    expect(((await started.json()) as { cc: AgentsView['cc'] }).cc!.started).toEqual(['review-1'])
    expect(existsSync(log) && readFileSync(log, 'utf8')).toContain('--name review-1 -- \'read the logs\'')

    const stopped = await call('/api/lsy.agents', { method: 'POST', body: { action: 'cc.stop', name: 'review-1' } })
    expect(stopped.status).toBe(200)
    expect((await view()).cc!.started).toEqual([])

    const again = await call('/api/lsy.agents', { method: 'POST', body: { action: 'cc.stop', name: 'review-1' } })
    expect(again.status).toBe(404)

    for (const name of ['one', 'two', 'three']) await call('/api/lsy.agents', { method: 'POST', body: { action: 'cc.start', name } })
    const fourth = await call('/api/lsy.agents', { method: 'POST', body: { action: 'cc.start', name: 'four' } })
    expect([fourth.status, await fourth.json()]).toEqual([429, { error: 'limit_reached' }])
  })

  it('reports the overview card from the real service', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    new ClaudeCodeAdmin(ctx, Config({ tmux: '/nonexistent/tmux', sessionsDir: '/nonexistent/sessions' } as never), '/nonexistent/home')
    const { call } = await mountConsole({ ctx })
    const overview = await (await call('/api/lsy.overview')).json() as { cards: { id: string; tone: string; state: string }[] }
    expect(overview.cards.find(card => card.id === 'cc')).toMatchObject({ tone: 'warn', state: 'nologin' })
  })
})

describe('the overview over the real lsy-style service', () => {
  async function mountStyle(review: 'optional' | 'required', pending: boolean) {
    const dir = mkdtempSync(join(tmpdir(), 'lsy-console-style-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'tics.json'), JSON.stringify({ days: {} }))
    if (pending) {
      await new StyleStore(join(dir, 'samples.jsonl'), { maxActive: 60, maxOwner: 20, maxPending: 40, maxTombstones: 100 })
        .ingest([{ source: 'qq', origin: { platform: 'qq', groups: 1, speakers: 2, days: 1 }, at: Date.now(), prompt: '周末去哪', reply: '宅着' }], review)
    }
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Style, { dir, ticsFile: join(dir, 'tics.json'), qq: { enabled: false }, bili: { enabled: false }, review } as Style.Config)
    return mountConsole({ ctx })
  }
  const card = async (mounted: Awaited<ReturnType<typeof mountStyle>>) => {
    const view = await (await mounted.call('/api/lsy.overview')).json() as { cards: { id: string }[] }
    return view.cards.find(entry => entry.id === 'style')
  }

  it('is green with the real health() shape, and carries counts only', async () => {
    const mounted = await mountStyle('optional', false)
    expect(await card(mounted)).toMatchObject({ tone: 'ok', state: 'up', facts: { kept: 0, pending: 0, review: 'optional', lastRefreshAt: null, ticTrend: null } })
  })

  it('is yellow when review is required and samples wait', async () => {
    const mounted = await mountStyle('required', true)
    // health() reports the counts of the last refresh; reading the panel (or a scheduled check) takes one.
    await mounted.ctx.get('lsyStyle')!.panel()
    expect(await card(mounted)).toMatchObject({ tone: 'warn', state: 'pending', facts: { kept: 0, pending: 1, review: 'required' } })
    expect(JSON.stringify(await card(mounted))).not.toContain('宅着')
  })
})
