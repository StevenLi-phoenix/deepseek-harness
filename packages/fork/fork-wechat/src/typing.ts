/**
 * The "对方正在输入…" line in the owner's chat while the agent works. The server
 * drops a typing status after a few seconds, so an active indicator sends it
 * again every {@link TYPING_KEEPALIVE_MS}, and gives up after
 * {@link TYPING_MAX_MS} in case the end of the work is never seen. Typing is
 * cosmetic: every failure is logged once per streak and never reaches a reply.
 */

import { TypingStatus, type TypingStatusValue } from './api.ts'

/** Resend period of an active indicator. */
export const TYPING_KEEPALIVE_MS = 5000
/** Longest an indicator stays on without being stopped. */
export const TYPING_MAX_MS = 60 * 60_000
/** How long a typing ticket is reused before it is fetched again. */
const TICKET_TTL_MS = 24 * 60 * 60_000
/** First wait after a failed ticket fetch; doubles up to {@link MAX_RETRY_MS}. */
const FIRST_RETRY_MS = 30_000
const MAX_RETRY_MS = 60 * 60_000

/** What the indicator needs from the channel. */
export interface TypingIo {
  /** Fetch a typing ticket for the owner; throws when there is none. */
  fetchTicket(): Promise<string>
  /** Send one status with a ticket. */
  send(ticket: string, status: TypingStatusValue): Promise<void>
  /** Log a failure; called once per failing streak. */
  warn(message: string): void
  /** Note a freshly fetched ticket (about once a day). */
  fetched?(): void
}

/** Human-readable error text. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One owner's typing indicator. `start` and `stop` may be called any number of times. */
export class TypingIndicator {
  private active = false
  /** Bumped on every start and stop, so a slow ticket fetch cannot revive a stopped indicator. */
  private generation = 0
  /** A typing status went out during this activation, so stopping owes a cancel. */
  private shown = false
  private keepalive: NodeJS.Timeout | undefined
  private deadline: NodeJS.Timeout | undefined
  private ticket: { value: string; until: number } | undefined
  private retryAt = 0
  private retryMs = FIRST_RETRY_MS
  private failing = false

  /**
   * @param io - ticket fetch, status send, and failure log.
   * @param now - clock, for tests.
   */
  constructor(private readonly io: TypingIo, private readonly now: () => number = Date.now) {}

  /** Whether the indicator is on. */
  get isActive(): boolean {
    return this.active
  }

  /** Turn the indicator on, or keep it on. Returns at once; sending happens in the background. */
  start(): void {
    if (this.active) return
    this.active = true
    this.shown = false
    const generation = ++this.generation
    this.deadline = setTimeout(() => { void this.stop() }, TYPING_MAX_MS)
    void this.show(generation)
  }

  /**
   * Turn the indicator off; sends a cancel when a typing status went out.
   * @returns after the cancel was attempted.
   */
  async stop(): Promise<void> {
    if (!this.active) return
    this.active = false
    this.generation += 1
    this.clearTimers()
    const ticket = this.ticket?.value
    if (!this.shown || ticket === undefined) return
    this.shown = false
    try {
      await this.io.send(ticket, TypingStatus.CANCEL)
    } catch (error: unknown) {
      this.fail(`cancel failed: ${errorText(error)}`)
    }
  }

  /** Forget the ticket, e.g. after the bound account changed. */
  forgetTicket(): void {
    this.ticket = undefined
    this.retryAt = 0
    this.retryMs = FIRST_RETRY_MS
  }

  /** Send the first typing status, then keep it alive while this activation lasts. */
  private async show(generation: number): Promise<void> {
    const ticket = await this.currentTicket()
    if (ticket === undefined || generation !== this.generation) return
    if (!await this.sendTyping(ticket, generation)) return
    this.keepalive = setInterval(() => { void this.sendTyping(ticket, generation) }, TYPING_KEEPALIVE_MS)
  }

  /** Send one typing status; a failure ends this activation's keepalive and drops the ticket. */
  private async sendTyping(ticket: string, generation: number): Promise<boolean> {
    if (generation !== this.generation) return false
    try {
      await this.io.send(ticket, TypingStatus.TYPING)
    } catch (error: unknown) {
      this.fail(`typing failed: ${errorText(error)}`)
      this.ticket = undefined
      if (this.keepalive !== undefined) clearInterval(this.keepalive)
      this.keepalive = undefined
      return false
    }
    if (generation !== this.generation) return false
    this.shown = true
    this.failing = false
    return true
  }

  /** The cached ticket, a fresh one, or undefined while a failed fetch backs off. */
  private async currentTicket(): Promise<string | undefined> {
    const now = this.now()
    if (this.ticket !== undefined && now < this.ticket.until) return this.ticket.value
    if (now < this.retryAt) return undefined
    try {
      const value = await this.io.fetchTicket()
      this.ticket = { value, until: this.now() + TICKET_TTL_MS }
      this.retryMs = FIRST_RETRY_MS
      this.failing = false
      this.io.fetched?.()
      return value
    } catch (error: unknown) {
      this.retryAt = this.now() + this.retryMs
      this.fail(`no typing ticket (${errorText(error)}); retrying in ${Math.round(this.retryMs / 1000)}s`)
      this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS)
      return undefined
    }
  }

  /** Log the first failure of a streak only. */
  private fail(message: string): void {
    if (this.failing) return
    this.failing = true
    this.io.warn(message)
  }

  private clearTimers(): void {
    if (this.keepalive !== undefined) clearInterval(this.keepalive)
    if (this.deadline !== undefined) clearTimeout(this.deadline)
    this.keepalive = undefined
    this.deadline = undefined
  }
}
