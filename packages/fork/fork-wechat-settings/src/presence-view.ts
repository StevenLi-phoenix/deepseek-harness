/**
 * What the Settings route answers and accepts, shared by both halves as types, constants, and pure
 * helpers only. Nothing here can carry a token: the Shortcut instructions name the environment
 * variable that holds it, never its value.
 */

/** Absolute Host registration path of the Settings route. */
export const PRESENCE_PATH = '/api/fork.presence'
/** Document-relative form the browser fetches. */
export const PRESENCE_ROUTE = PRESENCE_PATH.slice(1)

/** Ingest source id the phone pushes under; its event kinds start with `presence.`. */
export const PRESENCE_SOURCE = 'presence'
/** Event kind of Sleep Focus turning on. */
export const KIND_SLEEP_ON = 'presence.sleep.on'
/** Event kind of Sleep Focus turning off. */
export const KIND_SLEEP_OFF = 'presence.sleep.off'

/** Where the current answer comes from: the phone's Sleep Focus, the daily window, or a button in Settings. */
export type PresenceSource = 'focus' | 'window' | 'manual'

/** Daily fallback window, in the owner's time zone; it wraps past midnight when `start` is later than `end`. */
export interface QuietWindow {
  /** Whether the window applies at all. */
  readonly enabled: boolean
  /** `HH:MM`, 24-hour. */
  readonly start: string
  /** `HH:MM`, 24-hour. */
  readonly end: string
}

/** A button the owner pressed and what it still holds. */
export interface ManualView {
  readonly asleep: boolean
  /** When it was pressed, in Unix epoch milliseconds. */
  readonly at: number
  /** When it lapses by itself, in Unix epoch milliseconds. */
  readonly until: number
}

/** The latest signal from the phone's Sleep Focus. */
export interface FocusView {
  readonly asleep: boolean
  /** Unix epoch milliseconds the Host received it. */
  readonly at: number
}

/** How the phone is told to push, for the Shortcut instructions. */
export interface ShortcutView {
  /** Full URL of the ingest route when the deployment names it; null otherwise. */
  readonly url: string | null
  /** Path of the ingest route. */
  readonly path: string
  /** Request header that carries the token. */
  readonly header: 'Authorization'
  /** Name of the environment variable that holds the token on the Host (never its value). */
  readonly tokenEnv: string
  /** JSON body for Sleep Focus turning on and off; `<date>` stands for the Shortcut's Current Date variable. */
  readonly bodyOn: string
  readonly bodyOff: string
}

/** Body of `GET api/fork.presence`. */
export interface PresenceView {
  readonly asleep: boolean
  readonly source: PresenceSource
  /** Unix epoch milliseconds the current state began; null when nothing says (no window, no signal). */
  readonly since: number | null
  /** When it ends by itself, in Unix epoch milliseconds; null when it lasts until a signal. */
  readonly until: number | null
  /** The button that decides the state while it is active; null otherwise. */
  readonly manual: ManualView | null
  /** The latest Focus signal, fresh or not; null before the first. */
  readonly lastFocus: FocusView | null
  readonly window: QuietWindow
  /** Messages the channels hold back right now. */
  readonly deferred: number
  /** Globs of the event kinds that are sent even while the owner sleeps. */
  readonly urgentKinds: readonly string[]
  readonly shortcut: ShortcutView
  /** IANA zone the window and the manual times are read in. */
  readonly timeZone: string
}

/** Body of every `POST api/fork.presence`. */
export interface PresenceAnswer {
  readonly view: PresenceView
  /** Messages `flush` sent; null for the other actions. */
  readonly flushed: number | null
}

/** Body of `POST api/fork.presence`. */
export type PresenceAction =
  | { readonly action: 'sleep.now' }
  | { readonly action: 'wake.now' }
  | { readonly action: 'quiet.until'; readonly until: string }
  | { readonly action: 'manual.clear' }
  | { readonly action: 'window.set'; readonly enabled: boolean; readonly start: string; readonly end: string }
  | { readonly action: 'flush' }

/** A clock time as the owner types it: `HH:MM`, 24-hour. */
export const CLOCK_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u
