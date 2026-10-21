import type { LsyNote } from '@deepseek-ai/dsh-lsy-event-bus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeGitHub, release } from '../../lsy-github-sensor/tests/fake-github.ts'
import { ACME, NOTIFICATIONS, OCTO_RELEASES, disposeAll, harness, repository } from './harness.ts'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'))
})

afterEach(async () => {
  await disposeAll()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function mount(options: Parameters<typeof harness>[0] = {}) {
  const gh = new FakeGitHub('https://api.github.test')
  gh.set(ACME.repo, repository('acme/tool'))
  gh.set(ACME.releases, [release(1)])
  gh.set(ACME.commits, [])
  gh.set(OCTO_RELEASES, [])
  gh.set(NOTIFICATIONS, [])
  const test = await harness({ gh, ...options })
  test.notifier.ownsSession = sessionId => sessionId === 'chat'
  return test
}

/** Notes other than batch and result messages. */
function audits(notes: readonly LsyNote[]): LsyNote[] {
  return notes.filter(note => note.title.startsWith('🆕') || note.title.startsWith('🗑'))
}

describe('watch audit notes', () => {
  it('tells the owner when a Session the notifier does not relay creates or deletes a watch', async () => {
    const { callAs, notes } = await mount()
    expect(await callAs('webhook-1', 'watch_create', { id: 'acme', github_repo: 'acme/tool', streams: ['releases', 'commits'], branch: 'dev' })).toMatchObject({ id: 'acme' })
    expect(await callAs('webhook-1', 'watch_create', {
      id: 'inbox', github_notifications: true, action: 'session', instructions: `Triage ${'x'.repeat(400)}`,
    })).toMatchObject({ id: 'inbox' })
    expect(await callAs('webhook-2', 'watch_delete', { id: 'acme' })).toEqual({ id: 'acme', deleted: true })
    expect(await callAs('webhook-2', 'watch_delete', { id: 'inbox' })).toEqual({ id: 'inbox', deleted: true })
    await vi.advanceTimersByTimeAsync(0)
    const [created, session, deleted, deletedSession] = audits(notes)
    expect(created).toEqual({ title: '🆕 watch created: acme', body: 'target: GitHub repo acme/tool [releases, commits] on dev\naction: notify\nSession: webhook-1' })
    expect(session!.title).toBe('🆕 watch created: inbox')
    expect(session!.body).toMatch(/^target: GitHub notifications\naction: session\ninstructions: Triage x+…\nSession: webhook-1$/)
    expect(session!.body!.length).toBeLessThan(400)
    expect(deleted).toEqual({ title: '🗑 watch deleted: acme', body: 'target: GitHub repo acme/tool [releases, commits] on dev\naction: notify\nSession: webhook-2' })
    expect(deletedSession!.body).toMatch(/^target: GitHub notifications\naction: session\ninstructions: Triage x+…\nSession: webhook-2$/)
  })

  it('stays quiet in the owner\'s chat Session, where the agent\'s reply already confirms', async () => {
    const { callAs, notes } = await mount()
    await callAs('chat', 'watch_create', { id: 'acme', github_repo: 'acme/tool' })
    await callAs('chat', 'watch_delete', { id: 'acme' })
    await vi.advanceTimersByTimeAsync(0)
    expect(audits(notes)).toEqual([])
  })

  it('names an unknown Session for a call without a caller Agent', async () => {
    const { call, notes } = await mount()
    await call('watch_create', { id: 'inbox', github_notifications: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(audits(notes)).toEqual([{ title: '🆕 watch created: inbox', body: 'target: GitHub notifications\naction: notify\nSession: unknown' }])
  })

  it('describes deleted watches without a subscription or of another shape', async () => {
    const { callAs, notes, bus, sensor } = await mount()
    await sensor.watch('orphan', { repo: 'acme/tool', watch: ['releases'] })
    await sensor.watch('orphan-dev', { repo: 'acme/tool', watch: ['commits'], branch: 'dev' })
    await bus.subscribe({ id: 'custom', sources: ['rss'], kinds: ['rss.item'], subjects: [], action: 'notify', coalesceMs: 0, maxPerHour: 1 })
    await callAs('s1', 'watch_delete', { id: 'orphan' })
    await callAs('s1', 'watch_delete', { id: 'orphan-dev' })
    await callAs('s1', 'watch_delete', { id: 'custom' })
    await vi.advanceTimersByTimeAsync(0)
    expect(audits(notes).map(note => note.body)).toEqual([
      'target: GitHub repo acme/tool [releases]\naction: none (repository watch without a subscription)\nSession: s1',
      'target: GitHub repo acme/tool [commits] on dev\naction: none (repository watch without a subscription)\nSession: s1',
      'target: events sources [rss] kinds [rss.item] subjects []\naction: notify\nSession: s1',
    ])
  })

  it('sends nothing for refused calls', async () => {
    const { callAs, notes } = await mount()
    await callAs('s1', 'watch_create', { id: 'Bad' })
    await callAs('s1', 'watch_delete', { id: 'missing' })
    await callAs('s1', 'watch_delete', { id: 'config-releases' })
    await vi.advanceTimersByTimeAsync(0)
    expect(audits(notes)).toEqual([])
  })

  it('keeps the tool call successful when no notifier is mounted or the note fails', async () => {
    const quiet = await mount({ notifier: false })
    expect(await quiet.callAs('s1', 'watch_create', { id: 'inbox', github_notifications: true })).toMatchObject({ id: 'inbox' })
    expect(await quiet.callAs('s1', 'watch_delete', { id: 'inbox' })).toEqual({ id: 'inbox', deleted: true })

    const failing = await mount()
    const warn = vi.spyOn(failing.ctx.logger, 'warn').mockImplementation(() => {})
    failing.notifier.send = async () => { throw new Error('wechat down') }
    expect(await failing.callAs('s1', 'watch_create', { id: 'inbox', github_notifications: true })).toMatchObject({ id: 'inbox' })
    failing.notifier.send = () => { throw 'sync failure' }
    expect(await failing.callAs('s1', 'watch_delete', { id: 'inbox' })).toEqual({ id: 'inbox', deleted: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
      'lsy-tool-watch: audit note for inbox failed: wechat down',
      'lsy-tool-watch: audit note for inbox failed: sync failure',
    ])
  })
})
