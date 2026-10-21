import { describe, expect, it } from 'vitest'
import { globToRegExp, matchesSubscription, suppressionReason } from '../src/match.ts'
import type { LsyEventInput, Subscription } from '../src/types.ts'

const event: LsyEventInput = {
  source: 'github',
  kind: 'github.release',
  key: 'octo/repo:release:1',
  subject: 'octo/repo',
  title: 'v1.0.0',
  actor: 'octocat',
  text: 'Release notes',
}

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub',
    sources: [],
    kinds: [],
    subjects: [],
    action: 'notify',
    coalesceMs: 0,
    maxPerHour: 10,
    ...overrides,
  }
}

describe('globToRegExp', () => {
  it('matches the whole string with * as any run of characters', () => {
    expect(globToRegExp('github.*').test('github.release')).toBe(true)
    expect(globToRegExp('github.*').test('xgithub.release')).toBe(false)
    expect(globToRegExp('octo/*').test('octo/repo')).toBe(true)
    expect(globToRegExp('octo/repo').test('octo/repo2')).toBe(false)
  })

  it('treats regular-expression metacharacters literally', () => {
    expect(globToRegExp('a.b+c?').test('a.b+c?')).toBe(true)
    expect(globToRegExp('a.b').test('axb')).toBe(false)
  })

  it('matches case-insensitively because GitHub owners and repos are case-insensitive', () => {
    expect(globToRegExp('Octo/Repo').test('octo/repo')).toBe(true)
  })
})

describe('matchesSubscription', () => {
  it('matches everything when every selector list is empty', () => {
    expect(matchesSubscription(subscription(), event)).toBe(true)
  })

  it('requires every non-empty selector list to have at least one matching pattern', () => {
    expect(matchesSubscription(subscription({ sources: ['github'], kinds: ['github.release'], subjects: ['octo/*'] }), event)).toBe(true)
    expect(matchesSubscription(subscription({ sources: ['proc'] }), event)).toBe(false)
    expect(matchesSubscription(subscription({ kinds: ['github.commit', 'github.tag'] }), event)).toBe(false)
    expect(matchesSubscription(subscription({ subjects: ['other/*'] }), event)).toBe(false)
  })
})

describe('suppressionReason', () => {
  it('returns undefined when nothing matches', () => {
    expect(suppressionReason({ actors: ['bot'], markers: ['Dsh-Agent:'] }, event)).toBeUndefined()
  })

  it('suppresses events whose actor is one of the agent identities, case-insensitively', () => {
    expect(suppressionReason({ actors: ['OctoCat'], markers: [] }, event)).toBe('actor:octocat')
  })

  it('suppresses events whose title or text carries a loop marker', () => {
    expect(suppressionReason({ actors: [], markers: ['notes'] }, event)).toBe('marker:notes')
    expect(suppressionReason({ actors: [], markers: ['v1.0'] }, event)).toBe('marker:v1.0')
  })

  it('ignores blank markers so an empty config entry cannot suppress everything', () => {
    expect(suppressionReason({ actors: [''], markers: ['', '  '] }, event)).toBeUndefined()
  })
})
