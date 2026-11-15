/**
 * Control ownership between the agent and the user. The state is the single
 * authority for who may act: every acting tool asks {@link TakeoverState.assertAgent}
 * before touching the page, and the take-over page asks it before forwarding an
 * input event, so neither side fights the other.
 *
 * @module @deepseek-ai/dsh-headless-browser/takeover
 */

/** Who currently controls the browser. */
export type Holder = 'agent' | 'human'

/** The user holds the browser, so an agent action must wait. */
export class UserHoldsBrowserError extends Error {
  /** Reason the user gave when taking control, when they gave one. */
  readonly reason: string | undefined

  /**
   * @param reason - the user's stated reason, if any.
   */
  constructor(reason: string | undefined) {
    super(reason === undefined
      ? 'the user holds the browser; call headless_browser_hand_back when they are done'
      : `the user holds the browser (${reason}); call headless_browser_hand_back when they are done`)
    this.name = 'UserHoldsBrowserError'
    this.reason = reason
  }
}

/** Who holds control, and why the user took it. */
export interface TakeoverView {
  /** Current holder. */
  readonly holder: Holder
  /** The user's reason while they hold control; absent otherwise. */
  readonly reason?: string
}

/** One control change; listener errors cannot break the state transition. */
export type TakeoverListener = (view: TakeoverView) => void

/** Agent-versus-user control of one browser. */
export class TakeoverState {
  #holder: Holder = 'agent'
  #reason: string | undefined
  readonly #listeners = new Set<TakeoverListener>()

  /** Current holder. */
  get holder(): Holder {
    return this.#holder
  }

  /**
   * Who holds control, and why.
   * @returns the current holder and the user's reason while they hold it.
   */
  view(): TakeoverView {
    return this.#reason === undefined ? { holder: this.#holder } : { holder: this.#holder, reason: this.#reason }
  }

  /**
   * Move control to the user; taking again while they hold it only replaces the
   * stated reason. An action already running is refused by its next
   * {@link TakeoverState.assertAgent}, not cancelled, because a browser operation
   * must reach quiescence instead of being abandoned half-way.
   * @param reason - what the user is doing, shown to the agent when it asks again.
   */
  take(reason: string): void {
    const trimmed = reason.trim()
    const next = trimmed === '' ? undefined : trimmed
    const changed = this.#holder !== 'human' || this.#reason !== next
    this.#holder = 'human'
    this.#reason = next
    if (changed) this.#notify()
  }

  /**
   * Move control back to the agent.
   * @returns whether the holder changed; releasing while the agent holds control is a no-op.
   */
  release(): boolean {
    if (this.#holder === 'agent') return false
    this.#holder = 'agent'
    this.#reason = undefined
    this.#notify()
    return true
  }

  /**
   * Refuse an agent action while the user holds control.
   * @throws UserHoldsBrowserError - naming the user's reason, so the agent hands back instead of retrying.
   */
  assertAgent(): void {
    if (this.#holder === 'human') throw new UserHoldsBrowserError(this.#reason)
  }

  /**
   * Observe control changes.
   * @param listener - called after each change with the new state.
   * @returns the disposer that stops observing.
   */
  onChange(listener: TakeoverListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #notify(): void {
    const view = this.view()
    for (const listener of [...this.#listeners]) listener(view)
  }
}
