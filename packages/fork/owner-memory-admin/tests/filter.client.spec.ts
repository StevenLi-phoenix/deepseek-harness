import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FILTER, dismissKey, entryMatches, groupMatches, isFiltered, keepShown, mergeApplyPayload, mergePayload,
  reclassifyPayload, selectAll, suggestionKey, termsOf, toggleSelection, withFilter, type ListFilter,
} from '../src/client/filter.ts'
import type { Category, EntryView } from '../src/view.ts'

const entry = (id: string, category: Category, text: string): EntryView => ({
  id, category, date: '2026-10-01', text, clipped: false, source: 'owner-turn', protected: false, revertible: true,
})

const GROUP = {
  ids: ['aaaaaa', 'bbbbbb'],
  members: [
    { id: 'aaaaaa', category: 'projects' as const, text: 'the memory page groups duplicates' },
    { id: 'bbbbbb', category: 'identity' as const, text: 'the memory page highlights differences' },
  ],
}

describe('the list filter', () => {
  it('changes one field at a time and knows when it hides something', () => {
    expect(withFilter(DEFAULT_FILTER, { category: 'career' })).toEqual({ q: '', category: 'career', mode: 'all' })
    expect(isFiltered(DEFAULT_FILTER)).toBe(false)
    expect(isFiltered({ ...DEFAULT_FILTER, q: '  ' })).toBe(false)
    expect(isFiltered({ ...DEFAULT_FILTER, q: 'lease' })).toBe(true)
    expect(isFiltered({ ...DEFAULT_FILTER, category: 'identity' })).toBe(true)
  })

  it('reads search terms the way the Host does', () => {
    expect(termsOf('Alice  alice LEASE')).toEqual(['alice', 'lease'])
    expect(termsOf('   ')).toEqual([])
  })

  it('matches an entry by every term, the id, and its category', () => {
    const lease = entry('aaaaaa', 'identity', 'Lease expires 2026-09-06')
    expect(entryMatches(lease, { ...DEFAULT_FILTER, q: 'lease 2026' })).toBe(true)
    expect(entryMatches(lease, { ...DEFAULT_FILTER, q: 'aaaaaa' })).toBe(true)
    expect(entryMatches(lease, { ...DEFAULT_FILTER, q: 'lease car' })).toBe(false)
    expect(entryMatches(lease, { ...DEFAULT_FILTER, category: 'career' })).toBe(false)
  })

  it('narrows duplicate groups by the same terms, across all their members', () => {
    const filter: ListFilter = { ...DEFAULT_FILTER, q: 'highlights' }
    expect(groupMatches(GROUP, filter)).toBe(true)
    expect(groupMatches(GROUP, { ...DEFAULT_FILTER, q: 'bbbbbb' })).toBe(true)
    expect(groupMatches(GROUP, { ...DEFAULT_FILTER, q: 'memory lease' })).toBe(false)
    expect(groupMatches(GROUP, { ...DEFAULT_FILTER, category: 'identity' })).toBe(true)
    expect(groupMatches(GROUP, { ...DEFAULT_FILTER, category: 'career' })).toBe(false)
  })
})

describe('dismiss keys', () => {
  it('is the same for a group no matter the member order, and per entry for a stale one', () => {
    expect(dismissKey('merge', ['bbbbbb', 'aaaaaa'])).toBe('merge:aaaaaa-bbbbbb')
    expect(dismissKey('stale', ['aaaaaa'])).toBe('stale:aaaaaa')
    expect(suggestionKey({ key: 'x', kind: 'merge', reason: 'duplicate', ids: ['aaaaaa', 'bbbbbb'], category: 'projects', text: 'x' }))
      .toBe('merge:aaaaaa-bbbbbb')
    expect(suggestionKey({ key: 'x', kind: 'stale', reason: 'expired-date', ids: ['aaaaaa'], category: 'identity', text: 'x' }))
      .toBe('stale:aaaaaa')
  })
})

describe('selection', () => {
  it('adds and takes out one id, and selects or clears a whole page', () => {
    expect(toggleSelection([], 'aaaaaa')).toEqual(['aaaaaa'])
    expect(toggleSelection(['aaaaaa', 'bbbbbb'], 'aaaaaa')).toEqual(['bbbbbb'])
    expect(selectAll([], ['aaaaaa', 'bbbbbb'])).toEqual(['aaaaaa', 'bbbbbb'])
    expect(selectAll(['aaaaaa'], ['aaaaaa', 'bbbbbb'])).toEqual(['aaaaaa', 'bbbbbb'])
    expect(selectAll(['aaaaaa', 'bbbbbb'], ['aaaaaa', 'bbbbbb'])).toEqual([])
    expect(selectAll([], [])).toEqual([])
    expect(keepShown(['aaaaaa', 'cccccc'], ['aaaaaa'])).toEqual(['aaaaaa'])
  })
})

describe('bulk action payloads', () => {
  const PREVIEW = { ids: ['aaaaaa', 'bbbbbb'], keep: 'aaaaaa', category: 'projects' as const, token: 'a'.repeat(64) }

  it('asks for a merge of exactly the selected ids', () => {
    expect(mergePayload(['aaaaaa', 'bbbbbb'])).toEqual({ action: 'merge', ids: ['aaaaaa', 'bbbbbb'] })
  })

  it('applies a merge with the owner\'s text and category, and the preview\'s token', () => {
    expect(mergeApplyPayload(PREVIEW, 'one fact')).toEqual({
      action: 'merge', ids: ['aaaaaa', 'bbbbbb'], keep: 'aaaaaa', category: 'projects', text: 'one fact', confirm: 'a'.repeat(64),
    })
    expect(mergeApplyPayload(PREVIEW, 'one fact', 'identity')).toMatchObject({ category: 'identity' })
  })

  it('moves exactly the selected ids to the chosen category', () => {
    expect(reclassifyPayload(['aaaaaa', 'bbbbbb'], 'career')).toEqual({ action: 'reclassify', ids: ['aaaaaa', 'bbbbbb'], category: 'career' })
  })
})
