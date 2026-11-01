import { describe, expect, it } from 'vitest'
import type { SubscriptionsView } from '../src/views.ts'
import { parseSubscriptions } from '../src/client/parse.ts'
import { blankDraft, optimisticPatch, parseList, requestKey, toRequest, validateDraft } from '../src/client/subs.ts'

const VIEW: SubscriptionsView = {
  subscriptions: [
    { id: 'a', origin: 'config', mode: 'notify', sources: [], kinds: [], subjects: [], paused: false, createdBy: null, createdAt: null, lastFiredAt: null, fireCount: 0, pending: 0, lastStatus: null },
    { id: 'b', origin: 'agent', mode: 'session', sources: ['x'], kinds: [], subjects: [], paused: false, createdBy: 's1', createdAt: 1, lastFiredAt: 5, fireCount: 2, pending: 1, lastStatus: 'delivered' },
  ],
  schedules: [
    { id: 's1', title: 'T', rule: 'every', detail: '60 s', status: 'active', nextAt: 1, lastFiredAt: null },
    { id: 's2', title: 'U', rule: 'daily', detail: '', status: 'paused', nextAt: 2, lastFiredAt: null },
  ],
  archive: null,
  defaults: { coalesceSeconds: 60, notifyMaxPerHour: 12, sessionMaxPerHour: 4, agentPreset: 'unattended', workspacePath: '/w' },
  checkedAt: 1,
}

describe('form', () => {
  it('splits selector fields on spaces and commas', () => {
    expect(parseList(' github, gitlab  kaorou ,')).toEqual(['github', 'gitlab', 'kaorou'])
    expect(parseList('')).toEqual([])
  })

  it('applies the Host\'s rules before anything is sent', () => {
    const ok = { ...blankDraft(), id: 'octo-tags', kinds: 'github.tag' }
    expect(validateDraft(ok)).toEqual([])
    expect(validateDraft(blankDraft())).toEqual(['id', 'selector'])
    expect(validateDraft({ ...ok, id: 'Bad Id' })).toEqual(['id'])
    expect(validateDraft({ ...ok, id: '-x' })).toEqual(['id'])
    expect(validateDraft({ ...ok, id: 'a'.repeat(64) })).toEqual(['id'])
    expect(validateDraft({ ...ok, mode: 'session' })).toEqual(['instructions'])
    expect(validateDraft({ ...ok, mode: 'session', instructions: 'a'.repeat(4001) })).toEqual(['instructions'])
    expect(validateDraft({ ...ok, mode: 'session', instructions: ' do it ' })).toEqual([])
    expect(validateDraft({ ...ok, coalesceSeconds: '1.5' })).toEqual(['number'])
    expect(validateDraft({ ...ok, coalesceSeconds: '86401' })).toEqual(['number'])
    expect(validateDraft({ ...ok, maxPerHour: '0' })).toEqual(['number'])
    expect(validateDraft({ ...ok, maxPerHour: '61' })).toEqual(['number'])
    expect(validateDraft({ ...ok, coalesceSeconds: '0', maxPerHour: '60' })).toEqual([])
  })

  it('builds the create request, leaving blank numbers and notify-mode instructions out', () => {
    expect(toRequest({ ...blankDraft(), id: 'x', sources: 'a, b', kinds: 'k.*', instructions: 'ignored' })).toEqual({
      action: 'create', subscription: { id: 'x', sources: ['a', 'b'], kinds: ['k.*'], subjects: [], mode: 'notify' },
    })
    expect(toRequest({ ...blankDraft(), id: 'y', subjects: 'o/r', mode: 'session', instructions: ' go ', coalesceSeconds: '5', maxPerHour: '2' })).toEqual({
      action: 'create', subscription: { id: 'y', sources: [], kinds: [], subjects: ['o/r'], mode: 'session', instructions: 'go', coalesceSeconds: 5, maxPerHour: 2 },
    })
  })
})

describe('requests', () => {
  it('keys a request by what it acts on', () => {
    expect(requestKey({ action: 'pause', target: 'subscription', id: 'b' })).toBe('pause:subscription:b')
    expect(requestKey({ action: 'create', subscription: { id: 'n', sources: [], kinds: ['k'], subjects: [], mode: 'notify' } })).toBe('create:n')
    expect(requestKey({ action: 'archive.sweep', dryRun: true })).toBe('archive:preview')
    expect(requestKey({ action: 'archive.sweep', dryRun: false })).toBe('archive:sweep')
  })

  it('has no optimistic patch for a sweep, whose effect only the Host knows', () => {
    expect(optimisticPatch({ action: 'archive.sweep', dryRun: false })).toBeUndefined()
  })

  it('shows pause, resume, and delete on the rows before the Host answers', () => {
    const apply = (request: Parameters<typeof optimisticPatch>[0]) => optimisticPatch(request)!(VIEW)
    expect(apply({ action: 'pause', target: 'subscription', id: 'b' }).subscriptions!.map(row => [row.id, row.paused])).toEqual([['a', false], ['b', true]])
    expect(apply({ action: 'delete', target: 'subscription', id: 'b' }).subscriptions!.map(row => row.id)).toEqual(['a'])
    expect(apply({ action: 'pause', target: 'schedule', id: 's1' }).schedules!.map(row => row.status)).toEqual(['paused', 'paused'])
    expect(apply({ action: 'resume', target: 'schedule', id: 's2' }).schedules!.map(row => row.status)).toEqual(['active', 'active'])
    expect(apply({ action: 'delete', target: 'schedule', id: 's1' }).schedules!.map(row => row.id)).toEqual(['s2'])
  })

  it('leaves a missing list alone and shows nothing early for create', () => {
    expect(optimisticPatch({ action: 'create', subscription: { id: 'n', sources: [], kinds: ['k'], subjects: [], mode: 'notify' } })).toBeUndefined()
    const none = { ...VIEW, subscriptions: null, schedules: null }
    expect(optimisticPatch({ action: 'delete', target: 'subscription', id: 'a' })!(none)).toBe(none)
    expect(optimisticPatch({ action: 'delete', target: 'schedule', id: 'a' })!(none)).toBe(none)
  })
})

describe('parseSubscriptions', () => {
  it('reads a Host from before the auto-archive as having none, and refuses a malformed archive field', () => {
    const { archive: _archive, ...older } = VIEW
    expect(parseSubscriptions(older).archive).toBeNull()
    expect(parseSubscriptions(VIEW)).toBe(VIEW)
    expect(() => parseSubscriptions({ ...VIEW, archive: 'yes' })).toThrow('unexpected subscriptions answer')
  })
})
