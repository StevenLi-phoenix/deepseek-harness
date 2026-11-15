/**
 * Reading the memory file for the owner's curation page: which entries say nearly the same thing, which look
 * like their subject is over, and what one merged entry would say. Everything here is a proposal: the page shows
 * it and nothing is written until the owner answers. The heuristics are deliberately conservative — a wrong
 * grouping costs the owner one click to reject, a wrong merge would not be offered at all — and they are pure
 * functions over plain entries, so the tests can pin them without a file.
 */

import { MAX_TEXT_CHARS, normalizeText, type MemoryCategory, type MemoryEntry } from './entries.ts'

/** How much of the smaller entry's tokens the larger must share before two entries count as one subject. */
export const SIMILARITY_THRESHOLD = 0.45

/** Tokens two entries must share outright, so a short line never pairs with a long one on a few common words. */
export const MIN_SHARED_TOKENS = 6

/** Entries one group may gather; past this a "duplicate" is a topic, not a copy. */
export const MAX_GROUP_SIZE = 5

/** A group of entries that say nearly the same thing. */
export interface DuplicateGroup {
  /** Members, the most complete first. */
  readonly members: readonly MemoryEntry[]
  /** The weakest link of the group, 0–1. */
  readonly score: number
}

/** One clause of an entry's text, and whether the rest of its group says anything like it. */
export interface TextPart {
  readonly text: string
  /** True when no other member of the group has a clause like this one. */
  readonly differs: boolean
}

/** Why an entry looks like its subject is over. */
export type StaleReason = 'expired-date' | 'finished-term'

/** An entry whose subject looks over, with the reason. */
export interface StaleEntry {
  readonly entry: MemoryEntry
  readonly reason: StaleReason
}

/** Filler words that never carry a subject on their own. */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'am',
  'with', 'by', 'as', 'it', 'its', 'this', 'that', 'i', 'my', 'me', 'you', 'your', 'he', 'his', 'she', 'her', 'they', 'their',
  'we', 'our', 'from', 'has', 'have', 'had', 'do', 'does', 'not', 'no', 'if', 'so', 'than', 'then', 'into', 'about', 'also',
  'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must', 'there', 'here', 'what', 'when', 'where', 'who', 'how',
])

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu
const WORD = /[\p{L}\p{N}]+/gu

/** A clause ends at a sentence stop or a semicolon; the stop stays with its clause, so the parts rebuild the text. */
const CLAUSE = /(?<=[；;。.!?！？\n])/u

/** Words that make an entry about a course, a term, or exam preparation. */
const COURSE_WORDS = new RegExp([
  'course', 'classes?', 'semester', 'syllabus', 'enrolled', 'enrol', 'register', 'exam', 'midterm', 'final',
  'prep', 'homework', 'problem set', 'pset', '作业', '课程', '学期', '选课', '上课', '考试', '复习', '期中', '期末',
].join('|'), 'iu')

/** Words that say a record is about something finished, which stays true after the term ends. */
const DONE_WORDS = /completed|finished|took\b|passed|done with|graduated|结束|已完成|考完|上完/iu

/** Words that make a date an expiry or a deadline rather than a fact. */
const DEADLINE_WORDS = /\b(expires?|expiry|expiration|deadline|due by|due on)\b|截止|到期|过期/iu

const ISO_DATE = /\b(20\d{2})-(\d{2})-(\d{2})\b/gu
const SLASH_DATE = /\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/gu
const TERM = /\b(spring|summer|fall|autumn|winter)\s+(\d{4})\b/giu
const CN_TERM = /(\d{4})\s*年\s*(春|夏|秋|冬)(?:季)?(?:学期)?/gu

/** Month a season's term ends in (0-based month index, exclusive end). */
const TERM_END = { spring: 5, summer: 7, fall: 11, winter: 1 } as const

/**
 * The tokens of a text: neighbouring CJK characters as pairs, and Latin-script words of two or more letters.
 * @param text - any text.
 * @returns lowercase opaque tokens; two entries share a token when they say the same word or pair.
 */
