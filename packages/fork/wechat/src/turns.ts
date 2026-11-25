/**
 * The owned chat Sessions' running turns: which are running, what each sent with `wechat_send` and
 * `wechat_send_file`, which an urgent prompt started, and the owner's typing line while they work.
 */

import type { TypingIndicator } from './typing.ts'

/** How long typing stays on after a forwarded message when no chat turn starts. */
const TYPING_GRACE_MS = 60_000

/**
 * What a Session's running turn already sent: its `wechat_send` texts (the answer does not
 * repeat one) and its files (a markdown image of one is not sent twice).
 */
export interface TurnSends {
  count: number
  texts: Set<string>
  files: Set<string>
}

/** Per-turn state of the owned chat Sessions, fed by the relay's turn hooks. */
export class ChatTurns {
  /** Owned Sessions with a running turn. */
  private readonly working = new Set<string>()
  /** `wechat_send` use of each Session's running turn; empty in text delivery. */
  private readonly turns = new Map<string, TurnSends>()
  /** Urgent prompts queued per chat Session whose turn has not started; each starts one turn, in queue order. */
  private readonly urgentAsked = new Map<string, number>()
  /** Chat Sessions whose running turn an urgent prompt started: its final answer passes the owner's sleep. */
  private readonly urgentTurns = new Set<string>()
  /** Stops typing when a forwarded message starts no chat turn. */
  private typingGrace: NodeJS.Timeout | undefined

  /** @param typing - the owner's typing line. */
  constructor(private readonly typing: Pick<TypingIndicator, 'start' | 'stop'>) {}

  /**
   * An owned Session started a turn: it is running, its send record starts empty, it takes an urgent mark when one waits,
   * and typing shows.
   * @param sessionId - the Session.
   */
  start(sessionId: string): void {
    this.working.add(sessionId)
    this.turns.delete(sessionId)
    this.startUrgentTurn(sessionId)
    this.clearTypingGrace()
    this.typing.start()
  }

  /**
   * An owned Session's turn ended.
   * @param sessionId - the Session.
   */
  end(sessionId: string): void {
    this.working.delete(sessionId)
  }

  /**
   * The owned Sessions with a running turn.
   * @returns their ids, in the order their turns started.
   */
  running(): string[] {
    return [...this.working]
  }

  /**
   * The send record of a Session's running turn, created on first use.
   * @param sessionId - the Session.
   * @returns the record, which the caller updates.
   */
  turnSends(sessionId: string): TurnSends {
    let turn = this.turns.get(sessionId)
    if (turn === undefined) {
      turn = { count: 0, texts: new Set(), files: new Set() }
      this.turns.set(sessionId, turn)
    }
    return turn
  }

  /**
   * What a Session's running turn sent so far, without creating a record.
   * @param sessionId - the Session.
   * @returns the record, or undefined when the turn sent nothing.
   */
  sent(sessionId: string): TurnSends | undefined {
    return this.turns.get(sessionId)
  }

  /**
   * Count one urgent prompt queued in a chat Session; the next turn it starts is urgent.
   * @param sessionId - the chat Session.
   */
  askUrgent(sessionId: string): void {
    this.urgentAsked.set(sessionId, (this.urgentAsked.get(sessionId) ?? 0) + 1)
  }

  /**
   * Count one queued urgent prompt of a chat Session as taken.
   * @param sessionId - the chat Session.
   * @returns false when none was waiting.
   */
  takeUrgent(sessionId: string): boolean {
    const asked = this.urgentAsked.get(sessionId) ?? 0
    if (asked === 0) return false
    if (asked === 1) this.urgentAsked.delete(sessionId)
    else this.urgentAsked.set(sessionId, asked - 1)
    return true
  }

  /**
   * A chat Session started a turn: it is urgent when an urgent prompt waits in that Session. A turn the owner started first
   * takes the mark too, which changes nothing: the owner who just wrote counts as awake.
   */
  private startUrgentTurn(sessionId: string): void {
    if (this.takeUrgent(sessionId)) this.urgentTurns.add(sessionId)
    else this.urgentTurns.delete(sessionId)
  }

  /**
   * Take the urgent mark of a Session's ending turn.
   * @param sessionId - the Session whose final answer is delivered.
   * @returns whether an urgent prompt started that turn, so its answer passes the owner's sleep.
   */
  endUrgent(sessionId: string): boolean {
    return this.urgentTurns.delete(sessionId)
  }

  /** Show typing, or keep it on. */
  startTyping(): void {
    this.typing.start()
  }

  /**
   * Stop typing now.
   * @returns settlement once the cancel went out or failed.
   */
  stopTyping(): Promise<void> {
    return this.typing.stop()
  }

  /** Stop typing unless a chat turn is still running. */
  settleTyping(): void {
    if (this.working.size > 0) return
    this.clearTypingGrace()
    void this.typing.stop()
  }

  /** After a forward, stop typing if no chat turn has started within {@link TYPING_GRACE_MS}. */
  armTypingGrace(): void {
    this.clearTypingGrace()
    if (this.working.size > 0) return
    this.typingGrace = setTimeout(() => {
      this.typingGrace = undefined
      /* v8 ignore else -- the only working.add clears this grace timer. */
      if (this.working.size === 0) void this.typing.stop()
    }, TYPING_GRACE_MS)
  }

  /** Cancel the grace timer of {@link armTypingGrace}. */
  clearTypingGrace(): void {
    if (this.typingGrace !== undefined) clearTimeout(this.typingGrace)
    this.typingGrace = undefined
  }
}
