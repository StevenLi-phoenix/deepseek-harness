/**
 * What the Host routes answer and accept, shared by both halves as types and
 * constants only. Nothing here carries a key, a token, a URL of a service, or
 * the text of a message: the Host reports states and counts.
 */

/** Health of one service: `ok`, `warn` (works with a problem), `down`, or `off` (not mounted or switched off). */
export type Tone = 'ok' | 'warn' | 'down' | 'off'

/** Services the overview shows, in order. */
export const SERVICE_IDS = ['dsh', 'bus', 'bili', 'qq', 'wechat', 'style', 'voice', 'cc', 'ams', 'llm'] as const
/** One of {@link SERVICE_IDS}. */
export type ServiceId = typeof SERVICE_IDS[number]

/** A fact a card line interpolates. */
export type Fact = string | number | boolean | null

/** One overview card; the browser picks the copy by `id` and `state` and fills it from `facts`. */
export interface ServiceCard {
  readonly id: ServiceId
  readonly tone: Tone
  /** Copy key suffix of the status line, for example `up`, `down`, or `absent`. */
  readonly state: string
  readonly facts: Readonly<Record<string, Fact>>
}

/** Body of `GET api/lsy.overview`. */
export interface OverviewView {
  readonly cards: readonly ServiceCard[]
  readonly checkedAt: number
}

/** Where a run-time subscription or schedule came from. */
export type SubscriptionOrigin = 'config' | 'agent'

/** One event subscription of the bus. */
export interface SubscriptionRow {
  readonly id: string
  /** `config` rows are read-only here. */
  readonly origin: SubscriptionOrigin
  readonly mode: 'notify' | 'session'
  readonly sources: readonly string[]
  readonly kinds: readonly string[]
  readonly subjects: readonly string[]
  readonly paused: boolean
  /** Session id of the creating agent, `settings` for this page, or null for configuration. */
  readonly createdBy: string | null
  readonly createdAt: number | null
  readonly lastFiredAt: number | null
  /** Batches the bus still holds for it (retention bounds the history). */
  readonly fireCount: number
  readonly pending: number
  /** Status of the last batch, when there is one. */
  readonly lastStatus: 'dispatched' | 'delivered' | 'completed' | 'failed' | null
}

/** One reminder of the Host schedule service. */
export interface ScheduleRow {
  readonly id: string
  readonly title: string
  /** Rule kind: `after`, `at`, `every`, `daily`, `weekly`, `cron`, or `rrule`. */
  readonly rule: string
  /** The rule's parameters in short form, for example `1800 s`, `09:00 Asia/Shanghai`, or a cron expression. */
  readonly detail: string
  readonly status: 'active' | 'paused' | 'ended'
  /** Next occurrence, or the last one when ended. */
  readonly nextAt: number | null
  readonly lastFiredAt: number | null
}

/** One Session the auto-archive sweep archived (or, in a preview, would archive). */
export interface ArchivedRow {
  readonly id: string
  /** The Session's title as the sidebar shows it, cut to 80 characters; null when it has none. */
  readonly title: string | null
  /** Time of its last message. */
  readonly lastActiveAt: number
  /** When it was archived; null in a preview. */
  readonly archivedAt: number | null
}

/** The last auto-archive sweep. */
export interface ArchiveSweepView {
  readonly at: number
  readonly trigger: 'timer' | 'manual'
  /** A preview: nothing was archived. */
  readonly dryRun: boolean
  readonly scanned: number
  /** Sessions archived, or in a preview the number that would be. */
  readonly archived: number
  /** Sessions left alone, by reason (`recent`, `persistent`, `wechat`, ...). */
  readonly skipped: Readonly<Record<string, number>>
  readonly errors: number
  /** Why the sweep could not run; null when it ran. */
  readonly aborted: string | null
  /** A preview's Sessions, oldest first, at most 20. */
  readonly preview: readonly ArchivedRow[]
}

/** The event bus's auto-archive (chat Sessions idle for days are archived, never deleted). */
export interface ArchiveView {
  readonly enabled: boolean
  readonly dryRun: boolean
  readonly inactiveDays: number
  readonly maxPerSweep: number
  readonly sweepHours: number
  /** When the next sweep runs; null while it is off. */
  readonly nextSweepAt: number | null
  /** Plugins that keep their own Sessions out of the sweep. */
  readonly protectors: readonly string[]
  readonly last: ArchiveSweepView | null
  /** Newest first, at most 30. */
  readonly recent: readonly ArchivedRow[]
}

/** Body of `GET api/lsy.subscriptions`. */
export interface SubscriptionsView {
  /** Null when the bus is not mounted. */
  readonly subscriptions: readonly SubscriptionRow[] | null
  /** Null when the schedule service is not mounted. */
  readonly schedules: readonly ScheduleRow[] | null
  /** Null when the bus is not mounted. */
  readonly archive: ArchiveView | null
  /** Defaults the create form shows. */
  readonly defaults: {
    readonly coalesceSeconds: number
    readonly notifyMaxPerHour: number
    readonly sessionMaxPerHour: number
    /** Preset and workspace a `session` subscription made from the form runs with. */
    readonly agentPreset: string
    readonly workspacePath: string
  }
  readonly checkedAt: number
}

/** The simple subscription the form creates. */
export interface NewSubscription {
  readonly id: string
  readonly sources: readonly string[]
  readonly kinds: readonly string[]
  readonly subjects: readonly string[]
  readonly mode: 'notify' | 'session'
  /** Required for `session`: the trusted task text placed before the event data. */
  readonly instructions?: string
  readonly coalesceSeconds?: number
  readonly maxPerHour?: number
}

