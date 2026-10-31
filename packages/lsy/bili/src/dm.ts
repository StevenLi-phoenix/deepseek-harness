/**
 * The account's DM channel (`bili-dm`) of `ctx.ownerRelay`: the final answer of each turn the
 * owner's own Bilibili messages started goes back to the owner through bili-svc's Reply Gate
 * (`POST /v1/reply/dm`), and whatever the Gate does not send (held, blocked, or no answer) goes to
 * WeChat with the reason, labelled for the owner's chat Session as the account's. Turns nothing
 * started (the owner in the Web UI, a reminder) keep their answer in the Session. The account
 * never messages the owner on its own initiative.
 */
// Type-only: the ctx.lsyNotifier contract and the relay's channel contract.
import type { LsyNotifier } from '@deepseek-ai/dsh-lsy-event-bus'
import type { RelayAnswer, RelayChannel, RelayDecision, RelayDelivery } from '@deepseek-ai/dsh-owner-relay'
import { FALLBACK_TITLE, REPLY_CHARS, splitMessage } from './text.ts'

/** Name of the account's channel in `ctx.ownerRelay`. */
export const BILI_RELAY_CHANNEL = 'bili-dm'
/** How the owner's WeChat chat Session reads an answer of the account that came to WeChat instead. */
export const BILI_FALLBACK_LABEL = 'the Bilibili account\'s Session (its answer could not go out as a Bilibili message)'
/** Who sent a message to the owner's main agent (`bili_tell_main_agent`), as the main agent reads it. */
export const BILI_AGENT_ORIGIN = 'the Bilibili account\'s Session (the agent that lives on its own Bilibili account and reads public Bilibili content)'

/** bili-svc's answer to one reply, or why there was none. */
export interface DmOutcome {
  /** `sent`, `held` or `blocked` by the Reply Gate, or `failed` (refused before it, or the outcome is unknown). */
  readonly status: 'sent' | 'held' | 'blocked' | 'failed'
  /** One line for the log and the WeChat fallback. */
  readonly detail: string
}

/** What the channel needs of the account. */
export interface DmChannelHost {
  /** Send one reply to the owner's main account through bili-svc's Reply Gate. */
  replyOwner(text: string): Promise<DmOutcome>
  /** Keep a delivery alive until the account's teardown drains it; its outcome stays the relay's. */
  hold<T>(work: Promise<T>): Promise<T>
  /** The WeChat notifier, read per use. */
  notifier(): Pick<LsyNotifier, 'send'> | undefined
  logger: { info(message: string): void; warn(message: string): void }
}

/** How a log line names the way a turn ended. */
function endedText(answer: RelayAnswer): string {
  return answer.detail === undefined ? answer.outcome : `${answer.outcome}: ${answer.detail}`
}

/**
 * The DM channel. The account marks a Session before it prompts it with the owner's messages; the
 * relay calls `onTurnEnd` when a turn ends, which takes that mark for the turn, and then `deliver`.
 */
export class DmChannel implements RelayChannel {
  readonly name = BILI_RELAY_CHANNEL
  readonly fallbackLabel = BILI_FALLBACK_LABEL
  /** Sessions whose next or running turn answers the owner's messages, marked before the prompt. */
  private readonly owed = new Set<string>()
  /** Sessions whose turn that answers the owner just ended, from `onTurnEnd` to the `deliver` that follows it in the same tick. */
  private readonly ended = new Set<string>()

  /** @param host - the account's reply sending, teardown hold, notifier, and logger. */
  constructor(private readonly host: DmChannelHost) {}

  /**
   * Mark a Session's next turn as the answer to the owner's messages, before its prompt.
   * @param sessionId - the account's Session.
   */
  expectReply(sessionId: string): void {
    this.owed.add(sessionId)
  }

  /**
   * Forget a mark whose prompt failed.
   * @param sessionId - the account's Session.
   */
  dropReply(sessionId: string): void {
    this.owed.delete(sessionId)
  }

  /**
   * A turn ended: it takes the mark, whether or not the relay delivers anything, so a later turn
   * the owner's messages did not start (the owner in the Web UI) never inherits it.
   * @param sessionId - the account's Session.
   * @param ended - the relay's decision for the turn.
   */
  onTurnEnd(sessionId: string, ended: RelayDecision['kind']): void {
    const owed = this.owed.delete(sessionId)
    this.ended.delete(sessionId)
    if (owed && ended === 'answer') this.ended.add(sessionId)
  }

  /**
   * Send a turn's answer to the owner as replies through bili-svc: at most two messages of 500
   * characters; whatever the Gate does not send goes to WeChat with the reason.
   * @param answer - the answer the relay decided on.
   * @returns `kept` for a turn the owner's messages did not start, else `sent`.
   * @throws when part of the answer reached neither Bilibili nor WeChat.
   */
  deliver(answer: RelayAnswer): Promise<RelayDelivery> {
    // Taken at once: the relay calls deliver in the same tick as onTurnEnd, before the next prompt can mark the Session.
    const owed = this.ended.delete(answer.sessionId)
    return this.host.hold(this.send(answer, owed))
  }

  /** Send one answer, or keep it in the Session. */
  private async send(answer: RelayAnswer, owed: boolean): Promise<RelayDelivery> {
    const { sessionId } = answer
    const ended = endedText(answer)
    if (!owed) {
      this.host.logger.info(`bili: Session ${sessionId} ended a turn the owner's messages did not start (${ended}); its answer stays in the Session`)
      return 'kept'
    }
    this.host.logger.info(`bili: Session ${sessionId} ended a reply turn (${ended}); sending ${answer.text.length} chars to the owner through bili-svc`)
    const parts = splitMessage(answer.text, REPLY_CHARS, 2)
    for (const [index, part] of parts.entries()) {
      const outcome = await this.host.replyOwner(part)
      if (outcome.status !== 'sent') {
        await this.fallback(parts.slice(index).join('\n\n'), `原因：${outcome.detail}`)
        return 'sent'
      }
    }
    this.host.logger.info(`bili: sent the turn's answer to the owner as ${parts.length} Bilibili message(s) through bili-svc`)
    return 'sent'
  }

  /** Send what could not go out as a Bilibili message to WeChat, ending with a line that says why. */
  private async fallback(text: string, why: string): Promise<void> {
    this.host.logger.warn(`bili: the answer goes to WeChat instead of a Bilibili message: ${why}`)
    const notifier = this.host.notifier()
    if (notifier === undefined) throw new Error('no lsyNotifier is mounted')
    await notifier.send({ title: FALLBACK_TITLE, body: `${text}\n\n${why}`, origin: BILI_FALLBACK_LABEL })
  }
}
