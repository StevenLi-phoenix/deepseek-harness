import { describe, expect, it } from 'vitest'
import {
  composeMergeText, dominantCategory, groupDuplicates, overlapOf, staleEntries, staleReason, textParts, tokensOf,
} from '../src/curation.ts'
import { MAX_TEXT_CHARS, type MemoryCategory, type MemoryEntry } from '../src/entries.ts'

/** A stable six-hex id for a text. */
function idOf(text: string): string {
  let hash = 0
  for (const char of text) hash = (hash * 31 + char.codePointAt(0)!) % 0x1000000
  return hash.toString(16).padStart(6, '0')
}

/** One entry, identified by its text unless a test needs a given id. */
function entry(text: string, category: MemoryCategory = 'projects', date = '2026-10-01', id?: string): MemoryEntry {
  return { id: id ?? idOf(text), category, date, text }
}

const NOW = new Date('2026-11-15T12:00:00-05:00')

const COURSE_A = 'CS-UY 4523 Design Project meets on Tuesdays with Professor Smith; the final presentation is a poster session'
const COURSE_B = 'CS-UY 4523 Design Project meets on Tuesdays with Professor Smith; the final presentation is a demo'

describe('tokensOf', () => {
  it('reads CJK runs as character pairs and Latin words as themselves, without filler words', () => {
    const tokens = tokensOf('他在用 Claude Code 开发，the CI alerts')
    expect(tokens.has('c:他在')).toBe(true)
    expect(tokens.has('c:在用')).toBe(true)
    expect(tokens.has('w:claude')).toBe(true)
    expect(tokens.has('w:code')).toBe(true)
    expect(tokens.has('w:the')).toBe(false)
    expect(tokens.has('w:ci')).toBe(true)
    expect(tokensOf('a an the of').size).toBe(0)
  })
})

describe('overlapOf', () => {
  it('scores the share of the smaller set, and survives an empty side', () => {
    const overlap = overlapOf(tokensOf(COURSE_A), tokensOf(COURSE_B))
    expect(overlap.shared).toBeGreaterThanOrEqual(10)
    expect(overlap.score).toBeGreaterThan(0.85)
    expect(overlapOf(new Set(), tokensOf(COURSE_A))).toEqual({ score: 0, shared: 0 })
    expect(overlapOf(new Set(['a', 'b']), new Set(['a', 'b', 'c']))).toEqual({ score: 1, shared: 2 })
  })
})

