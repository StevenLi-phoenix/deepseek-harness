/**
 * The account's DM channel (`bili-dm`) of `ctx.ownerRelay`: the final answer of each turn a wake
 * started goes to the owner as Bilibili messages from the account, and whatever cannot go out goes
 * to WeChat with the reason, labelled for the owner's chat Session as the account's.
 */
// Type-only: the ctx.lsyNotifier contract and the relay's channel contract.
import type { LsyNotifier } from '@deepseek-ai/dsh-lsy-event-bus'
import type { RelayAnswer, RelayChannel, RelayDelivery } from '@deepseek-ai/dsh-owner-relay'
import { FALLBACK_TITLE, TEXT_LIMITS, splitMessage } from './text.ts'
import type { WakeReason } from './view.ts'

/** Name of the account's channel in `ctx.ownerRelay`. */
export const BILI_RELAY_CHANNEL = 'bili-dm'
/** How the owner's WeChat chat Session reads an answer of the account that came to WeChat instead. */
export const BILI_FALLBACK_LABEL = 'the Bilibili account\'s Session (its answer could not go out as a Bilibili message)'
/** Who sent a host notice about the account (sign-in, risk-control pause, hidden comment), as the owner's chat Session reads it. */
export const BILI_NOTICE_ORIGIN = 'the dsh-bili plugin (a host notice about dsh\'s own Bilibili account, not the agent speaking)'
/** How long a turn's answer waits for its write slot before it goes to WeChat instead. */
export const ANSWER_WAIT_MS = 900_000

/** What started a turn: the wake reason, and whether it carried messages from the owner (the answer is a reply). */
export interface WakeOrigin {
  readonly reason: WakeReason
  readonly owner: boolean
}

/** A message action to the owner's main account. */
export type DmAction = 'dmOwner' | 'dmReply'

/** The write guard's answer to one message, as the channel reads it. */
export interface DmOutcome {
  readonly outcome: 'sent' | 'already' | 'refused' | 'uncertain'
  readonly detail: string
  /** Bilibili's words when it refused for want of a verified phone number. */
  readonly verification?: string
}

/** What the channel needs of the account. */
export interface DmChannelHost {
  /** Send one message to the owner's main account through the write guard. */
  messageOwner(action: DmAction, text: string, maxWaitMs: number): Promise<DmOutcome>
  /** Report a share for each video link in a text the host delivered to the owner. */
  reportShares(text: string): void
  /** Keep a delivery alive until the account's teardown drains it; its outcome stays the relay's. */
  hold<T>(work: Promise<T>): Promise<T>
  /** The WeChat notifier, read per use. */
  notifier(): Pick<LsyNotifier, 'send'> | undefined
  logger: { info(message: string): void; warn(message: string): void }
}

/** The line under an answer that came to WeChat: Bilibili's words for a phone-verification refusal, else the host's reason. */
function refusalLine(outcome: DmOutcome): string {
  return outcome.outcome === 'refused' && outcome.verification !== undefined
    ? `B站私信没发出：${outcome.verification}`
    : `原因：${outcome.detail}`
}

/** How a log line names the way a turn ended. */
function endedText(answer: RelayAnswer): string {
  return answer.detail === undefined ? answer.outcome : `${answer.outcome}: ${answer.detail}`
}

/**
 * The DM channel. The account records each wake's origin before its prompt; the relay calls
 * `onTurnEnd` when a turn ends, which takes that origin for the turn, and then `deliver`.
 */
export class DmChannel implements RelayChannel {
  readonly name = BILI_RELAY_CHANNEL
  readonly fallbackLabel = BILI_FALLBACK_LABEL
  /** The origin of each Session's next or running turn, recorded before the wake's prompt. */
  private readonly origins = new Map<string, WakeOrigin>()
  /** The origin of the turn that just ended, from `onTurnEnd` to the `deliver` that follows it in the same tick. */
  private readonly ended = new Map<string, WakeOrigin>()

