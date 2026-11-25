/**
 * The Host style routes and what they answer, shared by both halves (no Node imports: the browser half reads this file
 * too). The answers are speaking-style's own types, imported type-only from its `./view` subpath.
 */

/** Absolute Host registration paths: the panel (GET), the owner's edits (POST), and a collection run on demand (POST). */
export const STYLE_PATH = '/api/speaking-style'
/** Absolute Host path of the owner's edits (POST). */
export const STYLE_EDIT_PATH = '/api/speaking-style.edit'
/** Absolute Host path of the on-demand collection run (POST). */
export const STYLE_COLLECT_PATH = '/api/speaking-style.collect'
/** Document-relative forms the browser fetches. */
export const STYLE_ROUTE = STYLE_PATH.slice(1)
/** Document-relative form of {@link STYLE_EDIT_PATH}. */
export const STYLE_EDIT_ROUTE = STYLE_EDIT_PATH.slice(1)
/** Document-relative form of {@link STYLE_COLLECT_PATH}. */
export const STYLE_COLLECT_ROUTE = STYLE_COLLECT_PATH.slice(1)

export type {
  CardView, MineReport, NoteView, Origin, RunReport, SampleView, StyleEdit, StyleEditAnswer, StylePanel, TrendDay,
} from '@deepseek-ai/dsh-speaking-style/view'
