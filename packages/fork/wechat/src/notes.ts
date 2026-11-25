/**
 * Notes for the owner (`ctx.ownerNotifier.send()`) and messages another Session passes the main agent (`tellMainAgent()`):
 * each becomes a turn of the owner's chat Session, or reaches the owner as written.
 */

import { statSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { MainAgentMessage, OwnerNote } from '@deepseek-ai/dsh-event-bus'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { untrustedRequestId } from '@deepseek-ai/dsh-turn-taint/origin'
import type { ChatSessions } from './chat.ts'
import { errorText } from './errors.ts'
import type { Config } from './index.ts'
import type { Outbox } from './outbox.ts'
import { agentMessageText, fitText, noteTurnText, renderNote } from './text.ts'
import type { ChatTurns } from './turns.ts'

/** How long a mute file keeps the safety notices quiet, in milliseconds. */
const SAFETY_MUTE_MS = 30 * 60_000

/** What {@link OwnerNotes} needs of the channel. */
export interface OwnerNotesDeps {
  /** Host services: `ctx.sessionController`, `ctx.presence`, and the log. */
  readonly ctx: Context
  /** The operator's mute file for safety notices. */
  readonly muteFile: string
  readonly chat: Pick<ChatSessions, 'injectNotice' | 'openChat' | 'shareWithChat'>
  readonly outbox: Pick<Outbox, 'deliver'>
  /** Marks the turns urgent prompts start. */
  readonly turns: Pick<ChatTurns, 'askUrgent' | 'takeUrgent'>
  readonly config: Pick<Config, 'chat'>
  /** Aborts when the channel stops. */
  readonly signal: AbortSignal
}

/** Notes for the owner and messages for the main agent. */
export class OwnerNotes {
  /** @param deps - Host services, the chat Sessions, the delivery path, and the urgent marks. */
  constructor(private readonly deps: OwnerNotesDeps) {}

  /**
   * Deliver one notification for the owner, as a turn of the chat Session or as written.
   * @param note - title, optional body, optional link, and who sent it.
   * @returns resolves once the turn was queued, or the text was sent or durably queued.
   */
  async send(note: OwnerNote): Promise<void> {
    const { ctx, outbox, chat, config } = this.deps
    if (note.safety === true && this.safetyMuted()) {
      ctx.logger.info(`wechat: safety notice muted (${note.title.length + (note.body?.length ?? 0)} chars not sent; operator mute is on)`)
      return
    }
    const text = renderNote(note)
    const urgent = ctx.get('presence')?.isUrgent(note) ?? false
    if (note.safety !== true && config.chat.notes === 'turn' && await this.noteToMain(note, text, urgent)) return
    await outbox.deliver(text, 'note', { urgent, events: note.kinds })
    await chat.shareWithChat(text, note.origin)
  }

  /**
   * Give a note to the owner's main agent as a turn of the chat Session.
   * @returns false (logged) when there is no chat to take it or the Session refused the prompt, so the note goes as written.
   */
  private async noteToMain(note: OwnerNote, text: string, urgent: boolean): Promise<boolean> {
    const { ctx, config } = this.deps
    const events = note.kinds === undefined || note.kinds.length === 0 ? '' : ` (events ${note.kinds.join(' ')})`
    try {
      const framed = noteTurnText({ text, from: note.origin, urgent }, Date.now(), config.chat.timeZone)
      const sessionId = await this.queueAgentTurn(framed, 'note', urgent)
      ctx.logger.info(`wechat: passed a ${text.length}-char note${events} to chat Session ${sessionId}${urgent ? ' as urgent' : ''}; the main agent decides what the owner hears`)
      return true
    } catch (error: unknown) {
      ctx.logger.warn(`wechat: the main agent could not take a ${text.length}-char note${events} (${errorText(error)}); it goes to the owner as written`)
      return false
    }
  }

  /**
   * Queue a prompt that is not the owner's in the owner's current chat Session, creating one when there is none.
   * @param framed - the prompt text.
   * @param origin - the request-id label of its sender (`bili`, `cc`, `note`).
   * @param urgent - the turn it starts ends with an answer that passes the owner's sleep.
   * @returns the chat Session it was queued in.
   * @throws when no account is bound (there is no chat), or the Session refused the prompt.
   */
  private async queueAgentTurn(framed: string, origin: string, urgent: boolean): Promise<SessionId> {
    const { ctx, chat, turns, config } = this.deps
    const sessionId = await chat.openChat()
    // Counted before the prompt, whose turn can start before prompt() resolves.
    if (urgent) turns.askUrgent(sessionId)
    try {
      await ctx.sessionController.prompt({
        // The request id is how the Host later tells this turn from one the owner started.
        requestId: untrustedRequestId(origin) as SessionRequestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: framed }],
        clientTimeZone: config.chat.timeZone,
      }, this.deps.signal)
    } catch (error: unknown) {
      if (urgent) turns.takeUrgent(sessionId)
      throw error
    }
    return sessionId
  }

  /**
   * Whether the operator's mute switch is on: the file exists and was touched in the last 30 minutes (an old file
   * lapses by itself, so a forgotten mute cannot silence the safety notices for long).
   */
  private safetyMuted(): boolean {
    try {
      return Date.now() - statSync(this.deps.muteFile).mtimeMs < SAFETY_MUTE_MS
    } catch {
      return false
    }
  }

  /**
   * Pass a message from another of the agent's Sessions to the owner's current chat Session, as a queued prompt that
   * starts a turn or, with `chat.agentMessage: notify`, as a notice the owner hears about.
   * @param message - the text and who sent it, framed for the chat Session by {@link agentMessageText}.
   * @returns the chat Session the message was queued in.
   * @throws when no account is bound (there is no chat), or the Session refused the prompt.
   */
  async tellMainAgent(message: MainAgentMessage): Promise<SessionId> {
    const { ctx, outbox, chat, config } = this.deps
    if (config.chat.agentMessage === 'notify') {
      const sessionId = await chat.openChat()
      // The notice starts no turn, so it carries no urgent answer.
      const framed = agentMessageText({ text: message.text, from: message.from }, Date.now(), config.chat.timeZone)
      // No turn: the owner is told, the chat keeps the message as a notice, and the owner's reply decides what happens.
      const origin = message.origin ?? 'peer'
      await outbox.deliver(renderNote({
        title: `📨 ${origin === 'bili' ? 'B站猫猫' : origin === 'cc' ? 'Claude Code' : '另一个 Session'}给主 agent 递了话（没有开始处理）`,
        body: `${fitText(message.text.replaceAll(/\s+/gu, ' ').trim(), 300)}\n\n要我处理，直接回复我；不理它就当没看到。`,
      }), 'note', { urgent: message.urgent === true })
      if (!await chat.injectNotice(sessionId, framed, 'another Session messaged the main agent')) {
        throw new Error('the message could not be left in the chat Session')
      }
      ctx.logger.info(`wechat: told the owner about a ${message.text.length}-char message from another Session (${origin}); no turn started`)
      return sessionId
    }
    const framed = agentMessageText(message, Date.now(), config.chat.timeZone)
    const sessionId = await this.queueAgentTurn(framed, message.origin ?? 'peer', message.urgent === true)
    ctx.logger.info(`wechat: queued a ${message.text.length}-char message from another Session (${message.origin ?? 'peer'}) for chat Session ${sessionId}${message.urgent === true ? ' as urgent' : ''}`)
    return sessionId
  }
}
