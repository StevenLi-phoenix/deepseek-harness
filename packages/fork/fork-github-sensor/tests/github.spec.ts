import { describe, expect, it } from 'vitest'
import { commitEvent, htmlUrl, notificationEvent, releaseEvent, tagEvent } from '../src/github.ts'
import { commit, release, thread } from './fake-github.ts'

describe('releaseEvent', () => {
  it('maps a published release', () => {
    expect(releaseEvent('octo/repo', release(2), 100)).toEqual({
      source: 'github',
      kind: 'github.release',
      key: 'octo/repo:release:2',
      subject: 'octo/repo',
      title: 'v2.0.0',
      url: 'https://github.com/octo/repo/releases/tag/v2.0.0',
      actor: 'octocat',
      text: 'Notes for 2',
      occurredAt: Date.parse('2026-10-22T00:00:00Z'),
    })
  })

  it('names pre-releases, distinct names, and missing fields', () => {
    const event = releaseEvent('octo/repo', release(3, { name: 'Big one', prerelease: true, body: null, author: null, published_at: null }), 100)
    expect(event).toMatchObject({ title: 'v3.0.0 — Big one (pre-release)' })
    expect(event).not.toHaveProperty('text')
    expect(event).not.toHaveProperty('actor')
    expect(event).not.toHaveProperty('occurredAt')
  })

  it('bounds release notes', () => {
    expect(releaseEvent('octo/repo', release(1, { body: 'x'.repeat(50) }), 10).text).toBe(`${'x'.repeat(10)}…`)
  })
})

describe('tagEvent', () => {
  it('maps a tag to a tree link', () => {
    expect(tagEvent('octo/repo', { name: 'v1', commit: { sha: 'abc' } })).toEqual({
      source: 'github',
      kind: 'github.tag',
      key: 'octo/repo:tag:v1',
      subject: 'octo/repo',
      title: 'tag v1',
      url: 'https://github.com/octo/repo/tree/v1',
    })
  })
})

describe('commitEvent', () => {
  it('titles a commit by its first line and keeps the full message as text', () => {
    expect(commitEvent('octo/repo', commit('abc123', 'fix: thing\n\nDetails here'), 100)).toEqual({
      source: 'github',
      kind: 'github.commit',
      key: 'octo/repo:commit:abc123',
      subject: 'octo/repo',
      title: 'fix: thing',
      url: 'https://github.com/octo/repo/commit/abc123',
      actor: 'octocat',
      text: 'fix: thing\n\nDetails here',
      occurredAt: Date.parse('2026-10-21T00:00:00Z'),
    })
  })

  it('omits the actor and time when GitHub reports neither', () => {
    const anonymous = { ...commit('abc', 'msg', null), commit: { message: 'msg', author: { date: 'not a date' } } }
    const event = commitEvent('octo/repo', anonymous, 100)
    expect(event).not.toHaveProperty('actor')
    expect(event).not.toHaveProperty('occurredAt')
  })

  it('falls back to the git author name and a short sha title', () => {
    const event = commitEvent('octo/repo', commit('abcdef1234567', '', null), 100)
    expect(event).toMatchObject({ actor: 'Octo Cat', title: 'commit abcdef1' })
  })
})

describe('notificationEvent', () => {
  it('maps a thread with its reason and an HTML link', () => {
    expect(notificationEvent(thread('7', '2026-10-21T01:00:00Z'))).toEqual({
      source: 'github',
      kind: 'github.notification.issue',
      key: 'notification:7:2026-10-21T01:00:00Z',
      subject: 'octo/repo',
      title: '[subscribed] Issue 7',
      url: 'https://github.com/octo/repo/issues/7',
      occurredAt: Date.parse('2026-10-21T01:00:00Z'),
    })
  })

  it('normalizes subject types and falls back to the repository link', () => {
    const event = notificationEvent(thread('8', '2026-10-21T01:00:00Z', { subject: { title: 'Run', url: null, type: 'CheckSuite' } }))
    expect(event).toMatchObject({ kind: 'github.notification.checksuite', url: 'https://github.com/octo/repo' })
  })
})

describe('htmlUrl', () => {
  it('maps API issue, pull, and commit URLs to github.com', () => {
    expect(htmlUrl('https://api.github.com/repos/o/r/issues/1', 'x')).toBe('https://github.com/o/r/issues/1')
    expect(htmlUrl('https://api.github.com/repos/o/r/pulls/2', 'x')).toBe('https://github.com/o/r/pull/2')
    expect(htmlUrl('https://api.github.com/repos/o/r/commits/abc', 'x')).toBe('https://github.com/o/r/commit/abc')
  })

  it('falls back for other or missing URLs', () => {
    expect(htmlUrl('https://api.github.com/repos/o/r/releases/9', 'https://github.com/o/r')).toBe('https://github.com/o/r')
    expect(htmlUrl(null, 'https://github.com/o/r')).toBe('https://github.com/o/r')
  })
})
