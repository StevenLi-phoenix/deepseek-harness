/**
 * What one subagent Session is doing, as a client-safe value: the `subagentActivity`
 * projection's wire type and its key declaration. Both halves import this module; it holds no
 * runtime code beyond constants.
 *
 * @module @deepseek-ai/dsh-subagent-activity/activity
 */

export {}

/** The projection key this package owns. */
export const ACTIVITY_KEY = 'subagentActivity'

/** Longest tool-argument preview kept, in characters. */
export const PREVIEW_CHARS = 120

/** Longest assistant text or reasoning preview kept, in characters. */
export const NOTE_CHARS = 160

/** One tool call as the panel shows it: the tool's name and a short line from its arguments. */
export interface ActivityTool {
  /** Registered tool name (`bash`, `read`, …). */
  readonly name: string
  /** The call's own description when it gave one, else its command, path, query, or URL; `''` when none. */
  readonly preview: string
}

/** How the latest closed turn ended; the upstream turn-end kinds, kept as strings so new kinds pass through. */
export type ActivityEnd = 'completed' | 'aborted' | 'error' | 'blocked' | 'max-tokens' | 'interrupted' | 'forked' | (string & {})

/**
 * Live activity of a subagent Session, folded from its own durable events.
 *
 * `phase` says what the child waits on right now: the model (`model`), a tool (`tool`), a retry delay
 * after a failed model request (`retry`), or nothing because no turn is open (`idle`). `since` is when
 * that phase began, so the panel can say how long the current wait has lasted; `at` is the newest
 * event this fold counted, so a turn that stops producing events shows its silence.
 */
export interface SubagentActivity {
  /** What the child waits on now. */
  readonly phase: 'model' | 'tool' | 'retry' | 'idle'
  /** Event time the current phase began, in ms. */
  readonly since: number
  /** Event time of the newest counted event, in ms. */
  readonly at: number
  /** Step number of the open turn (or of the last closed one); 0 before the first step. */
  readonly step: number
  /** Tool calls dispatched across the whole child log. */
  readonly toolCalls: number
  /** The oldest tool call still running, while `phase` is `tool`. */
  readonly tool?: ActivityTool & {
    /** Tool calls of the step still without a result, this one included. */
    readonly open: number
  }
  /** The model request being retried, while `phase` is `retry`. */
  readonly retry?: {
    /** 1-based retry number. */
    readonly attempt: number
    /** Retry budget; absent for an unlimited policy. */
    readonly max?: number
    /** The failure that caused the retry, shortened. */
    readonly reason: string
  }
  /** The newest tool call whose result arrived. */
  readonly lastTool?: ActivityTool & {
    /** Whether that result was an error. */
    readonly error: boolean
  }
  /** Newest assistant words: the reply text when the message had any, else the start of its reasoning. */
  readonly note?: {
    readonly kind: 'text' | 'thought'
    readonly text: string
  }
  /** How the latest closed turn ended, while `phase` is `idle`. */
  readonly ended?: ActivityEnd
  /** The failure message of a turn that ended with `error`, shortened. */
  readonly error?: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * Live activity of a subagent Session (fork, `@deepseek-ai/dsh-subagent-activity`). `null` for a
     * Session that is not a subagent, which keeps ordinary Session summaries free of this value.
     */
    subagentActivity: SubagentActivity | null
  }
}