/** Body of `POST api/lsy.subscriptions`. */
export type SubscriptionAction =
  | { readonly action: 'create'; readonly subscription: NewSubscription }
  | { readonly action: 'pause' | 'resume' | 'delete'; readonly target: 'subscription' | 'schedule'; readonly id: string }
  /** Run an auto-archive sweep now; `dryRun` only lists what it would archive. */
  | { readonly action: 'archive.sweep'; readonly dryRun: boolean }

/** Stable refusal codes of the POST routes; the browser picks the copy by code. */
export const ACTION_ERRORS = [
  'invalid_request', 'unavailable', 'not_found', 'config_owned', 'duplicate_id', 'invalid_subscription', 'limit_reached',
  'start_failed', 'stop_failed', 'speech_failed', 'speech_off', 'internal_error',
] as const
/** One of {@link ACTION_ERRORS}. */
export type ActionErrorCode = typeof ACTION_ERRORS[number]

/** Refusal body of a POST route. */
export interface ActionError {
  readonly error: ActionErrorCode
  /** Short reason fit for the screen; never request data. */
  readonly detail?: string
}

/** A Claude Code session of the service account. */
export interface CcSession {
  readonly name: string
  readonly pid: number
  readonly status: string | null
  readonly cwd: string | null
  readonly updatedAt: number | null
  /** The bridge started it in tmux, so this page can stop it. */
  readonly managed: boolean
}

/** Login state of the service account's Claude Code, from file existence only. */
export type CcLogin = 'full' | 'token' | 'none'

/** The Claude Code card. */
export interface CcView {
  readonly enabled: boolean
  readonly login: CcLogin
  readonly sessions: readonly CcSession[]
  readonly maxSessions: number
  /** Names of tmux sessions the bridge started, including ones not yet registered. */
  readonly started: readonly string[]
}

/** The voice card. */
export interface VoiceView {
  readonly available: boolean
  readonly ttsEnabled: boolean
  readonly provider: string
  readonly format: string
  readonly ttsUp: boolean | null
  readonly asrEnabled: boolean
  readonly engine: string
  readonly asrUp: boolean | null
  /** Characters of the fixed preview sentence. */
  readonly previewChars: number
}

/** Body of `GET api/lsy.agents`. */
export interface AgentsView {
  readonly cc: CcView | null
  readonly voice: VoiceView | null
  readonly checkedAt: number
}

/** Body of `POST api/lsy.agents`. */
export type AgentsAction =
  | { readonly action: 'cc.start'; readonly name: string; readonly task?: string }
  | { readonly action: 'cc.stop'; readonly name: string }
  | { readonly action: 'voice.preview' }

/** Longest first task, as `cc_start` allows. */
export const MAX_TASK_CHARS = 8000

/** What became of one event: told to the owner, judged not worth it, failed, at work, waiting for its batch, or no one listens. */
export type FlowOutcome = 'sent' | 'silent' | 'failed' | 'working' | 'waiting' | 'suppressed' | 'unmatched'

/** The time spans the message flow page offers. */
export const FLOW_WINDOWS = ['1h', '24h', '7d'] as const
/** One of {@link FLOW_WINDOWS}. */
export type FlowWindow = typeof FLOW_WINDOWS[number]

/** How much passed one source in a window. */
export interface FlowSourceActivity {
  readonly count: number
  readonly lastAt: number | null
}

/** How much one subscription handled in a window, in batches. */
export interface FlowSubscriptionActivity extends FlowSourceActivity {
  readonly sent: number
  readonly silent: number
  readonly failed: number
}

/** One window of the page: from everything that came in to what reached the owner. */
export interface FlowWindowActivity {
  readonly funnel: {
    readonly events: number
    readonly batches: number
    readonly sent: number
    readonly silent: number
    readonly failed: number
  }
  readonly sources: Readonly<Record<string, FlowSourceActivity>>
  readonly subscriptions: Readonly<Record<string, FlowSubscriptionActivity>>
  /** Events no subscription took, or a filter dropped: counted in the funnel, left out of the list. */
  readonly ignored: number
}

/** One thing that happened, by its label only: never the text of a message. */
export interface FlowRecentItem {
  readonly id: string
  readonly at: number
  readonly source: string
  readonly kind: string
  readonly title: string
  readonly subscriptions: readonly string[]
  readonly outcome: FlowOutcome
}

/** Body of `GET api/lsy.flow`. */
export interface FlowActivityView {
  readonly windows: Readonly<Record<FlowWindow, FlowWindowActivity>>
  /** What a subscription took, newest first, at most 50. */
  readonly recent: readonly FlowRecentItem[]
  /** Null when `lsy-presence` is not mounted. */
  readonly presence: { readonly asleep: boolean; readonly deferred: number } | null
  readonly checkedAt: number
}

/** Absolute Host registration paths of the routes. */
export const OVERVIEW_PATH = '/api/lsy.overview'
export const FLOW_PATH = '/api/lsy.flow'
export const SUBSCRIPTIONS_PATH = '/api/lsy.subscriptions'
export const AGENTS_PATH = '/api/lsy.agents'
/** Document-relative forms the browser fetches. */
export const OVERVIEW_ROUTE = OVERVIEW_PATH.slice(1)
export const FLOW_ROUTE = FLOW_PATH.slice(1)
export const SUBSCRIPTIONS_ROUTE = SUBSCRIPTIONS_PATH.slice(1)
export const AGENTS_ROUTE = AGENTS_PATH.slice(1)