describe('groupDuplicates', () => {
  it('groups two entries that say the same thing, most complete first, and ignores unrelated ones', () => {
    const groups = groupDuplicates([
      entry(COURSE_A, 'projects', '2026-09-01', 'aaaaaa'),
      entry('Roommate Alice likes jazz and plays the trumpet on weekends', 'identity', '2026-09-02', 'bbbbbb'),
      entry(COURSE_A, 'identity', '2026-10-01', 'cccccc'),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.members.map(member => member.id)).toEqual(['aaaaaa', 'cccccc'])
    expect(groups[0]?.score).toBe(1)
  })

  it('needs a real share of the smaller entry, not a few shared words', () => {
    const shared = 'alpha bravo charlie delta echo foxtrot'
    const long = (unique: string): string => `${shared} ${unique}`
    // Six shared tokens of fourteen: a real overlap, but not the same fact.
    const left = long('x1 x2 x3 x4 x5 x6 x7 x8')
    const right = long('y1 y2 y3 y4 y5 y6 y7 y8')
    expect(groupDuplicates([entry(left), entry(right)])).toHaveLength(0)
  })

  it('stops a group at five entries and lists the largest group first', () => {
    const six = Array.from({ length: 6 }, (_, index) => entry(`${COURSE_A} note${index}`, 'projects', '2026-10-01', `a${String(index).repeat(5)}`))
    const pair = [entry('the espresso machine descales every third Sunday morning', 'preferences', '2026-10-01', 'ffffff'),
      entry('the espresso machine descales every third Sunday morning', 'preferences', '2026-10-02', 'eeeeee')]
    const groups = groupDuplicates([...six, ...pair])
    expect(groups.map(group => group.members.length)).toEqual([5, 2])
  })

  it('never groups a single entry, and keeps the input order inside one', () => {
    expect(groupDuplicates([entry(COURSE_A)])).toEqual([])
    expect(groupDuplicates([])).toEqual([])
  })
})

describe('textParts', () => {
  it('marks the clause only one member says', () => {
    const parts = textParts([entry(COURSE_A, 'projects', '2026-10-01', 'aaaaaa'), entry(COURSE_B, 'projects', '2026-10-01', 'bbbbbb')])
    const first = parts.get('aaaaaa') ?? []
    const second = parts.get('bbbbbb') ?? []
    expect(first.map(part => part.text)).toEqual([
      'CS-UY 4523 Design Project meets on Tuesdays with Professor Smith;',
      ' the final presentation is a poster session',
    ])
    expect(first.map(part => part.differs)).toEqual([false, true])
    expect(second.map(part => part.differs)).toEqual([false, true])
    expect(first.map(part => part.text).join('')).toBe(COURSE_A)
  })
})

describe('composeMergeText', () => {
  it('keeps the most complete text and appends only what the others add', () => {
    const long = entry(`${COURSE_A}. Professor Smith holds office hours on Wednesdays`, 'projects', '2026-10-01', 'aaaaaa')
    const short = entry(COURSE_A, 'projects', '2026-10-01', 'bbbbbb')
    const extra = entry('the poster session is graded by two TAs', 'projects', '2026-10-01', 'cccccc')
    const merged = composeMergeText([short, long, extra])
    expect(merged).toContain('office hours on Wednesdays')
    expect(merged).toContain('the poster session is graded by two TAs')
    expect(merged.length).toBeLessThanOrEqual(MAX_TEXT_CHARS)
    expect(composeMergeText([])).toBe('')
  })

  it('drops clauses that would take the text past the limit instead of cutting it', () => {
    const base = 'a'.repeat(MAX_TEXT_CHARS - 30)
    const merged = composeMergeText([
      { id: 'aaaaaa', category: 'projects', date: '2026-10-01', text: base },
      { id: 'bbbbbb', category: 'projects', date: '2026-10-01', text: 'and one more clause that does not fit here' },
    ])
    expect(merged.length).toBeLessThanOrEqual(MAX_TEXT_CHARS)
    expect(merged.endsWith('does not fit')).toBe(false)
  })
})

describe('dominantCategory', () => {
  it('picks the most common category and lets the longest entry break a tie', () => {
    expect(dominantCategory([
      entry('one', 'identity'), entry('two', 'career'), entry('three', 'career'),
    ])).toBe('career')
    expect(dominantCategory([
      entry('short', 'identity'), entry('a much longer text about the same person', 'career'),
    ])).toBe('career')
    expect(dominantCategory([])).toBe('instructions')
  })
})

describe('staleReason', () => {
  it('flags an expiry that has passed and leaves a future one alone', () => {
    expect(staleReason(entry('Lease: current lease expires 2026-09-06; renew by 2026-07-27', 'identity'), NOW)).toBe('expired-date')
    expect(staleReason(entry('Subscription expires 2027-01-05', 'preferences'), NOW)).toBeNull()
    expect(staleReason(entry('Renewal was due on 07/27/2026', 'identity'), NOW)).toBe('expired-date')
  })

  it('flags a course from a term that ended, but not a finished record or a current term', () => {
    expect(staleReason(entry('MATH-UA 140 Linear Algebra (Spring 2026): final exam prep', 'identity'), NOW)).toBe('finished-term')
    expect(staleReason(entry('2025年秋季学期选课：网络安全', 'identity'), NOW)).toBe('finished-term')
    expect(staleReason(entry('Completed Spring 2026 finals in PH-UY 2023', 'identity'), NOW)).toBeNull()
    expect(staleReason(entry('Fall 2026 course rooms: CS-UY 4523 in Jacobs 203', 'identity'), NOW)).toBeNull()
    expect(staleReason(entry('Roommate Alice likes jazz', 'identity'), NOW)).toBeNull()
  })

  it('lists stale entries in a stable order', () => {
    const stale = staleEntries([
      entry('MATH-UA 140 (Spring 2026): final exam prep', 'identity', '2026-10-02', 'bbbbbb'),
      entry('Lease expires 2026-09-06', 'identity', '2026-09-01', 'aaaaaa'),
      entry('Roommate Alice likes jazz', 'identity', '2026-09-01', 'cccccc'),
    ], NOW)
    expect(stale.map(item => item.entry.id)).toEqual(['aaaaaa', 'bbbbbb'])
    expect(stale.map(item => item.reason)).toEqual(['expired-date', 'finished-term'])
  })
})
