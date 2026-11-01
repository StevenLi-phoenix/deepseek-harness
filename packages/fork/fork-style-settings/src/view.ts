/**
 * What the Host style routes answer, shared by both halves as types and constants only (no Node imports: the browser
 * half reads this file too). The fields are fork-style's `StylePanel`; the Host half checks at compile time that the
 * service's answer fits them.
 */

/** Absolute Host registration paths: the panel (GET), the owner's edits (POST), and a collection run on demand (POST). */
export const STYLE_PATH = '/api/fork.style'
export const STYLE_EDIT_PATH = '/api/fork.style.edit'
export const STYLE_COLLECT_PATH = '/api/fork.style.collect'
/** Document-relative forms the browser fetches. */
export const STYLE_ROUTE = STYLE_PATH.slice(1)
export const STYLE_EDIT_ROUTE = STYLE_EDIT_PATH.slice(1)
export const STYLE_COLLECT_ROUTE = STYLE_COLLECT_PATH.slice(1)

/** A sample on the page: who it came from (`owner-*` are the owner's own words), and whether it waits for review. */
export interface SampleView {
  readonly id: string
  readonly source: 'qq-group' | 'bili-viewer' | 'owner-bili' | 'owner-manual'
  readonly status: 'active' | 'pending'
  readonly addedAt: string
  readonly prompt?: string
  readonly reply: string
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

/** One day: answers with the persona's stock lines (fork-integrity), and the main agent's mean answer length. */
export interface TrendDay {
  readonly day: string
  readonly answers: number
  readonly withTics: number
  readonly mainAnswers: number
  readonly meanChars: number | null
}

/** What `GET /api/fork.style` answers. */
export interface StylePanel {
  readonly enabled: boolean
  readonly review: 'optional' | 'required'
  readonly limits: { readonly maxActive: number; readonly maxOwner: number; readonly maxChars: number }
  readonly samples: readonly SampleView[]
  readonly running: boolean
  readonly lastRun: RunReport | null
  readonly nextRunAt: number | null
  readonly trend: readonly TrendDay[]
}

/** What `POST /api/fork.style.edit` takes. */
export type StyleEdit =
  | { readonly op: 'remove' | 'keep'; readonly id: string }
  | { readonly op: 'add'; readonly prompt?: string; readonly reply: string }

/** What an edit answers: the panel after it, and why it was refused when it was. */
export type StyleEditAnswer =
  | { readonly ok: true; readonly panel: StylePanel }
  | { readonly ok: false; readonly error: string; readonly panel: StylePanel }
