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

/** Categories that shape how the agent behaves or what it knows about the owner; strangers' words must not reach them unconfirmed. */
export const PROTECTED_CATEGORIES: readonly MemoryCategory[] = ['instructions', 'preferences', 'identity']

/**
 * Whether a category is protected.
 * @param category - entry category.
 */
export function isProtected(category: MemoryCategory): boolean {
  return PROTECTED_CATEGORIES.includes(category)
}

/**
 * Where an entry came from: written in a turn the owner started (`owner-turn`), in a turn a
 * relayed message, an event, or a reminder started or one that read web or QQ text
 * (`tainted-turn`), approved by the owner afterwards (`owner-confirmed`), or loaded from an
 * export (`import`). An entry without a source predates this field and reads as legacy.
 */
export const SOURCES = ['owner-turn', 'tainted-turn', 'owner-confirmed', 'import'] as const

/** One entry source. */
export type MemorySource = typeof SOURCES[number]

/**
 * Whether a value names an entry source.
 * @param value - candidate source.
 */
export function isSource(value: unknown): value is MemorySource {
  return typeof value === 'string' && (SOURCES as readonly string[]).includes(value)
}

/** Longest `session` or `origin` label an entry keeps. */
export const MAX_LABEL_CHARS = 80

/** Who wrote a change, kept with the entry and in the history. */
export interface WriteMeta {
  readonly source?: MemorySource
  /** Id of the Session whose turn wrote it. */
  readonly session?: string
  /** The turn's origin label, e.g. `owner` or `peer:bili+web_fetch`. */
  readonly origin?: string
}

/** One stored memory. */
export interface MemoryEntry extends WriteMeta {
  /** Six lowercase hex digits, assigned by the store. */
  readonly id: string
  readonly category: MemoryCategory
  /** `YYYY-MM-DD` of the last write, in the Host's local time. */
  readonly date: string
  /** One line of text. */
  readonly text: string
}

/** A protected write waiting for the owner: shown in no prompt until the owner approves it. */
export interface PendingEntry extends MemoryEntry {
  /** `add` makes a new entry under this id; `replace` rewrites entry `target`. */
  readonly op: 'add' | 'replace'
  readonly target?: string
}

/** An entry before the store assigns its id. */
export type MemoryDraft = Omit<MemoryEntry, 'id' | 'session' | 'origin'>

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
  const { id, category, date, text, source, session, origin } = record
  if (!isEntryId(id) || !isCategory(category) || typeof date !== 'string' || !DATE.test(date)) return undefined
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT_CHARS || normalizeText(text) !== text) return undefined
  // Provenance is advisory: a field that does not parse reads as absent instead of making the file unreadable.
  return {
    id, category, date, text,
    ...isSource(source) ? { source } : {},
    ...typeof session === 'string' && session.length > 0 ? { session: session.slice(0, MAX_LABEL_CHARS) } : {},
    ...typeof origin === 'string' && origin.length > 0 ? { origin: origin.slice(0, MAX_LABEL_CHARS) } : {},
  }
}

/**
 * Validate one parsed pending record.
 * @param value - parsed JSON value.
 * @returns the pending entry, or undefined when malformed.
 */
export function pendingFrom(value: unknown): PendingEntry | undefined {
  const entry = entryFrom(value)
  if (entry === undefined) return undefined
  const { op, target } = value as Record<string, unknown>
  if (op !== 'add' && op !== 'replace') return undefined
  if (op === 'replace' && !isEntryId(target)) return undefined
  return { ...entry, op, ...op === 'replace' ? { target: target as string } : {} }
}
