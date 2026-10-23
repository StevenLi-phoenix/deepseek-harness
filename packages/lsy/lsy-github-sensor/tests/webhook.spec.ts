import { describe, expect, it } from 'vitest'
import { releaseEvent } from '../src/github.ts'
import { deliveryEvents } from '../src/webhook.ts'

const repository = { full_name: 'octo/repo', default_branch: 'main', html_url: 'https://github.com/octo/repo' }
const sender = { login: 'alice' }
const events = (name: string, payload: Record<string, unknown>, deliveryId = 'd-1') =>
  deliveryEvents({ name, payload: { repository, sender, ...payload } }, deliveryId, 2000)

describe('deliveryEvents', () => {
  it('reports a published release with the key polling uses', () => {
    const release = { id: 7, tag_name: 'v1.2.0', name: 'One two', prerelease: false, html_url: 'https://github.com/octo/repo/releases/tag/v1.2.0', author: { login: 'alice' }, body: 'notes', published_at: '2026-10-22T20:00:00Z' }
    expect(events('release', { action: 'published', release })).toEqual([releaseEvent('octo/repo', release, 2000)])
    expect(events('release', { action: 'published', release })[0]!.key).toBe('octo/repo:release:7')
    expect(events('release', { action: 'edited', release })).toEqual([])
  })

  it('reports a created tag and ignores created branches', () => {
    expect(events('create', { ref_type: 'tag', ref: 'v1.2.0' })).toEqual([{
      source: 'github', kind: 'github.tag', key: 'octo/repo:tag:v1.2.0', subject: 'octo/repo', title: 'tag v1.2.0', url: 'https://github.com/octo/repo/tree/v1.2.0',
    }])
    expect(events('create', { ref_type: 'branch', ref: 'feature' })).toEqual([])
  })

  it('reports commits pushed to the default branch only', () => {
    const commits = [
      { id: 'a1b2c3d', message: 'Fix the thing\n\nLonger body', timestamp: '2026-10-22T20:01:00Z', url: 'https://github.com/octo/repo/commit/a1b2c3d', author: { name: 'Alice', username: 'alice' } },
      { id: 'e4f5a6b', message: '', timestamp: 'not a date', url: 'https://github.com/octo/repo/commit/e4f5a6b', author: { name: 'Bob' } },
    ]
    expect(events('push', { ref: 'refs/heads/main', deleted: false, commits })).toEqual([
      { source: 'github', kind: 'github.commit', key: 'octo/repo:commit:a1b2c3d', subject: 'octo/repo', title: 'Fix the thing', url: commits[0]!.url, actor: 'alice', text: 'Fix the thing\n\nLonger body', occurredAt: Date.parse('2026-10-22T20:01:00Z') },
      { source: 'github', kind: 'github.commit', key: 'octo/repo:commit:e4f5a6b', subject: 'octo/repo', title: 'commit e4f5a6b', url: commits[1]!.url, actor: 'Bob' },
    ])
    expect(events('push', { ref: 'refs/heads/feature', deleted: false, commits })).toEqual([])
    expect(events('push', { ref: 'refs/heads/main', deleted: true, commits: [] })).toEqual([])
  })

  it('reports pull requests, issues, comments, reviews, and finished workflow runs by event and action', () => {
    expect(events('pull_request', { action: 'opened', number: 12, pull_request: { title: 'Add pill', html_url: 'https://github.com/octo/repo/pull/12', body: 'Adds it' } })).toEqual([{
      source: 'github', kind: 'github.pull_request.opened', key: 'octo/repo:pull_request:d-1', subject: 'octo/repo', title: 'PR #12 opened: Add pill', url: 'https://github.com/octo/repo/pull/12', actor: 'alice', text: 'Adds it',
    }])
    expect(events('issues', { action: 'closed', issue: { number: 5, title: 'Bug', html_url: 'https://github.com/octo/repo/issues/5' } })[0])
      .toMatchObject({ kind: 'github.issues.closed', title: 'issue #5 closed: Bug' })
    expect(events('issue_comment', { action: 'created', issue: { number: 5, title: 'Bug', html_url: 'u' }, comment: { body: 'Me too', html_url: 'https://github.com/octo/repo/issues/5#c1' } })[0])
      .toMatchObject({ kind: 'github.issue_comment.created', title: 'comment on #5: Bug', url: 'https://github.com/octo/repo/issues/5#c1', text: 'Me too' })
    expect(events('pull_request_review', { action: 'submitted', review: { state: 'changes_requested', html_url: 'r', body: null }, pull_request: { number: 12, title: 'Add pill', html_url: 'p' } })[0])
      .toMatchObject({ kind: 'github.pull_request_review.submitted', title: 'review changes_requested on PR #12: Add pill', url: 'r' })
    expect(events('workflow_run', { action: 'completed', workflow_run: { name: 'CI', conclusion: 'failure', head_branch: 'main', html_url: 'w' } })[0])
      .toMatchObject({ kind: 'github.workflow_run.completed', title: 'workflow CI failure on main', url: 'w' })
    expect(events('workflow_run', { action: 'requested', workflow_run: { name: 'CI', conclusion: null, head_branch: 'main', html_url: 'w' } })).toEqual([])
  })

  it('names other repository events generically and drops app housekeeping and repository-less deliveries', () => {
    expect(events('star', { action: 'created' })[0]).toMatchObject({ kind: 'github.star.created', title: 'star created', url: 'https://github.com/octo/repo' })
    expect(events('ping', { zen: 'Keep it logically awesome.' })).toEqual([])
    expect(events('workflow_job', { action: 'queued' })).toEqual([])
    expect(events('check_suite', { action: 'requested' })).toEqual([])
    expect(events('check_suite', { action: 'completed' })[0]).toMatchObject({ kind: 'github.check_suite.completed', title: 'check suite completed' })
    expect(deliveryEvents({ name: 'installation', payload: { action: 'created', sender } }, 'd-2', 2000)).toEqual([])
    expect(deliveryEvents({ name: 'push', payload: { ref: 'refs/heads/main' } }, 'd-3', 2000)).toEqual([])
  })
})

describe('webhook rule', () => {
  it('registers one github rule that publishes mapped events and starts no Session', async () => {
    const { vi } = await import('vitest')
    const { FakeGitHub } = await import('./fake-github.ts')
    const { harness } = await import('./harness.ts')
    vi.useFakeTimers()
    try {
      const rules: { id: string; kind: string; run: (delivery: unknown, signal: AbortSignal) => unknown }[] = []
      const disposed = vi.fn()
      const h = await harness(new FakeGitHub(), {
        beforeSensor: (ctx) => { ctx.provide('webhookRuntime', { register: (rule: (typeof rules)[number]) => { rules.push(rule); return disposed } } as never) },
      })
      expect(rules.map(rule => [rule.id, rule.kind])).toEqual([['lsy-github-sensor', 'github']])
      const result = await rules[0]!.run({
        kind: 'github', source: 'github-app', deliveryId: 'd-9', receivedAt: 0,
        event: { name: 'create', payload: { ref_type: 'tag', ref: 'v2', repository, sender } },
      }, new AbortController().signal)
      expect(result).toBeNull()
      expect(h.published.map(event => event.key)).toEqual(['octo/repo:tag:v2'])
      await h.ctx.fiber.dispose()
      expect(disposed).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
