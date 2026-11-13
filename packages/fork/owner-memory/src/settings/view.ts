/**
 * What the Memory settings route answers and accepts, shared by both halves as plain data. Entry text is the
 * owner's own memory; the browser renders it as text and never as markup.
 */

/** Memory categories, as `@deepseek-ai/dsh-owner-memory` defines them (a test keeps the two lists equal). */
export const CATEGORIES = ['instructions', 'preferences', 'identity', 'career', 'projects'] as const
/** One memory category. */
export type Category = typeof CATEGORIES[number]

/** Where an entry came from; `legacy` is an entry written before the store recorded sources. */
export type EntrySource = 'owner-turn' | 'tainted-turn' | 'owner-confirmed' | 'import' | 'legacy'

/** Absolute Host registration path of the route. */
export const MEMORY_PATH = '/api/owner-memory'
/** Document-relative form the browser fetches. */
export const MEMORY_ROUTE = MEMORY_PATH.slice(1)

/** Document-relative route of the content guard's overview (`@deepseek-ai/dsh-content-guard/settings`). */
export const GUARD_ROUTE = 'api/content-guard'

/** The guard's counts for the last 24 hours; rule names and numbers only, never a text. */
export interface GuardOverview {
  readonly checked: number
  readonly rejected: number
  readonly byRule: Readonly<Record<string, number>>
  /** The latest failure of a layer (a model call, the canary file, the memory file). */
  readonly lastError: { readonly at: number; readonly rule: string; readonly message: string } | null
  readonly lastCheckAt: number | null
}

/** Entries the list shows per page. */
export const PAGE_SIZE = 20
/** Most entries one page may hold. */
export const MAX_PAGE_SIZE = 100
/** Characters of an entry's text the list shows before "show more". */
export const CLIP_CHARS = 240
/** Most ids one action may carry. */
export const MAX_IDS = 50

/** One stored entry. */
export interface EntryView {
  readonly id: string
  readonly category: Category
  /** Date of the last write. */
  readonly date: string
  /** The text, clipped to {@link CLIP_CHARS} in lists. */
  readonly text: string
  /** Whether `text` is clipped; the detail answer has it in full. */
  readonly clipped: boolean
  readonly source: EntrySource
  /** Id of the Session whose turn wrote it. */
  readonly session?: string
  /** Label of the turn's origin, such as `owner` or `peer:bili+web_fetch`. */
  readonly origin?: string
  /** Whether the category is protected (instructions, preferences, identity). */
  readonly protected: boolean
  /** Whether the latest change can be undone. */
  readonly revertible: boolean
}

/** A protected write waiting for the owner. */
export interface PendingView {
  readonly id: string
  readonly op: 'add' | 'replace'
  /** For a replace, the entry it would rewrite. */
  readonly target?: string
  /** The text of that entry now, clipped. */
  readonly replaces?: string
  readonly category: Category
  readonly date: string
  /** The proposed text, in full: the owner decides on all of it. */
  readonly text: string
  readonly source: EntrySource
  readonly session?: string
  readonly origin?: string
  /** True when the turn was not the owner's alone (a relayed message, an event, a reminder, or web text). */
  readonly tainted: boolean
  /** The day the write is dropped when nobody answers. */
  readonly expiresOn: string
}

/** A Session whose turns changed memory, for the rollback picker. */
export interface SessionView {
  readonly id: string
  /** History records it wrote. */
  readonly changes: number
  /** Entries those records touched. */
  readonly entries: number
  readonly firstAt: string
  readonly lastAt: string
  readonly origin?: string
}

/** One owner verdict on a persona reply. */
export interface FeedbackView {
  readonly id: string
  readonly scope: 'up' | 'bili'
  readonly verdict: 'keep' | 'delete'
  readonly kind: 'comment' | 'dm'
  readonly text: string
  readonly ref?: string
  readonly note?: string
  readonly at: string
}

