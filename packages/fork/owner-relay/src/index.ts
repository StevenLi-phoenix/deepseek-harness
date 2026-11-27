/**
 * One relay of a Session's final answer to the owner (`ctx.ownerRelay`). Channels (the WeChat chat,
 * the Bilibili account's messages) claim the Sessions whose answers they carry; the relay follows
 * those Sessions, keeps each turn's assistant texts, applies one rule set when the turn ends,
 * and hands the answer to the claiming channel. An answer a channel cannot deliver goes to
 * `ctx.ownerNotifier` instead, labelled with where it came from.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { failureDetail } from '@deepseek-ai/dsh-event-bus/prompt'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { contentText, decideRelay, relayFallbackNote, type RelayAnswer, type RelayDecision } from './rules.ts'

export type * from './rules.ts'

const JOB_LEAD = 'job-lead'

/** Host configuration of the dedicated job-lead route. */
export interface Config {
  /** ID of the persistent root Session on the job-lead preset; omitted disables routing. */
  jobLeadSessionId?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** One relay of claimed Sessions' final answers to the owner. */
    ownerRelay: OwnerRelay
  }
}

/** What a channel did with an answer: sent it (or durably queued it), or chose to leave it in the Session. */
export type RelayDelivery = 'sent' | 'kept'

/**
 * A route from claimed Sessions to the owner. The relay calls the hooks synchronously from the
 * Session's events: `onTurnStart` at `turn/start`, then at `turn/end` `onTurnEnd`, `deliver` when
 * there is something to send, and `onTurnSettled` once `deliver` (and any fallback) finished, or at
 * once when there was nothing to send.
 */
export interface RelayChannel {
  /** Unique channel name, e.g. `wechat` or `bili-dm`; claims refer to it. */
  readonly name: string
  /**
   * Who sent a fallback copy, as the owner's chat Session reads it (the note's `origin`), e.g.
   * `the Bilibili account's Session (its answer could not go out as a Bilibili message)`. Omit it on
   * routes that must never fall back to a direct owner notification.
   */
  readonly fallbackLabel?: string
  /**
   * Deliver one answer. Called synchronously when the turn ends.
   * @param answer - the Session, the text for the owner, the outcome, and the failure reason.
   * @returns `sent`, or `kept` when the channel chose not to send it (e.g. a turn no wake started).
   * @throws when the channel could not deliver it; the relay then falls back to the notifier.
   */
  deliver(answer: RelayAnswer): Promise<RelayDelivery>
  /** A claimed Session started a turn. */
  onTurnStart?(sessionId: string): void
  /**
   * A claimed Session ended a turn; called before `deliver`, whether or not anything is sent.
   * @param ended - the relay's decision: `answer` (a `deliver` follows), `silent` (NO_REPLY), `stopped` (the owner stopped it), or `empty`.
   */
  onTurnEnd?(sessionId: string, ended: RelayDecision['kind']): void
  /** The ended turn's answer went out, was kept, failed, or there was none. */
  onTurnSettled?(sessionId: string): void
}

type Hook = 'onTurnStart' | 'onTurnEnd' | 'onTurnSettled'

/** Human-readable error text. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** How a log line names the way a turn ended. */
function endedText(outcome: string, detail: string | undefined): string {
  return detail === undefined ? outcome : `${outcome}: ${detail}`
}

/** Why a turn sends nothing, as a log line ends. */
const NOTHING: Readonly<Record<Exclude<RelayDecision['kind'], 'answer'>, string>> = {
  stopped: 'the owner stopped; nothing is relayed',
  silent: 'that answered NO_REPLY; nothing is relayed',
  empty: 'without text; nothing is relayed',
}

/**
 * The relay. Claims live in memory: each channel claims its stored Sessions again when it
 * registers, and unregistering releases them. Every decision is logged at info level with the
 * Session id and the reason, never the text.
 */
export class OwnerRelay extends Service {
  /** Host-only configuration; no target is selected by default. */
  static Config: z<Config> = z.object({ jobLeadSessionId: z.string() })

  /** The sole target of the job-lead route. */
  readonly jobLeadSessionId: SessionId | undefined
  private readonly channels = new Map<string, RelayChannel>()
  /** Claiming channel per Session. */
  private readonly claims = new Map<string, string>()
  /** Assistant texts of the running turn, oldest first, per claimed Session. */
  private readonly texts = new Map<string, string[]>()
  private readonly inflight = new Set<Promise<void>>()

