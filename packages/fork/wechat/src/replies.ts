/**
 * What the chat Sessions say to the owner: each turn's final answer that `ctx.ownerRelay` hands the `wechat` channel,
 * and in `hybrid` delivery the `wechat_send` texts of a running turn, which its final answer does not repeat.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RelayAnswer, RelayDelivery } from '@deepseek-ai/dsh-owner-relay'
import type { DeliveryView } from '@deepseek-ai/dsh-wechat-settings/wechat-view'
import type { ChatSessions } from './chat.ts'
import type { Config } from './index.ts'
import type { Outbox } from './outbox.ts'
import type { OutgoingFiles } from './outgoing.ts'
import { EARLIER_CHAT } from './text.ts'
import type { ChatTurns } from './turns.ts'
import type { ReplyWindow } from './window.ts'

/** Outcome of {@link ChatReplies.sendText}: what became of the text, or why it was refused. */
export type SendTextResult =
  | { readonly sent: number; readonly queued: number; readonly held: boolean; readonly why?: string; readonly repliesLeft: number | null }
  | { readonly notSent: string }

/** Texts compared for repetition ignore whitespace differences. */
function sameText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** What {@link ChatReplies} needs of the channel. */
export interface ChatRepliesDeps {
  readonly turns: ChatTurns
  readonly outgoing: Pick<OutgoingFiles, 'planInlinePictures' | 'sendInlinePictures'>
  readonly outbox: Pick<Outbox, 'deliver' | 'holdsReply'>
  readonly chat: Pick<ChatSessions, 'isCurrentChat' | 'ownsSession' | 'shareWithChat'>
  /** Tells how many replies the window has left. */
  readonly window: Pick<ReplyWindow, 'status'>
  readonly config: Pick<Config, 'chat' | 'maxSendsPerTurn'>
  readonly logger: Context['logger']
}

/** Final answers and `wechat_send` texts on their way to the owner. */
export class ChatReplies {
  /** Hybrid delivery's counters since this process started, for the Settings page and the log. */
  private readonly toolStats = { sends: 0, repeats: 0 }

  /** @param deps - the running turns, the delivery path, the chat Sessions, and log. */
  constructor(private readonly deps: ChatRepliesDeps) {}

  /**
   * Hybrid delivery's counters for the Settings page.
   * @returns `wechat_send` texts sent, and final answers not sent because they repeated one.
   */
  stats(): Pick<DeliveryView, 'toolSends' | 'repeatsSkipped'> {
    return { toolSends: this.toolStats.sends, repeatsSkipped: this.toolStats.repeats }
  }

  /**
   * Deliver a chat Session's answer that the relay handed over. A chat Session the owner left with
   * /new can still answer (a turn it was running, or a background job it started; its reminders and
   * monitors moved to the new chat): the current chat Session gets a copy, since the owner's reply
   * to it lands there.
   * @param answer - the turn's final answer and its assistant messages.
   * @returns `sent` once the text was sent or durably queued.
   */
  async relayAnswer(answer: RelayAnswer): Promise<RelayDelivery> {
    const { turns, outgoing, outbox, chat, logger } = this.deps
    const urgent = turns.endUrgent(answer.sessionId)
    const sentTexts = turns.sent(answer.sessionId)?.texts
    // Each assistant message of the turn goes out as its own WeChat message, in order; one a `wechat_send` already carried is left out.
    const messages = (answer.parts ?? [answer.text]).filter(part => sentTexts?.has(sameText(part)) !== true)
    if (messages.length === 0) {
      this.toolStats.repeats += 1
      logger.info(`wechat: Session ${answer.sessionId}'s final answer repeats a wechat_send text; not sent again (${this.toolStats.repeats} so far)`)
      return 'sent'
    }
    if (urgent) logger.info(`wechat: Session ${answer.sessionId}'s final answer ends an urgent turn; it passes the owner's sleep`)
    if (messages.length > 1) logger.info(`wechat: Session ${answer.sessionId}'s answer goes out as ${messages.length} messages`)
    for (const message of messages) {
      // WeChat shows no picture inside a text message: the message goes as text without its markdown
      // images, and each local picture follows as its own image message.
      const { text, pictures } = await outgoing.planInlinePictures(message, answer.sessionId)
      const held = text === ''
        ? await outbox.holdsReply(urgent)
        : (await outbox.deliver(text, 'reply', { urgent })).held
      if (text !== '') await chat.shareWithChat(text, EARLIER_CHAT, answer.sessionId)
      await outgoing.sendInlinePictures(answer.sessionId, pictures, held)
    }
    return 'sent'
  }

  /**
   * Send a text the agent wrote for the owner in the middle of a turn (`wechat_send`) through the same path as a relayed
   * answer; the window's last slot stays for the turn's final answer.
   * @param sessionId - the calling Session, for the per-turn cap and the repeat check; undefined outside a Session.
   * @param raw - the words for the owner.
   * @param options - `urgent` passes the owner's sleep.
   * @returns how many messages went out or wait and why, or why the text was refused.
   */
  async sendText(sessionId: string | undefined, raw: string, options: { urgent?: boolean }): Promise<SendTextResult> {
    const { turns, outbox, chat, window, config, logger } = this.deps
    if (config.chat.delivery !== 'hybrid') return { notSent: 'wechat_send is off (chat.delivery is text): put the words in your answer' }
    const text = raw.toWellFormed().trim()
    if (text === '') return { notSent: 'the text is empty' }
    const turn = sessionId === undefined ? undefined : turns.turnSends(sessionId)
    if (turn !== undefined && turn.count >= config.maxSendsPerTurn) {
      logger.info(`wechat: wechat_send refused for Session ${sessionId}: turn cap ${turn.count}/${config.maxSendsPerTurn}`)
      return { notSent: `this turn already sent ${turn.count} messages (the cap is ${config.maxSendsPerTurn}): put what is left into your final answer` }
    }
    const before = window.status().repliesLeft
    if (before !== null && before <= 1) {
      logger.info(`wechat: wechat_send refused for Session ${sessionId ?? 'none'}: ${before} reply left, kept for the final answer`)
      return { notSent: 'reply quota nearly used up; the last message is kept for your final answer' }
    }
    const own = sessionId === undefined || chat.ownsSession(sessionId)
    const report = await outbox.deliver(text, own ? 'reply' : 'note', { urgent: options.urgent === true })
    if (turn !== undefined) {
      turn.count += 1
      turn.texts.add(sameText(text))
    }
    this.toolStats.sends += 1
    // The owner's reply to a text lands in the current chat Session: it gets a copy of what another Session said.
    if (sessionId !== undefined && (!own || !chat.isCurrentChat(sessionId))) {
      await chat.shareWithChat(text, own ? EARLIER_CHAT : undefined, sessionId)
    }
    const repliesLeft = window.status().repliesLeft
    logger.info(`wechat: wechat_send session=${sessionId ?? 'none'} chars=${Array.from(text).length} parts=${report.parts} sent=${report.sent} queued=${report.queued.length} held=${report.held} urgent=${options.urgent === true} turnSends=${turn?.count ?? 0}/${config.maxSendsPerTurn} repliesLeft=${repliesLeft ?? 'n/a'}`)
    const why = report.queued[0]
    return { sent: report.sent, queued: report.queued.length, held: report.held, ...why === undefined ? {} : { why }, repliesLeft }
  }
}