  /** @param host - the account's message sending, share reports, teardown hold, notifier, and logger. */
  constructor(private readonly host: DmChannelHost) {}

  /**
   * Record what starts a Session's next turn, before the wake's prompt.
   * @param sessionId - the account's Session.
   * @param origin - the wake reason, and whether it carries the owner's messages.
   */
  setOrigin(sessionId: string, origin: WakeOrigin): void {
    this.origins.set(sessionId, origin)
  }

  /**
   * Forget a recorded origin whose prompt failed.
   * @param sessionId - the account's Session.
   */
  dropOrigin(sessionId: string): void {
    this.origins.delete(sessionId)
  }

  /**
   * A turn ended: it takes the recorded origin, whether or not the relay delivers anything, so a
   * later turn no wake started (the owner in the Web UI) never inherits it.
   * @param sessionId - the account's Session.
   */
  onTurnEnd(sessionId: string): void {
    const origin = this.origins.get(sessionId)
    this.origins.delete(sessionId)
    if (origin === undefined) this.ended.delete(sessionId)
    else this.ended.set(sessionId, origin)
  }

  /**
   * Send a turn's answer to the owner as Bilibili messages from the account: a reply to the owner's
   * messages, or a share. It is split into at most two messages; whatever cannot go out (not mutual,
   * budget, pause, a failed or uncertain send) goes to WeChat with the reason.
   * @param answer - the answer the relay decided on.
   * @returns `kept` for a turn no wake started, else `sent`.
   * @throws when part of the answer reached neither Bilibili nor WeChat.
   */
  deliver(answer: RelayAnswer): Promise<RelayDelivery> {
    // Taken at once: the relay calls deliver in the same tick as onTurnEnd, before the next wake can record an origin.
    const origin = this.ended.get(answer.sessionId)
    this.ended.delete(answer.sessionId)
    return this.host.hold(this.send(answer, origin))
  }

  /** Send one answer by the channel of the wake that started its turn. */
  private async send(answer: RelayAnswer, origin: WakeOrigin | undefined): Promise<RelayDelivery> {
    const { sessionId } = answer
    const ended = endedText(answer)
    if (origin === undefined) {
      // The owner talking to the Session in the Web UI reads the answer there.
      this.host.logger.info(`bili: Session ${sessionId} ended a turn no wake started (${ended}); its answer stays in the Session`)
      return 'kept'
    }
    const action: DmAction = origin.owner ? 'dmReply' : 'dmOwner'
    const sending = `sending ${answer.text.length} chars to the owner (${action})`
    this.host.logger.info(`bili: Session ${sessionId} ended a ${origin.reason} turn (${ended}); ${sending}`)
    const parts = splitMessage(answer.text, TEXT_LIMITS[action], 2)
    for (const [index, part] of parts.entries()) {
      const outcome = await this.host.messageOwner(action, part, ANSWER_WAIT_MS)
      if (outcome.outcome !== 'sent') {
        await this.fallback(parts.slice(index).join('\n\n'), refusalLine(outcome))
        return 'sent'
      }
    }
    this.host.logger.info(`bili: sent the turn's answer to the owner as ${parts.length} Bilibili message(s) (${action})`)
    return 'sent'
  }

  /** Send what could not go out as a Bilibili message to WeChat, ending with a line that says why. */
  private async fallback(text: string, why: string): Promise<void> {
    this.host.logger.warn(`bili: the answer goes to WeChat instead of a Bilibili message: ${why}`)
    const notifier = this.host.notifier()
    if (notifier === undefined) throw new Error('no lsyNotifier is mounted')
    await notifier.send({ title: FALLBACK_TITLE, body: `${text}\n\n${why}`, origin: BILI_FALLBACK_LABEL })
    // Delivered to the owner, so a video link in it was shared.
    this.host.reportShares(text)
  }
}
