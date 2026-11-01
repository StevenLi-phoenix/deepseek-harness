/**
 * Owner presence: whether the owner is asleep, as `ctx.forkPresence`. The phone's Sleep Focus is the
 * main source (an iOS Shortcut pushes `presence.sleep.on` and `presence.sleep.off` to
 * `fork-event-ingest`, which hands them to this service and never to the event bus, so they cannot start
 * a Session or send a message); a daily window in the owner's time zone covers the days no signal
 * arrives; the Settings buttons override both. Channels ask {@link ForkPresence.isAsleep} and
 * {@link ForkPresence.isUrgent}, hold back what is not urgent, and flush when the owner wakes.
 *
 * @module @deepseek-ai/dsh-fork-presence
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { globToRegExp, type ForkEventInput, type ForkIngestSink, type ForkNote } from '@deepseek-ai/dsh-fork-event-bus'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import z from '@deepseek-ai/schemastery'
import { PresenceSettings, type SettingsConnection } from './settings.ts'
import { evaluate, hours, nextChange, nextClockTime, type PresenceInputs, type PresenceRules, type PresenceState } from './state.ts'
import { presenceDomain, type InputsRecord } from './storage.ts'
import { CLOCK_PATTERN, KIND_SLEEP_OFF, KIND_SLEEP_ON, PRESENCE_SOURCE, type FocusView, type ManualView, type PresenceView, type QuietWindow } from './view.ts'

export * from './state.ts'
export * from './view.ts'
export type * from './storage.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    forkPresence: ForkPresence
  }
}

/** Event kinds sent even while the owner sleeps, unless the configuration names others. */
export const DEFAULT_URGENT_KINDS: readonly string[] = ['host.disk.full', 'host.*.critical', 'bili.risk.*', 'bili.gate.readonly']

/** Plugin configuration. */
export interface Config {
  /** IANA zone of the owner; the window and the manual times are read in it. */
  timeZone: string
  /** Daily fallback window, used when no Focus signal is fresh; the Settings page can replace it. */
  window: QuietWindow
  /** Hours an awake Focus signal outranks the window. */
  focusFreshHours: number
  /** Hours an asleep Focus signal holds when its off signal never arrives. */
  sleepMaxHours: number
  /** Hours a Settings button holds when it names no end. */
  manualMaxHours: number
  /** Globs of the event kinds that are sent while the owner sleeps. */
  urgentKinds: string[]
  /** Full URL of `fork-event-ingest`'s route, shown in the Shortcut instructions. */
  ingestUrl?: string
  /** Path of that route. */
  ingestPath: string
  /** Name of the environment variable that holds the `presence` ingest token, shown in the instructions (the value is never read here). */
  tokenEnv: string
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  timeZone: z.string().default('America/New_York'),
  window: z.object({
    enabled: z.boolean().default(true),
    start: z.string().pattern(CLOCK_PATTERN).default('03:30'),
    end: z.string().pattern(CLOCK_PATTERN).default('10:30'),
  }),
  focusFreshHours: z.natural().min(1).default(20),
  sleepMaxHours: z.natural().min(1).default(14),
  manualMaxHours: z.natural().min(1).default(12),
  urgentKinds: z.array(z.string()).default([...DEFAULT_URGENT_KINDS]),
  ingestUrl: z.string(),
  ingestPath: z.string().default('/hooks/events'),
  tokenEnv: z.string().default('FORK_INGEST_TOKEN_PRESENCE'),
})

/** What a channel that holds messages back registers, so Settings can count and flush them. */
export interface DeferralHolder {
  /** Channel name for the log. */
  readonly name: string
  /** Messages held back right now. */
  count(): number
  /**
   * Send what is held.
   * @returns how many messages went out.
   */
  flush(): Promise<number>
}

/** Called when the owner falls asleep or wakes. */
export type PresenceListener = (state: PresenceState) => void

/** Human-readable error text. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Fail at load on configuration that cannot work. */
function assertConfig(config: Config): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.timeZone })
  } catch {
    throw new Error(`fork-presence: timeZone "${config.timeZone}" is not a valid IANA time zone`)
  }
  if (config.window.enabled && config.window.start === config.window.end) throw new Error('fork-presence: window start and end must differ')
  if (config.ingestUrl !== undefined && !URL.canParse(config.ingestUrl)) throw new Error('fork-presence: ingestUrl must be a URL')
}

/**
 * Presence of the owner. Holds the latest Focus signal and Settings button in storage, evaluates the
 * answer on demand and at every moment it can change by itself, and tells listeners when the owner falls
 * asleep or wakes.
 */
export class ForkPresence extends Service implements ForkIngestSink {
  static inject = ['storageDomain']
  static Config = Config

  private readonly ready: Promise<Domain<typeof presenceDomain>>
  private readonly urgent: RegExp[]
  private readonly listeners = new Set<PresenceListener>()
  private readonly holders = new Set<DeferralHolder>()
  private inputs: PresenceInputs = {}
  private window: QuietWindow
  private current: PresenceState
  private timer: NodeJS.Timeout | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private domain: Domain<typeof presenceDomain> | undefined