  /**
   * @param ctx - the context whose `session/event` stream the relay follows.
   * @param config - optional job-lead Session ID from the profile.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'ownerRelay')
    const id = config.jobLeadSessionId?.trim()
    this.jobLeadSessionId = id === undefined || id === '' ? undefined : SessionId(id)
    if (this.jobLeadSessionId !== undefined) {
      ctx.effect(() => this.registerChannel({
        name: JOB_LEAD,
        deliver: async ({ text }) => {
          const notifier = ctx.get('ownerNotifier')
          if (notifier?.tellMainAgent === undefined) throw new Error('no main-agent notifier is mounted')
          await notifier.tellMainAgent({ text, from: JOB_LEAD, origin: 'job' })
          return 'sent'
        },
      }), 'ownerRelay.jobLead()')
    }
    ctx.effect(() => async () => {
      await Promise.allSettled([...this.inflight])
    }, 'ownerRelay.lifecycle()')
    ctx.on('session/event', (session, event) => { this.observe(session, event) })
  }

  /**
   * Add a channel.
   * @param channel - name, delivery, hooks, and fallback label.
   * @returns a disposer that removes the channel and releases every Session it claimed.
   * @throws when a channel of the same name is registered.
   */
  registerChannel(channel: RelayChannel): () => void {
    if (this.channels.has(channel.name)) throw new Error(`owner-relay: a channel named ${channel.name} is already registered`)
    this.channels.set(channel.name, channel)
    this.ctx.logger.info(`owner-relay: channel ${channel.name} registered${channel.fallbackLabel === undefined ? ' (no fallback)' : ''}`)
    return () => {
      if (this.channels.get(channel.name) !== channel) return
      this.channels.delete(channel.name)
      let released = 0
      for (const [sessionId, owner] of [...this.claims]) {
        if (owner !== channel.name) continue
        this.release(sessionId)
        released += 1
      }
      this.ctx.logger.info(`owner-relay: channel ${channel.name} removed; released ${released} Session(s)`)
    }
  }

  /**
   * Relay a Session's turns through one channel from now on.
   * @param sessionId - Session to claim; a claim by another channel moves to this one.
   * @param channelName - the claiming channel's name.
   */
  claim(sessionId: string, channelName: string): void {
    if (sessionId === this.jobLeadSessionId || channelName === JOB_LEAD) return
    const previous = this.claims.get(sessionId)
    this.claims.set(sessionId, channelName)
    if (previous !== undefined && previous !== channelName) {
      this.ctx.logger.info(`owner-relay: Session ${sessionId} moves from ${previous} to ${channelName}`)
    } else if (previous === undefined) {
      this.ctx.logger.debug(`owner-relay: ${channelName} claims Session ${sessionId}`)
    }
  }

  /**
   * Stop relaying a Session.
   * @param sessionId - Session to release.
   * @returns whether it was claimed.
   */
  release(sessionId: string): boolean {
    if (sessionId === this.jobLeadSessionId) return false
    this.texts.delete(sessionId)
    return this.claims.delete(sessionId)
  }

  /**
   * The channel that relays a Session's turns.
   * @param sessionId - Session to check.
   * @returns the channel name, or undefined when no channel claimed the Session.
   */
  ownerOf(sessionId: string): string | undefined {
    return sessionId === this.jobLeadSessionId ? JOB_LEAD : this.claims.get(sessionId)
  }

  /** Follow claimed Sessions: hooks at turn start and end, the latest assistant text, and the relay. */
  private observe(session: Session, event: SessionEvent): void {
    const owner = this.ownerOf(session.id)
    if (owner === undefined) return
    if (owner === JOB_LEAD && (session.header.agentPreset !== JOB_LEAD || session.header.parentSession !== undefined)) {
      if (event.type === 'turn/end') this.ctx.logger.warn('owner-relay: configured job-lead target is not a root job-lead Session; nothing is relayed')
      return
    }
    if (event.type === 'assistant/message') {
      const text = contentText(event.data.message.content)
      if (text !== undefined) this.texts.set(session.id, [...this.texts.get(session.id) ?? [], text])
      return
    }
    const channel = this.channels.get(owner)
    if (event.type === 'turn/start') {
      if (channel !== undefined) this.hook(channel, 'onTurnStart', session.id)
      return
    }
    if (event.type !== 'turn/end') return
    const texts = this.texts.get(session.id) ?? []
    this.texts.delete(session.id)
    const reason = event.data.reason
    const ended = endedText(reason.kind, failureDetail(reason))
    if (channel === undefined) {
      const why = `its channel ${owner} is not registered; nothing is relayed`
      this.ctx.logger.warn(`owner-relay: Session ${session.id} ended a turn (${ended}), but ${why}`)
      return
    }
    const answers = owner === JOB_LEAD ? texts.slice(-1) : texts
    this.turnEnded(session.id, channel, ended, decideRelay(answers, reason))
  }

