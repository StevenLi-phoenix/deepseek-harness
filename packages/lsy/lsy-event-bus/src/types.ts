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
  /**
   * The source is an authenticated owner channel (for example lsy-event-ingest's `operator`
   * token): the prompt presents each event's `text` as the owner's request instead of
   * untrusted data. Only set it on subscriptions whose sources no outsider can publish to.
   */
  trustedText?: boolean
}

/** One routing rule, from the bus configuration or created at run time through `LsyEventBus.subscribe()`. */
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

/** Where a subscription comes from: the bus configuration or a run-time `subscribe()` call. */
export type SubscriptionOrigin = 'config' | 'agent'

/** Creator recorded with a run-time subscription. */
export interface SubscriptionMeta {
  /** Session whose agent created the subscription. */
  createdBy?: string
}

/** Live routing state of one subscription. */
export interface SubscriptionStatus {
  /** Events waiting for the next batch. */
  pending: number
  /** Batches created in the last rolling hour; at `maxPerHour` later batches wait. */
  batchesLastHour: number
  /** When the armed flush timer fires, in Unix epoch milliseconds. */
  nextFlushAt?: number
  /** Most recent retained batch. */
  lastBatch?: BatchSummary
}

/** The fields of a stored batch that describe what happened to it. */
export interface BatchSummary {
  id: string
  createdAt: number
  eventCount: number
  status: 'dispatched' | 'delivered' | 'completed' | 'failed'
  error?: string
  sessionId?: string
  outcome?: string
  silent?: boolean
}

/** One subscription as `LsyEventBus.listSubscriptions()` reports it. */
export interface SubscriptionView extends Subscription {
  origin: SubscriptionOrigin
  /** Creation time of a run-time subscription, in Unix epoch milliseconds. */
  createdAt?: number
  /** Session whose agent created a run-time subscription. */
  createdBy?: string
  status: SubscriptionStatus
}

/** Result of `LsyEventBus.unsubscribe()`. */
export type UnsubscribeOutcome = 'removed' | 'not_found' | 'config_owned'

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
  /**
   * Who sent it, as the owner's chat Session should read the copy a channel shares with it, e.g.
   * `the Bilibili account's Session (its answer could not go out as a Bilibili message)`. Never
   * shown to the owner; without it the channel names a generic other Session.
   */
  origin?: string | undefined
}

/** A message another of the agent's Sessions sends the owner's main agent. */
export interface LsyAgentMessage {
  /** The message as the sending Session wrote it; the main agent reads it as untrusted data. */
  text: string
  /**
   * Who sent it, as the main agent reads it, e.g. `the Bilibili account's Session (the agent on its
   * own Bilibili account, which reads public Bilibili content)`.
   */
  from: string
}

/** Notification actuator contract; a channel plugin provides it as `ctx.lsyNotifier`. */
export interface LsyNotifier {
  /**
   * Deliver one message.
   * @param note - title, optional body, optional link, and optional origin.
   * @returns resolves once the channel accepted the message; rejects on failure.
   */
  send(note: LsyNote): Promise<void>
  /**
   * Pass a message from another of the agent's Sessions to the owner's main agent: the channel's
   * chat Session, which takes it up in a turn of its own once it is idle. That turn's answer reaches
   * the owner like any other chat answer. Channels without a chat Session omit it.
   * @param message - the text and who sent it.
   * @returns the chat Session the message was queued in.
   * @throws when there is no chat to pass it to or the Session refused the prompt.
   */
  tellMainAgent?(message: LsyAgentMessage): Promise<string>
  /**
   * Whether the channel created this Session (e.g. its chat Session). Kept for callers outside the
   * bus; the bus asks `ctx.ownerRelay.ownerOf()` which Sessions a relay channel delivers itself.
   * @param sessionId - Session to check.
   * @returns true when the channel created this Session.
   */
  ownsSession?(sessionId: string): boolean
}

/** JSON event of one `lsy-event` webhook delivery. */
export interface LsyDeliveryEvent {
  subscription: string
  events: BatchEvent[]
}