export function tokensOf(text: string): Set<string> {
  const folded = text.normalize('NFKC').toLowerCase()
  const tokens = new Set<string>()
  for (const run of folded.match(CJK_RUN) ?? []) {
    const chars = Array.from(run)
    for (let start = 0; start + 1 < chars.length; start += 1) tokens.add(`c:${chars[start]}${chars[start + 1]}`)
  }
  for (const segment of folded.replace(CJK_RUN, '\n').split(/[\n.!?;。！？；]+/u)) {
    for (const word of (segment.match(WORD) ?? []).filter(candidate => !STOPWORDS.has(candidate) && Array.from(candidate).length > 1)) {
      tokens.add(`w:${word}`)
    }
  }
  return tokens
}

/**
 * How much of the smaller token set the larger holds.
 * @param left - tokens of one text.
 * @param right - tokens of another.
 * @returns the shared count and the share of the smaller set; zero when either set is empty.
 */
export function overlapOf(left: ReadonlySet<string>, right: ReadonlySet<string>): { score: number; shared: number } {
  if (left.size === 0 || right.size === 0) return { score: 0, shared: 0 }
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  let shared = 0
  for (const token of small) if (large.has(token)) shared += 1
  return { score: shared / small.size, shared }
}

/**
 * Group entries that say nearly the same thing. Greedy and order-stable: each entry joins the group it is most
 * like, and a group stops at {@link MAX_GROUP_SIZE}.
 * @param entries - every entry, in file order.
 * @returns groups of two or more, largest first, and within a size the most similar first.
 */
export function groupDuplicates(entries: readonly MemoryEntry[]): DuplicateGroup[] {
  const tokens = new Map(entries.map(entry => [entry.id, tokensOf(entry.text)]))
  const groups: Array<{ members: MemoryEntry[]; scores: number[] }> = []
  for (const entry of entries) {
    let best: { group: (typeof groups)[number]; score: number } | undefined
    for (const group of groups) {
      if (group.members.length >= MAX_GROUP_SIZE) continue
      for (const member of group.members) {
        const overlap = overlapOf(tokens.get(entry.id) ?? new Set(), tokens.get(member.id) ?? new Set())
        if (overlap.shared < MIN_SHARED_TOKENS || overlap.score < SIMILARITY_THRESHOLD) continue
        if (best === undefined || overlap.score > best.score) best = { group, score: overlap.score }
      }
    }
    if (best === undefined) groups.push({ members: [entry], scores: [] })
    else {
      best.group.members.push(entry)
      best.group.scores.push(best.score)
    }
  }
  return groups
    .filter(group => group.members.length > 1)
    .map(group => ({
      members: group.members.toSorted((left, right) => right.text.length - left.text.length || left.id.localeCompare(right.id)),
      score: Math.min(...group.scores),
    }))
    .toSorted((left, right) => right.members.length - left.members.length || right.score - left.score || (left.members[0]?.id ?? '').localeCompare(right.members[0]?.id ?? ''))
}

/** The clauses of a text, each keeping its closing stop. */
function clausesOf(text: string): string[] {
  return text.split(CLAUSE).filter(clause => clause.trim().length > 0)
}

/**
 * The clauses of each member of a group, marking the ones no other member says anything like.
 * @param members - the group's entries.
 * @returns one entry's parts per id, in the members' order.
 */
export function textParts(members: readonly MemoryEntry[]): Map<string, TextPart[]> {
  const clauses = new Map(members.map(member => [member.id, clausesOf(member.text)]))
  const sets = new Map([...clauses].map(([id, parts]) => [id, parts.map(part => tokensOf(part))]))
  const parts = new Map<string, TextPart[]>()
  for (const member of members) {
    const mine = clauses.get(member.id) ?? []
    const others = members.filter(candidate => candidate.id !== member.id).flatMap(candidate => sets.get(candidate.id) ?? [])
    parts.set(member.id, mine.map((text, index) => {
      const tokens = sets.get(member.id)?.[index] ?? new Set<string>()
      const alike = others.some(other => overlapOf(tokens, other).score >= 0.7)
      return { text, differs: !alike }
    }))
  }
  return parts
}

/**
 * The text one merged entry would carry: the most complete member's text, then any clause of the others that
 * the base does not already say. Kept under the store's text limit; clauses are dropped, never cut mid-word,
 * when the limit is reached.
 * @param members - the entries to merge.
 * @returns the proposed text, normalised to one line.
 */
