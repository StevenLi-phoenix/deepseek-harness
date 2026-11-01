/**
 * What the Host style routes answer, shared by both halves as types and constants only (no Node imports: the browser
 * half reads this file too). The fields are lsy-style's `StylePanel`; the Host half checks at compile time that the
 * service's answer fits them.
 */

/** Absolute Host registration paths: the panel (GET), the owner's edits (POST), and a collection run on demand (POST). */
export const STYLE_PATH = '/api/lsy.style'
export const STYLE_EDIT_PATH = '/api/lsy.style.edit'
export const STYLE_COLLECT_PATH = '/api/lsy.style.collect'
/** Document-relative forms the browser fetches. */
export const STYLE_ROUTE = STYLE_PATH.slice(1)
export const STYLE_EDIT_ROUTE = STYLE_EDIT_PATH.slice(1)
export const STYLE_COLLECT_ROUTE = STYLE_COLLECT_PATH.slice(1)

/** How widely an item was seen, as counts: the platform (QQ or Bilibili only), groups or threads, speakers, days. */
export interface Origin {
  readonly platform: 'qq' | 'bili'
  readonly groups: number
  readonly speakers: number
  readonly days: number
}

/** A tone sample on the page; `owner` marks a reply the owner's Bilibili account wrote by hand. */
export interface SampleView {
  readonly id: string
  readonly source: 'qq' | 'bili'
  readonly owner: boolean
  readonly status: 'active' | 'pending'
  readonly addedAt: string
  readonly prompt?: string
  readonly reply: string
  readonly origin: Origin
}

/** A meme or a trait of the groups' tone on the page. */
export interface NoteView {
  readonly id: string
  readonly kind: 'meme' | 'trait'
  readonly term: string
  readonly meaning?: string
  readonly example: string
  /** Where it was read: a QQ group, Bilibili text, or a web page the main agent searched or fetched. */
  readonly source: 'qq' | 'bili' | 'web'
  /** Other terms of the same meme family. */
  readonly related?: readonly string[]
  /** Where the meaning came from; absent for a trait and for older notes. */
  readonly meaningSource?: 'agent' | 'hotwatch' | 'web' | 'search' | 'llm'
  readonly firstSeen: number
  readonly lastSeen: number
}

/** One version of the persona card; an empty card means it was deleted. */
export interface CardView {
  readonly version: number
  readonly card: string
  readonly author: 'agent' | 'owner'
  readonly reason: string
  readonly at: number
}

/** The last collection run, as counts. */
export interface RunReport {
  readonly at: number
  readonly ms: number
  readonly trigger: 'schedule' | 'manual'
  readonly qq: { readonly status: 'ok' | 'off' | 'unavailable'; readonly groups: number; readonly messages: number }
  readonly bili: { readonly status: 'ok' | 'off' | 'unavailable' | 'no-token'; readonly comments: number; readonly threads: number; readonly error?: string }
  readonly seen: number
  readonly accepted: number
  readonly added: number
  readonly retired: number
  /** Exchanges left out, by filter reason. */
  readonly filtered: Readonly<Record<string, number>>
  readonly bySource: Readonly<Record<string, number>>
}

/** The last meme-mining run, as counts. */
export interface MineReport {
  readonly at: number
  readonly ms: number
  readonly inputs: { readonly qq: number; readonly comment: number; readonly hot: number; readonly web: number; readonly dropped: number }
  readonly touched: number
  readonly candidates: number
  readonly kept: number
  /** Proposals refused, by rule. */
  readonly rejected: Readonly<Record<string, number>>
  readonly llmCalls: number
  readonly searches: number
  /** Why the run did nothing, when it did nothing. */
  readonly skipped?: string
}

/** One day: answers with the persona's stock lines (lsy-integrity), and the main agent's mean answer length. */
export interface TrendDay {
  readonly day: string
  readonly answers: number
  readonly withTics: number
  readonly mainAnswers: number
  readonly meanChars: number | null
}

/** What `GET /api/lsy.style` answers. */
export interface StylePanel {
  readonly enabled: boolean
  readonly review: 'optional' | 'required'
  readonly parts: {
    readonly tone: boolean
    readonly memes: boolean
    readonly traits: boolean
    readonly persona: boolean
    readonly miner: boolean
  }
  readonly limits: {
    readonly maxActive: number
    readonly maxOwner: number
    readonly maxMemes: number
    readonly maxTraits: number
    readonly cardChars: number
  }
  readonly samples: readonly SampleView[]
  readonly notes: readonly NoteView[]
  readonly hot: ReadonlyArray<{ readonly title: string; readonly heat: number }>
  /** Oldest first; the last is current. */
  readonly cards: readonly CardView[]
  readonly running: boolean
  readonly lastRun: RunReport | null
  readonly lastMine: MineReport | null
  readonly nextRunAt: number | null
  readonly trend: readonly TrendDay[]
}

/** What `POST /api/lsy.style.edit` takes. */
export type StyleEdit =
  | { readonly op: 'remove' | 'keep'; readonly id: string }
  | { readonly op: 'block'; readonly term: string }
  | { readonly op: 'card'; readonly card: string }
  | { readonly op: 'rollback'; readonly version: number }
  | { readonly op: 'deleteVersion'; readonly version: number }

/** What an edit answers: the panel after it, and why it was refused when it was. */
export type StyleEditAnswer =
  | { readonly ok: true; readonly panel: StylePanel }
  | { readonly ok: false; readonly error: string; readonly panel: StylePanel }
