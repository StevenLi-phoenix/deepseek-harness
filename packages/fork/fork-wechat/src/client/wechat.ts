/**
 * The WeChat section's store, loader, and pollers: one status request at a time shared by every
 * caller, the last view kept through failures, and the QR login driven by posts to the same route.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LOGIN_OPEN, type LoginSnapshot, type WechatAction, type WechatAnswer, type WechatView } from '../view.ts'

export type { LoginSnapshot, WechatAction, WechatAnswer, WechatView } from '../view.ts'

/** How often the open section refreshes the status. */
export const POLL_INTERVAL_MS = 5000
/** How often an open login is polled. */
export const LOGIN_POLL_INTERVAL_MS = 2000

/** An answer the route refused, with its HTTP status. */
export class WechatRefused extends Error {
  /**
   * @param message - the route's error text.
   * @param status - HTTP status.
   */
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'WechatRefused'
  }
}

/** The actions the page sends, named as the route names them. */
export type ActionName = WechatAction['action']

/** What the section renders. */
export interface WechatState {
  /** The last view the Host answered; a failed refresh keeps it. */
  view: WechatView | null
  /** Time of the last settled status request, answered or not. */
  checkedAt: number | null
  /** The last status request failed, so `view` (if any) is older than `checkedAt`. */
  stale: boolean
  /** The login the QR panel shows; null while no panel is open. */
  login: LoginSnapshot | null
  /** The action in flight that the owner started. */
  busy: ActionName | null
  /** Why the last owner action failed. */
  error: string | null
}

/**
 * A store for the section.
 * @returns a store holding the not-yet-loaded state.
 */
export function createWechatStore(): SnapshotStore<WechatState> {
  return createSnapshotStore<WechatState>({ view: null, checkedAt: null, stale: false, login: null, busy: null, error: null })
}

/**
 * Whether a login still needs polling.
 * @param login - the login the panel shows, if any.
 * @returns true while the login waits for a scan, a confirmation, or a number.
 */
export function loginIsOpen(login: LoginSnapshot | null): boolean {
  return login !== null && LOGIN_OPEN.includes(login.phase)
}

/** Whether a value is an object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Check a route answer's outer fields. The Host half of this package wrote the body, so its fields
 * are this package's own contract.
 * @param body - the parsed JSON body.
 * @returns the answer.
 */
export function parseAnswer(body: unknown): WechatAnswer {
  const fields = isRecord(body) ? body : {}
  const view = fields['view']
  const login = fields['login']
  if (!isRecord(view) || !isRecord(view['binding']) || !isRecord(view['channel']) || !isRecord(view['window']) || !isRecord(view['outbox']) || typeof view['timeZone'] !== 'string') {
    throw new Error('unexpected WeChat answer')
  }
  if (login !== null && (!isRecord(login) || typeof login['key'] !== 'string' || typeof login['phase'] !== 'string')) throw new Error('unexpected WeChat answer')
  return body as WechatAnswer
}

/** Reads the view into a store, one status request at a time, and drives the login and unbind posts. */
export class WechatLoader {
  private inFlight: Promise<void> | undefined

