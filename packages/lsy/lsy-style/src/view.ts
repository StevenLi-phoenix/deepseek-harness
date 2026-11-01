/**
 * What the Host style route answers, shared by both halves as types and constants only (no Node imports: the browser
 * half reads this file too).
 */

/** Absolute Host registration paths: the panel (GET), the owner's edits (POST), and a collection run on demand (POST). */
export const STYLE_PATH = '/api/lsy.style'
export const STYLE_EDIT_PATH = '/api/lsy.style.edit'
export const STYLE_COLLECT_PATH = '/api/lsy.style.collect'
/** Document-relative forms the browser fetches. */
export const STYLE_ROUTE = STYLE_PATH.slice(1)
export const STYLE_EDIT_ROUTE = STYLE_EDIT_PATH.slice(1)
export const STYLE_COLLECT_ROUTE = STYLE_COLLECT_PATH.slice(1)

/**
 * Where a sample came from. `qq-group`: a QQ group member's message and another member's reply. `bili-viewer`: a
 * comment and a reply under the owner's videos, neither written by the owner. `owner-bili`: a reply the owner's
 * public account wrote by hand. `owner-manual`: a line the owner typed on the Settings page.
 */
export const SAMPLE_SOURCES = ['qq-group', 'bili-viewer', 'owner-bili', 'owner-manual'] as const
export type SampleSource = typeof SAMPLE_SOURCES[number]

/**
 * A sample's state. `active`: shown to the main agent. `pending`: waits for the owner (review `required`). `removed`:
 * the owner deleted it; only the id is kept, so it never comes back. `retired`: pushed out by newer samples or by age;
 * only the id is kept.
 */
export const SAMPLE_STATUSES = ['active', 'pending', 'removed', 'retired'] as const
export type SampleStatus = typeof SAMPLE_STATUSES[number]

/** Whether a source is the owner's own words. */
export function isOwnerSource(source: SampleSource): boolean {
  return source === 'owner-bili' || source === 'owner-manual'
}

/** A sample as the page shows it. */
export interface SampleView {
  readonly id: string
  readonly source: SampleSource
  readonly status: 'active' | 'pending'
  /** ISO time it entered the store. */
  readonly addedAt: string
  /** What the other person said; absent for a lone line the owner typed. */
  readonly prompt?: string
  readonly reply: string
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

/** What `GET /api/lsy.style` answers. */
export interface StylePanel {
  /** The block reaches the main agent; `false` in the configuration turns it off. */
  readonly enabled: boolean
  readonly review: 'optional' | 'required'
  readonly limits: { readonly maxActive: number; readonly maxOwner: number; readonly maxChars: number }
  readonly samples: readonly SampleView[]
  readonly running: boolean
  readonly lastRun: RunReport | null
  /** Epoch milliseconds of the next scheduled run; null while collection is off. */
  readonly nextRunAt: number | null
  /** Newest last, at most 14 days. */
  readonly trend: readonly TrendDay[]
}

/** What `POST /api/lsy.style.edit` takes. */
export type StyleEdit =
  | { readonly op: 'remove'; readonly id: string }
  | { readonly op: 'keep'; readonly id: string }
  | { readonly op: 'add'; readonly prompt?: string; readonly reply: string }

/** What an edit answers: the new panel, or why it was refused. */
export type StyleEditAnswer =
  | { readonly ok: true; readonly panel: StylePanel }
  | { readonly ok: false; readonly error: string; readonly panel: StylePanel }