  /**
   * @param ctx - Host with the storage domain facility.
   * @param config - zone, window, holding times, urgent kinds, and the instructions' texts.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'forkPresence')
    assertConfig(config)
    this.window = config.window
    this.urgent = config.urgentKinds.map(globToRegExp)
    this.current = this.evaluateNow()
    this.ready = ctx.storageDomain.open(presenceDomain)

    ctx.effect(async () => {
      const domain = await this.ready
      this.domain = domain
      const stored = domain.table('inputs').get('owner')
      this.inputs = { focus: stored?.focus, manual: stored?.manual }
      const window = domain.table('window').get('window')
      if (window !== undefined) this.window = window
      this.refresh('restored', false)
      this.ctx.logger.info(`fork-presence: ${this.describe(this.current)}; window ${this.windowText()} ${config.timeZone}${stored?.focus === undefined ? '; no Focus signal yet' : ''}`)
      return async () => {
        if (this.timer !== undefined) clearTimeout(this.timer)
        this.timer = undefined
        await this.chain
        await domain.close()
      }
    }, 'forkPresence.init()')

    // The Settings route mounts whenever the connection service is present; presence works without it.
    ctx.plugin({
      name: 'fork-presence-settings-route',
      inject: ['connection'],
      apply: (child: Context) => {
        const settings = new PresenceSettings({ presence: this, logger: child.logger })
        const connection = Reflect.get(child, 'connection') as SettingsConnection
        child.effect(() => connection.fetch.register(settings.route()), 'forkPresence.settings()')
      },
    })
  }

  /** The rules the state machine runs on. */
  private get rules(): PresenceRules {
    return {
      timeZone: this.config.timeZone,
      window: this.window,
      focusFreshMs: hours(this.config.focusFreshHours),
      sleepMaxMs: hours(this.config.sleepMaxHours),
      manualMaxMs: hours(this.config.manualMaxHours),
    }
  }

  private evaluateNow(): PresenceState {
    return evaluate(Date.now(), this.inputs, this.rules)
  }

  /**
   * Whether the owner is asleep right now.
   * @returns true while a button, a fresh Focus signal, or the window says so.
   */
  isAsleep(): boolean {
    return this.evaluateNow().asleep
  }

  /**
   * Whether a message must be sent even while the owner sleeps: the sender marked it urgent, or one of the
   * event kinds it reports matches an urgent glob.
   * @param note - the message; only `urgent` and `kinds` are read.
   * @returns true when it must not wait.
   */
  isUrgent(note: Pick<ForkNote, 'urgent' | 'kinds'>): boolean {
    return note.urgent === true || (note.kinds ?? []).some(kind => this.urgent.some(pattern => pattern.test(kind)))
  }

  /**
   * Listen for the owner falling asleep and waking, whatever the source.
   * @param listener - called with the new state.
   * @returns a function that stops listening.
   */
  onChange(listener: PresenceListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Register a channel that holds messages back.
   * @param holder - how to count and flush them.
   * @returns a function that unregisters it.
   */
  registerHolder(holder: DeferralHolder): () => void {
    this.holders.add(holder)
    return () => { this.holders.delete(holder) }
  }

  /**
   * Send what the channels hold back, now.
   * @returns how many messages went out.
   */
  async flushNow(): Promise<number> {
    let sent = 0
    for (const holder of this.holders) {
      try {
        sent += await holder.flush()
      } catch (error: unknown) {
        this.ctx.logger.warn(`fork-presence: ${holder.name} could not flush: ${errorText(error)}`)
      }
    }
    return sent
  }

  /**
   * Apply a Focus signal pushed by the phone (the `presence` ingest source). The Host's receipt time is
   * the signal's time; the pusher's clock and key are ignored.
   * @param event - `presence.sleep.on` or `presence.sleep.off`.
   * @returns `asleep` or `awake`, as the signal says.
   * @throws {Error} for any other kind.
   */
  async ingest(event: ForkEventInput): Promise<string> {
    if (event.source !== PRESENCE_SOURCE || (event.kind !== KIND_SLEEP_ON && event.kind !== KIND_SLEEP_OFF)) {
      throw new Error(`unknown presence kind; use ${KIND_SLEEP_ON} or ${KIND_SLEEP_OFF}`)
    }
    const asleep = event.kind === KIND_SLEEP_ON
    await this.update(() => ({ ...this.inputs, focus: { asleep, at: Date.now() }, manual: undefined }), `focus ${asleep ? 'on' : 'off'}`)
    return asleep ? 'asleep' : 'awake'
  }

  /**
   * Press "I am going to sleep" or "I am awake", optionally with an end.
   * @param asleep - the state to hold.
   * @param until - when it lapses, in Unix epoch milliseconds; omitted holds for `manualMaxHours` or until the next Focus signal.
   */
  async setManual(asleep: boolean, until?: number): Promise<void> {
    const at = Date.now()
    await this.update(() => ({ ...this.inputs, manual: { asleep, at, ...until === undefined ? {} : { until } } }), `manual ${asleep ? 'asleep' : 'awake'}`)
  }

  /**
   * Quiet until a clock time: the next time the local clock reads `clock`.
   * @param clock - `HH:MM`, 24-hour.
   * @returns the end, in Unix epoch milliseconds.
   */
  async quietUntil(clock: string): Promise<number> {
    const until = nextClockTime(Date.now(), clock, this.config.timeZone)
    await this.setManual(true, until)
    return until
  }

  /** Drop the button, so the Focus signal or the window decides again. */
  async clearManual(): Promise<void> {
    await this.update(() => ({ ...this.inputs, manual: undefined }), 'manual cleared')
  }

  /**
   * Replace the daily window; it survives restarts and replaces the configured one.
   * @param window - the new window.
   */
  async setWindow(window: QuietWindow): Promise<void> {
    await this.serialize(async () => {
      this.window = window
      await this.domain?.table('window').put('window', window)
      this.refresh('window changed', true)
    })
  }

  /**
   * The state with everything Settings shows.
   * @param deferred - messages held back, if the caller counts them.
   * @returns the view.
   */
  view(deferred: number = this.deferredCount()): PresenceView {
    const state = this.evaluateNow()
    const rules = this.rules
    const { manual, focus } = this.inputs
    const active = manual !== undefined && state.source === 'manual'
    const manualView: ManualView | null = active
      ? { asleep: manual.asleep, at: manual.at, until: state.until ?? manual.at + rules.manualMaxMs }
      : null
    const lastFocus: FocusView | null = focus === undefined ? null : { asleep: focus.asleep, at: focus.at }
    return {
      asleep: state.asleep,
      source: state.source,
      since: state.since,
      until: state.until,
      manual: manualView,
      lastFocus,
      window: this.window,
      deferred,
      urgentKinds: this.config.urgentKinds,
      shortcut: shortcut(this.config),
      timeZone: this.config.timeZone,
    }
  }

  /**
   * Count what the channels hold back.
   * @returns messages the registered channels hold back.
   */
  deferredCount(): number {
    let count = 0
    for (const holder of this.holders) count += holder.count()
    return count
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work)
    this.chain = result.catch(() => undefined)
    return result
  }

