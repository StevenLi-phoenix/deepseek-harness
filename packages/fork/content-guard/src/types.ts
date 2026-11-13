/** Who may read the text once it is written. */
export type GuardAudience = 'public' | 'channel'

/** What a caller says about the text it asks the guard to check. */
export interface GuardCheckOptions {
  /** What the text is for, as a short identifier such as `persona_update`, `style_note`, `qq_group_note`, or `bili_channel_note`. */
  readonly purpose: string
  /**
   * `public`: anyone can read it, so the model layer always runs. `channel`: the readers of one channel (a QQ group,
   * a Bilibili account's replies).
   */
  readonly audience: GuardAudience
  /** The Session that wrote the text, for the log line. */
  readonly sessionId?: string | undefined
}

/**
 * The guard's answer. A refusal names the rule that fired and a generic reason; the reason never contains any of the
 * text, so a caller can hand it to the model that wrote the text.
 */
export type GuardVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly rule: string; readonly publicReason: string }

/** Counts for the Settings overview, without any text. */
export interface GuardHealth {
  /** Checks answered in the last 24 hours. */
  readonly checked: number
  /** Of those, the refused ones. */
  readonly rejected: number
  /** Refusals by rule, last 24 hours. */
  readonly byRule: Readonly<Record<string, number>>
  /** The most recent layer failure (a model call, the canary file, the memory file), if any; the message is cut to 200 characters. */
  readonly lastError: { readonly at: number; readonly rule: string; readonly message: string } | null
  /** Epoch milliseconds of the latest check; null before the first. */
  readonly lastCheckAt: number | null
}
