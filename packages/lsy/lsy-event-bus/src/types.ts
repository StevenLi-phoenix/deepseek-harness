/** Event, subscription, and actuator contracts shared by sensors, the bus, and actuators. */

/**
 * One observation a sensor publishes. `title` and `subject` are short labels;
 * `text`, `actor`, and `url` come from external systems and are untrusted.
 */
export interface LsyEventInput {
  /** Sensor id, e.g. `github`. */
  readonly source: string
  /** Dotted event kind, e.g. `github.release`; subscriptions match it by glob. */
  readonly kind: string
  /** Dedupe key unique within `source`; publishing a known key again is a duplicate. */
  readonly key: string
  /** What the event is about, e.g. `owner/repo`; subscriptions match it by glob. */
  readonly subject: string
  /** One-line human label. */
  readonly title: string
  /** Link to the event on its origin system. */
  readonly url?: string | undefined
  /** Origin-system identity that caused the event; loop suppression compares it. */
  readonly actor?: string | undefined
  /** Untrusted body excerpt; the bus bounds its length before storing it. */
  readonly text?: string | undefined
  /** Origin timestamp in Unix epoch milliseconds, when the origin reports one. */
  readonly occurredAt?: number | undefined
}

/** Result of one publish call. */
export type PublishOutcome = 'accepted' | 'duplicate' | 'suppressed' | 'unmatched'

/** Event fields carried into batches, notifications, and Session prompts. */
export interface BatchEvent {
  readonly id: string
  readonly source: string
  readonly kind: string
  readonly subject: string
  readonly title: string
  readonly url?: string | undefined
  readonly actor?: string | undefined
  readonly text?: string | undefined
  readonly occurredAt?: number | undefined
}

/** How a `session` subscription turns one batch into a new agent Session. */
export interface SessionAction {
  /** Absolute Workspace directory the Session runs in. */
  workspacePath: string
  /** Agent preset id, e.g. `standard` or a deployment-defined `unattended`. */
  agentPreset: string
  /** Permission preset id, e.g. `danger-full-access` for unattended runs. */
  permissionPreset: string
  /** Trusted task text placed before the untrusted event data. */
  instructions: string
  /** Session title prefix; defaults to the subscription id. */
  titlePrefix?: string
  /** Maximum events embedded in the prompt; the rest are counted. */
  maxPromptEvents: number
  /** Maximum characters of each event's untrusted text in the prompt. */
  maxTextChars: number
}

/** One user-authored routing rule from the bus configuration. */
export interface Subscription {
  /** Stable id; also the webhook delivery source and the notification label. */
  id: string
  /** Source globs; empty matches every source. */
  sources: string[]
  /** Kind globs; empty matches every kind. */
  kinds: string[]
  /** Subject globs; empty matches every subject. */
  subjects: string[]
  /** `notify` sends a message; `session` starts an agent Session. */
  action: 'notify' | 'session'
  /** Window after the first pending event during which later events join the same batch. */
  coalesceMs: number
  /** Maximum batches per rolling hour; later batches wait for the window to free up. */
  maxPerHour: number
  /** Required when `action` is `session`. */
  session?: SessionAction
}

/** Loop suppression: events the agent itself caused must not trigger it again. */
export interface SuppressConfig {
  /** Origin identities of the agent (e.g. its GitHub login), compared case-insensitively. */
  actors: string[]
  /** Substrings the agent writes into its own output (e.g. a commit trailer). */
  markers: string[]
}

/** One message for a human. */
export interface LsyNote {
  title: string
  body?: string | undefined
  url?: string | undefined
}

/** Notification actuator contract; a channel plugin provides it as `ctx.lsyNotifier`. */
export interface LsyNotifier {
  /**
   * Deliver one message.
   * @param note - title, optional body, and optional link.
   * @returns resolves once the channel accepted the message; rejects on failure.
   */
  send(note: LsyNote): Promise<void>
}

/** JSON event of one `lsy-event` webhook delivery. */
export interface LsyDeliveryEvent {
  subscription: string
  events: BatchEvent[]
}