  /** Change the inputs, store them, and tell listeners if the owner fell asleep or woke. */
  private update(change: () => PresenceInputs, reason: string): Promise<void> {
    return this.serialize(async () => {
      this.inputs = change()
      try {
        await this.domain?.table('inputs').put('owner', storable(this.inputs))
      } catch (error: unknown) {
        this.ctx.logger.warn(`fork-presence: the new state is kept in memory only; storing it failed: ${errorText(error)}`)
      }
      this.refresh(reason, true)
    })
  }

  /** Re-evaluate, log a change, tell listeners about a sleep or wake, and arm the timer for the next change by itself. */
  private refresh(reason: string, notify: boolean): void {
    const before = this.current
    const now = this.evaluateNow()
    this.current = now
    if (now.asleep !== before.asleep || now.source !== before.source) {
      this.ctx.logger.info(`fork-presence: ${this.describe(now)} (${reason})`)
    }
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    const next = nextChange(Date.now(), this.inputs, this.rules)
    if (next !== undefined) {
      // Re-arm at least a second out and at most a day out, so a boundary that lands on `now` cannot spin.
      const wait = Math.min(Math.max(next - Date.now() + 50, 1000), 86_400_000)
      this.timer = setTimeout(() => { this.refresh('time passed', true) }, wait)
      this.timer.unref()
    }
    if (notify && now.asleep !== before.asleep) {
      for (const listener of this.listeners) {
        try {
          listener(now)
        } catch (error: unknown) {
          this.ctx.logger.warn(`fork-presence: a listener failed: ${errorText(error)}`)
        }
      }
    }
  }

  private describe(state: PresenceState): string {
    return `${state.asleep ? 'asleep' : 'awake'} by ${state.source}`
  }

  private windowText(): string {
    return this.window.enabled ? `${this.window.start}-${this.window.end}` : 'off'
  }
}

/** The inputs as a storage row, without the fields that are unset. */
function storable(inputs: PresenceInputs): InputsRecord {
  const { focus, manual } = inputs
  return {
    ...focus === undefined ? {} : { focus: { asleep: focus.asleep, at: focus.at } },
    ...manual === undefined
      ? {}
      : { manual: { asleep: manual.asleep, at: manual.at, ...manual.until === undefined ? {} : { until: manual.until } } },
  }
}

/** The Shortcut instructions' texts. */
function shortcut(config: Config): PresenceView['shortcut'] {
  const body = (kind: string, title: string): string => JSON.stringify({ kind, key: '<date>', subject: 'owner', title })
  return {
    url: config.ingestUrl ?? null,
    path: config.ingestPath,
    header: 'Authorization',
    tokenEnv: config.tokenEnv,
    bodyOn: body(KIND_SLEEP_ON, 'Sleep Focus on'),
    bodyOff: body(KIND_SLEEP_OFF, 'Sleep Focus off'),
  }
}

export default ForkPresence
