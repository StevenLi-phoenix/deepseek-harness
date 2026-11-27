/**
 * The capture: which messages reached the owner without the owner asking, and what the owner said next. It reads only
 * the Session log as it is committed, never message text, to decide who started a turn: a turn started only by inputs
 * that are not the owner's (a notice, a reminder, a watch event, a monitor line, another Session) whose answer went out
 * is a proactive message; a turn the owner started alone is a reply. Only Sessions the owner relay hands to the
 * configured channel count, since only their answers reach the owner.
 */

import { isSilentReply } from '@deepseek-ai/dsh-event-bus/prompt'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { triggerOf } from '@deepseek-ai/dsh-turn-taint/origin'
import type { Exchange, Reply } from './records.ts'
import { freshId } from './store.ts'

/** Characters kept of what the owner received. */
export const SENT_CHARS = 600
/** Characters kept of the owner's words in one turn. */
export const OWNER_CHARS = 400
/** Characters kept of the agent's answer to them. */
export const AGENT_CHARS = 200

/** Where captured messages and replies go. */
export interface CaptureSink {
  /** A proactive message went out. */
  readonly output: (exchange: Exchange) => void
  /** The owner's own turn ended. */
  readonly reply: (reply: Reply) => void
}

/** The open turn of one Session, as far as the capture needs it. */
interface OpenTurn {
  readonly triggers: string[]
  readonly owner: string[]
  readonly answers: string[]
  readonly sends: string[]
}

/** The text blocks of a message, joined. */
function textOf(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content.flatMap(block => block.type === 'text' && block.text !== undefined ? [block.text] : []).join('\n').trim()
}

/** The first `limit` characters of a text. */
function clip(text: string, limit: number): string {
  const chars = Array.from(text)
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : text
}

/** The `text` argument of a `wechat_send` call, or undefined. */
function sendText(json: string): string | undefined {
  try {
    const text = (JSON.parse(json) as { text?: unknown } | null)?.text
    return typeof text === 'string' && text.trim() !== '' ? text.trim() : undefined
  } catch {
    // A call whose arguments do not parse never ran; nothing was sent.
    return undefined
  }
}

/** Follows the owner's chat Sessions and reports proactive messages and replies. */
export class Capture {
  readonly #open = new Map<string, OpenTurn>()

  /**
   * @param channel - the owner relay channel whose Sessions count (`wechat`).
   * @param ownerOf - the channel that relays a Session, from `ctx.ownerRelay`.
   * @param sink - receives each message and reply.
   * @param now - the clock.
   */
  constructor(
    private readonly channel: string,
    private readonly ownerOf: (sessionId: string) => string | undefined,
    private readonly sink: CaptureSink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Take one committed event.
   * @param session - the Session whose log grew.
   * @param event - the event.
   */
  observe(session: Session, event: SessionEvent): void {
    if (session.header.origin === 'subagent') return
    if (event.type === 'turn/start') {
      this.#open.set(session.id, { triggers: [], owner: [], answers: [], sends: [] })
      return
    }
    const turn = this.#open.get(session.id)
    if (turn === undefined) return
    switch (event.type) {
      case 'user/message': {
        const label = triggerOf(event.data.source)
        if (label === undefined) return
        turn.triggers.push(label)
        if (label === 'owner') turn.owner.push(textOf(event.data.content))
        return
      }
      case 'assistant/message': {
        const text = textOf(event.data.message.content)
        if (text !== '') turn.answers.push(text)
        return
      }
      case 'tool/call': {
        const text = event.data.name === 'wechat_send' ? sendText(event.data.arguments) : undefined
        if (text !== undefined) turn.sends.push(text)
        return
      }
      case 'turn/end':
        this.#open.delete(session.id)
        if (this.ownerOf(session.id) === this.channel) this.finish(session.id, turn)
        return
      // Other events neither start an input nor carry what the owner receives.
      default:
        return
    }
  }

  /** Report a finished turn of a channel Session. */
  private finish(sessionId: string, turn: OpenTurn): void {
    if (turn.triggers.length === 0) return
    const at = this.now().toISOString()
    if (turn.triggers.every(label => label === 'owner')) {
      const owner = turn.owner.filter(text => text !== '').join('\n')
      if (owner === '') return
      this.sink.reply({ at, owner: clip(owner, OWNER_CHARS), agent: clip(turn.answers.join('\n'), AGENT_CHARS) })
      return
    }
    // A turn the owner joined is the owner's conversation, not a message they did not ask for.
    if (turn.triggers.some(label => label === 'owner' || label === 'guest')) return
    const answered = isSilentReply(turn.answers.at(-1)) ? [] : turn.answers
    const sent = [...turn.sends, ...answered].join('\n')
    if (sent === '') return
    this.sink.output({ id: freshId('x'), session: sessionId, at, trigger: [...new Set(turn.triggers)].join('+'), sent: clip(sent, SENT_CHARS), replies: [] })
  }
}