/** What the list asks for. */
export interface MemoryQuery {
  /** Whitespace-separated terms; an entry must contain all of them (or have the id). */
  readonly q: string
  readonly category: Category | 'all'
  readonly offset: number
  readonly limit: number
}

/** Body of `GET api/owner-memory`. */
export interface MemoryView {
  /** Epoch milliseconds the Host built it. */
  readonly generatedAt: number
  readonly query: MemoryQuery
  /** Entries in the file, whatever the query. */
  readonly total: number
  readonly counts: Readonly<Record<Category, number>>
  /** Waiting writes, oldest first. */
  readonly pending: readonly PendingView[]
  readonly entries: { readonly items: readonly EntryView[]; readonly matched: number }
  /** Sessions that changed memory, newest first. */
  readonly sessions: readonly SessionView[]
  readonly feedback: readonly FeedbackView[]
}

/** One history line of an entry. */
export interface HistoryView {
  readonly at: string
  readonly op: string
  readonly session?: string
  readonly origin?: string
  readonly source?: EntrySource
  /** The text before the change; absent for an add. */
  readonly before?: string
  /** The text after; absent for a removal. */
  readonly after?: string
}

/** Body of `GET api/owner-memory?id=<id>`. */
export interface DetailView {
  /** The entry (text in full), or the waiting write when `waiting` is set. */
  readonly entry: EntryView
  readonly waiting: boolean
  /** Newest first. */
  readonly history: readonly HistoryView[]
}

/** Why one id of a batch was not handled. */
export interface ItemFailure {
  readonly code: string
  readonly message: string
}

/** The result for one id of `approve`, `discard`, and `revert`. */
export interface ItemResult {
  readonly id: string
  readonly ok: boolean
  /** `kept`, `dropped`, `removed`, or `restored` on success. */
  readonly outcome?: string
  readonly failure?: ItemFailure
}

/** What a rollback would do to one entry. */
export interface RollbackPreviewItem {
  readonly id: string
  readonly change: 'remove' | 'restore' | 'revise' | 'none'
  readonly category?: Category
  /** The text now, clipped. */
  readonly now?: string
  /** The text after the rollback, clipped. */
  readonly then?: string
}

/** What erasing one entry would remove. */
export interface PurgePreviewItem {
  readonly id: string
  /** False when no entry has this id (only traces, or nothing). */
  readonly found: boolean
  readonly category?: Category
  readonly text?: string
  readonly history: number
  readonly snapshots: number
  readonly pending: number
}

/** An action's answer. */
export type ActionResult =
  | { readonly action: 'approve' | 'discard' | 'revert'; readonly results: readonly ItemResult[] }
  | {
    readonly action: 'rollback'
    readonly stage: 'preview'
    readonly matched: number
    readonly restored: number
    readonly removed: number
    readonly items: readonly RollbackPreviewItem[]
    /** Send it back as `confirm` to apply exactly this. */
    readonly token: string
  }
  | { readonly action: 'rollback'; readonly stage: 'done'; readonly matched: number; readonly restored: number; readonly removed: number }
  | { readonly action: 'forget'; readonly stage: 'preview'; readonly items: readonly PurgePreviewItem[]; readonly token: string }
  | { readonly action: 'forget'; readonly stage: 'done'; readonly items: readonly PurgePreviewItem[] }
  | { readonly action: 'feedback.add'; readonly outcome: 'added' | 'replaced'; readonly id: string }
  | { readonly action: 'feedback.forget'; readonly id: string }

/** What the browser posts. */
export type MemoryAction =
  | { action: 'approve' | 'discard' | 'revert'; ids: string[] }
  | { action: 'rollback'; session?: string; since?: string; confirm?: string }
  | { action: 'forget'; ids: string[]; confirm?: string }
  | { action: 'feedback.add'; scope: 'up' | 'bili'; verdict: 'keep' | 'delete'; kind: 'comment' | 'dm'; text: string; ref?: string; note?: string }
  | { action: 'feedback.forget'; id: string }