export function composeMergeText(members: readonly MemoryEntry[]): string {
  const ordered = members.toSorted((left, right) => right.text.length - left.text.length || left.id.localeCompare(right.id))
  const base = ordered[0]
  if (base === undefined) return ''
  const known = clausesOf(base.text).map(clause => tokensOf(clause))
  let merged = normalizeText(base.text)
  for (const member of ordered.slice(1)) {
    for (const clause of clausesOf(member.text)) {
      const tokens = tokensOf(clause)
      if (tokens.size < 3) continue
      if (known.some(other => overlapOf(tokens, other).score >= 0.8)) continue
      const text = normalizeText(clause)
      const joiner = /[；;。.!?！？]$/u.test(merged) ? '' : '；'
      const candidate = normalizeText(`${merged}${joiner}${text}`)
      if (candidate.length > MAX_TEXT_CHARS) continue
      merged = candidate
      known.push(tokens)
    }
  }
  return merged.length <= MAX_TEXT_CHARS ? merged : merged.slice(0, MAX_TEXT_CHARS)
}

/** The date a text writes, if it writes one this module understands. */
function datesOf(text: string): Date[] {
  const found: Date[] = []
  for (const match of text.matchAll(ISO_DATE)) found.push(new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`))
  for (const match of text.matchAll(SLASH_DATE)) {
    found.push(new Date(`${match[3]}-${String(match[1]).padStart(2, '0')}-${String(match[2]).padStart(2, '0')}T00:00:00Z`))
  }
  return found.filter(date => !Number.isNaN(date.getTime()))
}

/** A term a text names, if it names one. */
function termsOf(text: string): Array<{ season: keyof typeof TERM_END; year: number }> {
  const found: Array<{ season: keyof typeof TERM_END; year: number }> = []
  for (const match of text.matchAll(TERM)) {
    const season = match[1]?.toLowerCase()
    const year = Number(match[2])
    if (season === undefined || !Number.isInteger(year)) continue
    found.push({ season: season === 'autumn' ? 'fall' : season as keyof typeof TERM_END, year })
  }
  for (const match of text.matchAll(CN_TERM)) {
    const season = ({ 春: 'spring', 夏: 'summer', 秋: 'fall', 冬: 'winter' } as const)[match[2] as '春' | '夏' | '秋' | '冬']
    found.push({ season, year: Number(match[1]) })
  }
  return found
}

/**
 * The category most members carry; a tie goes to the member with the most text, which is the base of a merge.
 * @param members - the entries to merge.
 * @returns the category a merged entry would take.
 */
export function dominantCategory(members: readonly MemoryEntry[]): MemoryCategory {
  const counts = new Map<MemoryCategory, number>()
  for (const member of members) counts.set(member.category, (counts.get(member.category) ?? 0) + 1)
  const best = members.reduce((held, member) => {
    const score = counts.get(member.category) ?? 0
    const heldScore = counts.get(held.category) ?? 0
    if (score !== heldScore) return score > heldScore ? member : held
    return member.text.length > held.text.length ? member : held
  }, members[0] as MemoryEntry)
  return best?.category ?? 'instructions'
}

/**
 * Why an entry looks like its subject is over, or null.
 * @param entry - one entry.
 * @param now - the current instant.
 * @returns the reason, when the entry names an expiry that has passed or a term that ended.
 */
export function staleReason(entry: MemoryEntry, now: Date): StaleReason | null {
  if (DEADLINE_WORDS.test(entry.text)) {
    const expired = datesOf(entry.text).some(date => date.getTime() < now.getTime())
    if (expired) return 'expired-date'
  }
  if (!COURSE_WORDS.test(entry.text) || DONE_WORDS.test(entry.text)) return null
  for (const term of termsOf(entry.text)) {
    const end = new Date(Date.UTC(term.year, TERM_END[term.season] + 1, 0, 23, 59, 59))
    if (end.getTime() < now.getTime()) return 'finished-term'
  }
  return null
}

/**
 * The entries that look stale, oldest write first so the page lists them in a stable order.
 * @param entries - every entry.
 * @param now - the current instant.
 * @returns one item per stale entry.
 */
export function staleEntries(entries: readonly MemoryEntry[], now: Date): StaleEntry[] {
  const found: StaleEntry[] = []
  for (const entry of entries) {
    const reason = staleReason(entry, now)
    if (reason !== null) found.push({ entry, reason })
  }
  return found.toSorted((left, right) => left.entry.date.localeCompare(right.entry.date) || left.entry.id.localeCompare(right.entry.id))
}
