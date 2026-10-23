/**
 * Memory entries: one dated fact about the owner in one of five categories, the
 * shape claude.ai's memory export uses, so an export imports without rewriting.
 */

/** Categories in context order. */
export const CATEGORIES = ['instructions', 'preferences', 'identity', 'career', 'projects'] as const

/** One memory category. */
export type MemoryCategory = typeof CATEGORIES[number]

/**
 * How the context block shows each category: `full` text, `opening` words only, or
 * just a `count`. Identity entries (people, family, accounts) stay out of every request
 * until a search asks for them.
 */
export const CATEGORY_DISPLAY: Readonly<Record<MemoryCategory, 'full' | 'opening' | 'count'>> = {
  instructions: 'full',
  preferences: 'full',
  identity: 'count',
  career: 'opening',
  projects: 'opening',
}

/** One stored memory. */
export interface MemoryEntry {
  /** Six lowercase hex digits, assigned by the store. */
  readonly id: string
  readonly category: MemoryCategory
  /** `YYYY-MM-DD` of the last write, in the Host's local time. */
  readonly date: string
  /** One line of text. */
  readonly text: string
}

/** An entry before the store assigns its id. */
export type MemoryDraft = Omit<MemoryEntry, 'id'>

/** Longest entry text, in UTF-16 code units. */
export const MAX_TEXT_CHARS = 2000

const ID = /^[0-9a-f]{6}$/u
const DATE = /^\d{4}-\d{2}-\d{2}$/u

/**
 * Whether a value names a category.
 * @param value - candidate category.
 */
export function isCategory(value: unknown): value is MemoryCategory {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value)
}

/**
 * Whether a value is a store id.
 * @param value - candidate id.
 */
export function isEntryId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value)
}

/**
 * Collapse whitespace (newlines included) to single spaces and trim, so every entry stays one line.
 * @param text - raw entry text.
 */
export function normalizeText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * Validate one parsed JSONL record.
 * @param value - parsed JSON value.
 * @returns the entry, or undefined when any field is missing or malformed.
 */
export function entryFrom(value: unknown): MemoryEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const { id, category, date, text } = record
  if (!isEntryId(id) || !isCategory(category) || typeof date !== 'string' || !DATE.test(date)) return undefined
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT_CHARS || normalizeText(text) !== text) return undefined
  return { id, category, date, text }
}
