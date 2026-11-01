/**
 * The samples, runs, and trend as the style service hands them to the Settings section (lsy-style-settings, which
 * declares the same fields for its browser half).
 */

/**
 * The platform every stored item came from: the recorded QQ groups or public Bilibili text. Nothing else can be a
 * source: no WeChat, no owner memory, no Session of the owner's.
 */
export const SAMPLE_SOURCES = ['qq', 'bili'] as const
/** One of {@link SAMPLE_SOURCES}. */
export type SampleSource = typeof SAMPLE_SOURCES[number]

/** Where a meme or trait was read: a sample's platforms, or `web` (a page the main agent searched or fetched). */
export const NOTE_SOURCES = ['qq', 'bili', 'web'] as const
/** One of {@link NOTE_SOURCES}. */
export type NoteSource = typeof NOTE_SOURCES[number]

/** How widely an item was seen, as counts only: no group number, member id, or name is kept with it. */
export interface Origin {
  readonly platform: SampleSource
  /** Distinct groups (QQ) or comment threads (Bilibili). */
  readonly groups: number
  /** Distinct speakers. */
  readonly speakers: number
  /** Distinct calendar days. */
  readonly days: number
}

/**
 * A sample's state. `active`: shown to the main agent. `pending`: waits for the owner (review `required`). `removed`:
 * the owner deleted it; only the id is kept, so it never comes back. `retired`: pushed out by newer samples or by age;
 * only the id is kept.
 */
export const SAMPLE_STATUSES = ['active', 'pending', 'removed', 'retired'] as const
/** One of {@link SAMPLE_STATUSES}. */
export type SampleStatus = typeof SAMPLE_STATUSES[number]

/** A sample as the page shows it. */
export interface SampleView {
  readonly id: string
  readonly source: SampleSource
  /** A reply the owner's public Bilibili account (猫灯) wrote by hand: tone only, pinned first. */
  readonly owner: boolean
  readonly status: 'active' | 'pending'
  /** ISO time it entered the store. */
  readonly addedAt: string
  /** What the other person said; absent for a single line a digest Session proposed. */
  readonly prompt?: string
  readonly reply: string
  readonly origin: Origin
}

/** A meme or a trait as the page shows it. */
export interface NoteView {
  readonly id: string
  readonly kind: 'meme' | 'trait'
  readonly term: string
  readonly meaning?: string
  readonly example: string
  readonly source: NoteSource
  /** Other terms of the same meme family. */
  readonly related?: readonly string[]
  /** Where the meaning came from: `agent`, `hotwatch`, `web` (pages the main agent read), `search`, or `llm` (a model's draft). */
  readonly meaningSource?: 'agent' | 'hotwatch' | 'web' | 'search' | 'llm'
  readonly firstSeen: number
  readonly lastSeen: number
}

/** One version of the persona card. */
export interface CardView {
  readonly version: number
  readonly card: string
  readonly author: 'agent' | 'owner'
  readonly reason: string
  readonly at: number
}

/** One collection run, as counts. */
export interface RunReport {
  /** Epoch milliseconds of the start. */
  readonly at: number
  readonly ms: number
  readonly trigger: 'schedule' | 'manual'
  readonly qq: { readonly status: 'ok' | 'off' | 'unavailable'; readonly groups: number; readonly messages: number }
  readonly bili: { readonly status: 'ok' | 'off' | 'unavailable' | 'no-token'; readonly comments: number; readonly threads: number; readonly error?: string }
  /** Candidate exchanges looked at. */
  readonly seen: number
  /** Exchanges that passed every filter. */
  readonly accepted: number
  /** New samples stored (active, or pending under review `required`). */
  readonly added: number
  /** Samples pushed out by the caps or by age in this run. */
  readonly retired: number
  /** Exchanges left out, by reason. */
  readonly filtered: Readonly<Record<string, number>>
  /** New samples by source. */
  readonly bySource: Readonly<Record<string, number>>
}

/** One run of the meme miner, as counts. */
export interface MineReport {
  /** Epoch milliseconds of the start. */
  readonly at: number
  readonly ms: number
  /** Inputs that reached the model, by kind, and those dropped by the personal-information filter. */
  readonly inputs: { readonly qq: number; readonly comment: number; readonly hot: number; readonly web: number; readonly dropped: number }
  /** Memes already stored whose term appeared again. */
  readonly touched: number
  /** Memes the model proposed. */
  readonly candidates: number
  /** New memes stored. */
  readonly kept: number
  /** Proposals refused, by rule. */
  readonly rejected: Readonly<Record<string, number>>
  readonly llmCalls: number
  readonly searches: number
  /** Why the run did nothing, when it did nothing. */
  readonly skipped?: string
}

/** One day of the persona's forbidden stock lines (from lsy-integrity) and of the main agent's answer lengths. */
export interface TrendDay {
  /** `YYYY-MM-DD` (UTC for the stock lines, as lsy-integrity counts them). */
  readonly day: string
  /** Answers checked for stock lines (unattended and bili presets together). */
  readonly answers: number
  /** Answers holding at least one stock line. */
  readonly withTics: number
  /** Answers of the main agent (the `unattended` preset) and their mean length in characters; null without answers. */
  readonly mainAnswers: number
  readonly meanChars: number | null
}

/** Everything the Settings section shows. */
export interface StylePanel {
  /** The whole package; `false` in the configuration turns collection, notes, and the block off. */
  readonly enabled: boolean
  /** The parts, each with its own switch. */
  readonly parts: {
    readonly tone: boolean
    readonly memes: boolean
    readonly traits: boolean
    readonly persona: boolean
    readonly miner: boolean
  }
  readonly review: 'optional' | 'required'
  readonly limits: {
    readonly maxActive: number
    readonly maxOwner: number
    readonly maxMemes: number
    readonly maxTraits: number
    readonly cardChars: number
  }
  readonly samples: readonly SampleView[]
  /** Memes and traits, most recently seen first. */
  readonly notes: readonly NoteView[]
  /** HotWatch's trending memes in the index (empty when it is off or unreachable). */
  readonly hot: ReadonlyArray<{ readonly title: string; readonly heat: number }>
  /** Card versions, oldest first; the last is current, and an empty card means none. */
  readonly cards: readonly CardView[]
  readonly running: boolean
  readonly lastRun: RunReport | null
  /** The meme miner's last run; null before the first. */
  readonly lastMine: MineReport | null
  /** Epoch milliseconds of the next scheduled run; null while collection is off. */
  readonly nextRunAt: number | null
  /** Newest last, at most 14 days. */
  readonly trend: readonly TrendDay[]
}

/** One edit by the owner. */
export type StyleEdit =
  | { readonly op: 'remove' | 'keep'; readonly id: string }
  | { readonly op: 'block'; readonly term: string }
  | { readonly op: 'card'; readonly card: string }
  | { readonly op: 'rollback'; readonly version: number }
  | { readonly op: 'deleteVersion'; readonly version: number }

/** What an edit answers: the new panel, or why it was refused. */
export type StyleEditAnswer =
  | { readonly ok: true; readonly panel: StylePanel }
  | { readonly ok: false; readonly error: string; readonly panel: StylePanel }
