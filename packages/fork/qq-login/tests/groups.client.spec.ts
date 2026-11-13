import { describe, expect, it } from 'vitest'
import type { QqGroup } from '../src/view.ts'
import { candidateRows, parseGroupId, whitelistRows, withGroup, withoutGroup } from '../src/client/groups.ts'

const group = (groupId: string, name: string, recorded: boolean, seen: number): QqGroup => (
  { groupId, name, memberCount: null, recorded, seen }
)
const ALL = [group('111', 'B 群', true, 0), group('222', 'A 群', false, 5), group('333', 'C 群', false, 5), group('444', 'D 群', false, 9)]

describe('group list edits', () => {
  it('adds once and removes exactly, leaving the rest in order', () => {
    expect(withGroup(['111'], '222')).toEqual(['111', '222'])
    expect(withGroup(['111', '222'], '111')).toEqual(['111', '222'])
    expect(withoutGroup(['111', '222', '333'], '222')).toEqual(['111', '333'])
    expect(withoutGroup(['111'], '999')).toEqual(['111'])
  })

  it('does not mutate the list it was given', () => {
    const current = Object.freeze(['111'])
    expect(() => withGroup(current, '222')).not.toThrow()
    expect(() => withoutGroup(current, '111')).not.toThrow()
  })

  it('accepts only 3 to 20 digits, trimmed', () => {
    expect([' 123456789 ', '12', '123', 'abc123', '1'.repeat(20), '1'.repeat(21), '', '12 34'].map(parseGroupId)).toEqual([
      '123456789', null, '123', null, '1'.repeat(20), null, null, null,
    ])
  })
})

describe('group rows', () => {
  it('names the listed groups in list order, with the number for an unknown one', () => {
    expect(whitelistRows(['444', '999'], ALL).map(row => [row.groupId, row.name])).toEqual([['444', 'D 群'], ['999', '999']])
  })

  it('offers the groups not on the list, busiest first and then by name', () => {
    expect(candidateRows(['111'], ALL).map(row => row.groupId)).toEqual(['444', '222', '333'])
    expect(candidateRows(['111', '444'], ALL).map(row => row.groupId)).toEqual(['222', '333'])
  })
})