  /** Apply the decision of one ended turn: say why nothing goes out, or hand the answer to its channel. */
  private turnEnded(sessionId: string, channel: RelayChannel, ended: string, decision: RelayDecision): void {
    this.hook(channel, 'onTurnEnd', sessionId, decision.kind)
    if (decision.kind !== 'answer') {
      this.ctx.logger.info(`owner-relay: Session ${sessionId} ended a turn (${ended}) ${NOTHING[decision.kind]}`)
      this.hook(channel, 'onTurnSettled', sessionId)
      return
    }
    const { text, outcome, detail, parts } = decision
    const answer: RelayAnswer = {
      sessionId, text, outcome,
      ...(detail === undefined ? {} : { detail }),
      ...(parts === undefined ? {} : { parts }),
    }
    const messages = parts === undefined ? '' : ` from ${parts.length} messages`
    this.ctx.logger.info(`owner-relay: Session ${sessionId} ended a turn (${ended}); relaying ${text.length} chars${messages} through ${channel.name}`)
    const work = this.deliver(channel, answer).finally(() => { this.hook(channel, 'onTurnSettled', sessionId) })
    this.inflight.add(work)
    void work.finally(() => this.inflight.delete(work))
  }

  /** Hand one answer to its channel; a rejection falls back to the notifier. Never rejects. */
  private async deliver(channel: RelayChannel, answer: RelayAnswer): Promise<void> {
    let delivery: RelayDelivery
    try {
      // Called before the first await, so the channel sees the answer in the same tick as the turn's end.
      delivery = await channel.deliver(answer)
    } catch (error: unknown) {
      this.ctx.logger.warn(`owner-relay: ${channel.name} could not deliver the answer of Session ${answer.sessionId}: ${errorText(error)}`)
      await this.fallback(channel, answer, errorText(error))
      return
    }
    this.ctx.logger.info(delivery === 'sent'
      ? `owner-relay: ${channel.name} sent the answer of Session ${answer.sessionId}`
      : `owner-relay: ${channel.name} kept the answer of Session ${answer.sessionId} in the Session`)
  }

  /** Send an answer a channel could not deliver to the notifier, labelled with the channel's origin. */
  private async fallback(channel: RelayChannel, answer: RelayAnswer, why: string): Promise<void> {
    const id = answer.sessionId
    if (channel.fallbackLabel === undefined) {
      const own = `${channel.name} has no fallback label`
      this.ctx.logger.warn(`owner-relay: ${own}; the answer of Session ${id} was not delivered`)
      return
    }
    const notifier = this.ctx.get('ownerNotifier')
    if (notifier === undefined) {
      this.ctx.logger.warn(`owner-relay: no ownerNotifier is mounted; the answer of Session ${id} was not delivered`)
      return
    }
    try {
      await notifier.send(relayFallbackNote(answer, why, channel.fallbackLabel))
      this.ctx.logger.info(`owner-relay: sent the answer of Session ${id} to ownerNotifier instead of ${channel.name}`)
    } catch (error: unknown) {
      this.ctx.logger.warn(`owner-relay: the fallback of Session ${id} failed too: ${errorText(error)}`)
    }
  }

  /** Call one channel hook; a throwing hook is logged and never stops the relay. */
  private hook(channel: RelayChannel, hook: Hook, sessionId: string, ended?: RelayDecision['kind']): void {
    try {
      /* v8 ignore next -- turnEnded always passes the decision; the 'empty' default only satisfies the optional parameter type */
      if (hook === 'onTurnEnd') channel.onTurnEnd?.(sessionId, ended ?? 'empty')
      else channel[hook]?.(sessionId)
    } catch (error: unknown) {
      this.ctx.logger.warn(`owner-relay: ${channel.name} ${hook} failed for Session ${sessionId}: ${errorText(error)}`)
    }
  }
}

export default OwnerRelay