  /**
   * @param store - the store the section renders.
   * @param read - one GET of the route; rejects on transport failure.
   * @param post - one action; resolves with the answer, rejects with {@link WechatRefused} when the route refused.
   * @param now - clock, replaceable in tests.
   */
  constructor(
    private readonly store: SnapshotStore<WechatState>,
    private readonly read: () => Promise<WechatAnswer>,
    private readonly post: (action: WechatAction) => Promise<WechatAnswer>,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Read the status once.
   * @returns settlement after the answer is published; concurrent callers share the request in flight.
   */
  refresh(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight
    const request = this.query().finally(() => { this.inFlight = undefined })
    this.inFlight = request
    return request
  }

  /** Open the QR panel: ask the Host for a login and show its first code. */
  startLogin(): Promise<void> {
    return this.act('login.start', { action: 'login.start' }, (answer) => {
      this.store.update((draft) => { draft.login = answer.login })
    })
  }

  /** Read the open login; a background request that never marks the page busy. */
  async pollLogin(): Promise<void> {
    const login = this.openLogin()
    if (login === undefined) return
    try {
      const answer = await this.post({ action: 'login.poll', key: login.key })
      this.publish(answer)
      this.adoptLogin(login.key, answer)
    } catch (error: unknown) {
      if (error instanceof WechatRefused && error.status === 404) this.closeLogin(login.key)
      // A transport failure leaves the panel as it is; the next poll tries again.
    }
  }

  /**
   * Hand the login the number WeChat shows.
   * @param code - digits, as typed.
   */
  submitCode(code: string): Promise<void> {
    const login = this.store.getSnapshot().login
    if (login === null) return Promise.resolve()
    return this.act('login.code', { action: 'login.code', key: login.key, code }, (answer) => { this.adoptLogin(login.key, answer) })
  }

  /** End the open login and close the panel. */
  async cancelLogin(): Promise<void> {
    const login = this.openLogin()
    this.store.update((draft) => { draft.login = null; draft.error = null })
    if (login === undefined) return
    try {
      await this.post({ action: 'login.cancel', key: login.key })
    } catch {
      // The login times out by itself on the Host if the cancel did not arrive.
    }
  }

  /** Close the panel of a login that is over. */
  dismissLogin(): void {
    this.store.update((draft) => { draft.login = null; draft.error = null })
  }

  /** Unbind the bot; the Host keeps the account file as a backup. */
  unbind(): Promise<void> {
    return this.act('unbind', { action: 'unbind', confirm: 'unbind' }, () => {
      this.store.update((draft) => { draft.login = null })
    })
  }

  /** @returns the login the panel shows while it still needs polling, else undefined. */
  private openLogin(): LoginSnapshot | undefined {
    const login = this.store.getSnapshot().login
    return login !== null && loginIsOpen(login) ? login : undefined
  }

  /** Run one owner action: busy at once, then its answer or its error. */
  private async act(name: ActionName, action: WechatAction, after: (answer: WechatAnswer) => void): Promise<void> {
    this.store.update((draft) => {
      draft.busy = name
      draft.error = null
    })
    try {
      const answer = await this.post(action)
      this.publish(answer)
      after(answer)
    } catch (error: unknown) {
      this.store.update((draft) => { draft.error = error instanceof Error ? error.message : String(error) })
    } finally {
      this.store.update((draft) => { draft.busy = null })
    }
  }

  /** Publish an answer's view. */
  private publish(answer: WechatAnswer): void {
    const at = this.now()
    this.store.update((draft) => {
      draft.view = answer.view
      draft.checkedAt = at
      draft.stale = false
    })
  }

  /**
   * Show the login an answer carries, unless the owner has moved on to another one or closed the panel.
   * @param key - the login the request was about.
   * @param answer - the Host's answer.
   */
  private adoptLogin(key: string, answer: WechatAnswer): void {
    this.store.update((draft) => { if (draft.login?.key === key && answer.login !== null) draft.login = answer.login })
  }

  /** Drop the panel of a login the Host no longer knows. */
  private closeLogin(key: string): void {
    this.store.update((draft) => { if (draft.login?.key === key) draft.login = null })
  }

  private async query(): Promise<void> {
    let answer: WechatAnswer | undefined
    try {
      answer = await this.read()
    } catch {
      // Warn when the view goes stale, not on every poll after that.
      if (!this.store.getSnapshot().stale) console.warn('[fork-wechat] status read failed')
    }
    const at = this.now()
    this.store.update((draft) => {
      draft.checkedAt = at
      draft.stale = answer === undefined
      if (answer !== undefined) draft.view = answer.view
    })
  }
}

/** The part of `document` the poller watches. */
export interface VisibilitySource {
  readonly visibilityState: DocumentVisibilityState
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

/** @returns the browser document, or null outside a browser. */
function currentPage(): VisibilitySource | null {
  return 'document' in globalThis ? globalThis.document : null
}

/**
 * Refresh now and every `intervalMs` while the page is visible; a hidden page
 * stops the timer and showing it again refreshes at once.
 * @param refresh - one refresh; the loader shares a request in flight.
 * @param intervalMs - polling period.
 * @param page - visibility source; null polls without one.
 * @returns a stop function.
 */
export function startPolling(refresh: () => void, intervalMs: number, page: VisibilitySource | null = currentPage()): () => void {
  let timer: ReturnType<typeof setInterval> | undefined
  const run = (): void => {
    if (timer !== undefined) return
    refresh()
    timer = setInterval(refresh, intervalMs)
  }
  const pause = (): void => {
    if (timer === undefined) return
    clearInterval(timer)
    timer = undefined
  }
  const onVisibility = (): void => {
    if (page?.visibilityState === 'hidden') pause()
    else run()
  }
  page?.addEventListener('visibilitychange', onVisibility)
  onVisibility()
  return () => {
    page?.removeEventListener('visibilitychange', onVisibility)
    pause()
  }
}
