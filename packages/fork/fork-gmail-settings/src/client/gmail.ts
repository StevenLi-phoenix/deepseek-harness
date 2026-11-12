/**
 * The section's store and loader: one status read at a time shared by every caller, the last answer kept through
 * failures, and one owner action at a time whose answer replaces the status. Also the text the cards show, decided
 * without a DOM.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { GMAIL_OAUTH_PATH, GMAIL_PRIVACY_PATH, type GmailAction, type GmailAnswer, type GmailView, type PendingRow, type PolicyView } from '../view.ts'
import type { GmailKey } from './locales.ts'

/** How often the open section refreshes; held messages arrive from WeChat turns. */
export const POLL_INTERVAL_MS = 15_000
/** The control key of the add-account form's sign-in, which a new id has no account card for. */
export const ADD_CONTROL = 'add'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

/** A failed action, under the control that ran it. A refusal carries the Host's words; the others show generic copy. */
export type ActionFailure =
  | { readonly control: string; readonly kind: 'refused'; readonly message: string }
  | { readonly control: string; readonly kind: 'failed' | 'offline' }

/** The last action that succeeded. */
export interface ActionDone {
  readonly control: string
  readonly action: GmailAction['action']
  /** What it acted on: the message's subject (its code when it has none), the account id, or empty for the client. */
  readonly target: string
}

/** What the section renders. */
export interface GmailState {
  view: GmailView | null
  /** When the last request settled, answered or not; relative times count from it. */
  at: number
  /** The last read failed, so `view` (if any) is older. */
  stale: boolean
  /** The control whose action is in flight; every action control is disabled meanwhile. */
  busy: string | null
  failure: ActionFailure | null
  done: ActionDone | null
}

/**
 * A store for the section.
 * @returns a store holding the not-yet-loaded state.
 */
export function createGmailStore(): SnapshotStore<GmailState> {
  return createSnapshotStore<GmailState>({ view: null, at: 0, stale: false, busy: null, failure: null, done: null })
}

/** A route answer that is not a success: a refusal whose words are safe to show, or a failure the log explains. */
export class RouteError extends Error {
  /**
   * @param kind - `refused` for a 400 with the Host's words, `failed` for anything else the Host answered.
   * @param message - the Host's words, or the HTTP status.
   */
  constructor(readonly kind: 'refused' | 'failed', message: string) {
    super(message)
    this.name = 'RouteError'
  }
}

/**
 * Check a status body's outer fields. The Host half of this package wrote it.
 * @param body - the parsed JSON body.
 * @returns the view.
 */
export function parseView(body: unknown): GmailView {
  const fields = typeof body === 'object' && body !== null ? body as Partial<Record<keyof GmailView, unknown>> : {}
  if (typeof fields.client !== 'object' || fields.client === null || !Array.isArray(fields.accounts) || !Array.isArray(fields.pending)
    || !Array.isArray(fields.activity) || !Array.isArray(fields.trustedRecipients) || typeof fields.maxSendsPerDay !== 'number'
    || typeof fields.confirmTtlHours !== 'number') {
    throw new RouteError('failed', 'unexpected Gmail answer')
  }
  return body as GmailView
}

/**
 * Check an action answer: the status, and for a sign-in the https page of Google to open.
 * @param body - the parsed JSON body.
 * @returns the answer.
 */
export function parseAnswer(body: unknown): GmailAnswer {
  const fields = typeof body === 'object' && body !== null ? body as Partial<Record<keyof GmailAnswer, unknown>> : {}
  const status = parseView(fields.status)
  if (fields.signInUrl === undefined) return { status }
  if (typeof fields.signInUrl !== 'string' || !fields.signInUrl.startsWith('https://')) throw new RouteError('failed', 'unexpected sign-in page')
  return { status, signInUrl: fields.signInUrl }
}

/**
 * The control an action belongs to, so its pending label and its failure show beside it.
 * @param action - the action.
 * @returns `client`, `<action>:<account>`, or `<action>:<code>`.
 */
export function controlOf(action: GmailAction): string {
  if (action.action === 'client') return 'client'
  if ('account' in action) return `${action.action}:${action.account}`
  return `${action.action}:${action.code}`
}

function targetOf(action: GmailAction, view: GmailView | null): string {
  if (action.action === 'client') return ''
  if ('account' in action) return action.account
  const subject = view?.pending.find(row => row.code === action.code)?.subject ?? ''
  return subject === '' ? action.code : subject
}

/** Reads the status into the store, and posts the owner's actions. */
export class GmailLoader {
  private inFlight: Promise<void> | undefined
  /** Bumped by each applied action answer, so a read that started before it never overwrites it. */
  private generation = 0

  /**
   * @param store - the store the section renders.
   * @param read - `GET api/fork.gmail`.
   * @param post - `POST api/fork.gmail`; rejects with a {@link RouteError} for an answered failure, anything else offline.
   * @param navigate - opens a sign-in page in this tab.
   * @param now - clock, replaceable in tests.
   */
  constructor(
    private readonly store: SnapshotStore<GmailState>,
    private readonly read: () => Promise<GmailView>,
    private readonly post: (action: GmailAction) => Promise<GmailAnswer>,
    private readonly navigate: (url: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Read the status once.
   * @returns settlement after the answer is published; concurrent callers share the request in flight.
   */
  refresh(): Promise<void> {
    // `finally` runs in a later microtask, so the request is stored before it clears itself.
    this.inFlight ??= this.query().finally(() => { this.inFlight = undefined })
    return this.inFlight
  }

  /**
   * Post one owner action and show the status it answers; a sign-in then opens Google's page. Nothing happens while
   * another action is in flight.
   * @param action - the action.
   * @param control - the control showing its pending state and failure; derived from the action when omitted.
   * @returns whether the Host did it.
   */
  async act(action: GmailAction, control: string = controlOf(action)): Promise<boolean> {
    const before = this.store.getSnapshot()
    if (before.busy !== null) return false
    this.store.update((draft) => {
      draft.busy = control
      draft.failure = null
      draft.done = null
    })
    const started = this.now()
    let answer: GmailAnswer
    try {
      answer = await this.post(action)
    } catch (error: unknown) {
      const failure: ActionFailure = error instanceof RouteError && error.kind === 'refused'
        ? { control, kind: 'refused', message: error.message }
        : { control, kind: error instanceof RouteError ? 'failed' : 'offline' }
      // The action's name and the failure class only: a client action's body holds the OAuth client secret.
      console.warn(`[fork-gmail-settings] ${action.action} ${failure.kind} after ${this.now() - started} ms`)
      this.store.update((draft) => {
        draft.busy = null
        draft.failure = failure
      })
      return false
    }
    const url = answer.signInUrl
    const opened = action.action !== 'sign-in' || url !== undefined
    this.generation += 1
    const at = this.now()
    this.store.update((draft) => {
      draft.view = answer.status
      draft.at = at
      draft.stale = false
      draft.busy = null
      if (opened) draft.done = { control, action: action.action, target: targetOf(action, before.view) }
      else draft.failure = { control, kind: 'failed' }
    })
    console.debug(`[fork-gmail-settings] ${action.action} answered in ${at - started} ms`)
    if (url !== undefined) this.navigate(url)
    return opened
  }

  private async query(): Promise<void> {
    const generation = this.generation
    let view: GmailView | undefined
    try {
      view = await this.read()
    } catch {
      // Warn when the reading goes stale, not on every refresh after that.
      if (!this.store.getSnapshot().stale) console.warn('[fork-gmail-settings] Gmail status read failed')
    }
    // An action answered while this read was out: its status is newer.
    if (generation !== this.generation) return
    const at = this.now()
    this.store.update((draft) => {
      draft.at = at
      draft.stale = view === undefined
      if (view !== undefined) draft.view = view
    })
  }
}

/** The section's `t`. */
export type Translate = (key: GmailKey, params?: Record<string, string | number>) => string

/**
 * A formatter of instants in the browser's locale and zone, as `11/12 14:03` (or the locale's order).
 * @returns the formatter; make one per render.
 */
export function timeFormatter(): (at: number) => string {
  const format = new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return at => format.format(at)
}

/**
 * How far an instant is from now, as `3 小时后` or `5 分钟前`; under a minute is `刚刚`.
 * @param target - the instant.
 * @param now - the reference instant.
 * @param t - the section's copy.
 * @returns the phrase.
 */
export function relative(target: number, now: number, t: Translate): string {
  const future = target > now
  const minutes = Math.floor(Math.abs(target - now) / MINUTE_MS)
  if (minutes < 1) return t('rel.now')
  if (minutes < 60) return t(future ? 'rel.inMinutes' : 'rel.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return t(future ? 'rel.inHours' : 'rel.hoursAgo', { count: hours })
  return t(future ? 'rel.inDays' : 'rel.daysAgo', { count: Math.floor(hours / 24) })
}

/**
 * How long ago something happened; a Host clock ahead of the browser's reads as now.
 * @param at - the instant.
 * @param now - the reference instant.
 * @param t - the section's copy.
 * @returns the phrase.
 */
export function ago(at: number, now: number, t: Translate): string {
  return relative(Math.min(at, now), now, t)
}

/**
 * When a held message expires.
 * @param row - the held message.
 * @param ttlHours - `confirmTtlHours` of the status.
 * @returns Unix epoch milliseconds.
 */
export function expiresAt(row: PendingRow, ttlHours: number): number {
  return row.createdAt + ttlHours * HOUR_MS
}

/**
 * Whether a held message expires within six hours, so the card warns.
 * @param left - milliseconds until it expires.
 * @returns true when it is close.
 */
export function expiresSoon(left: number): boolean {
  return left < 6 * HOUR_MS
}

/**
 * The messages waiting for the owner, oldest first as the Host orders them.
 * @param view - the status.
 * @returns the held rows.
 */
export function heldRows(view: GmailView): PendingRow[] {
  return view.pending.filter(row => row.status === 'held')
}

/**
 * The latest resolved messages, newest first as the Host orders them.
 * @param view - the status.
 * @returns the sent, discarded, and expired rows.
 */
export function resolvedRows(view: GmailView): PendingRow[] {
  return view.pending.filter(row => row.status !== 'held')
}

/** The policy a new account starts with; `direct`, even for a bot, is only ever the owner's own pick. */
export const NEW_ACCOUNT_POLICY: PolicyView = 'confirm-untrusted'

/**
 * A loose address check for the sign-in hint; Google decides the rest.
 * @param text - the typed address.
 * @returns true when it has one `@` with text on both sides and no spaces.
 */
export function looksLikeAddress(text: string): boolean {
  return /^[^\s@]+@[^\s@]+$/u.test(text)
}

/**
 * Whether a pasted text is JSON, checked before it is posted. The parser's own error text quotes the input, which
 * here holds the client secret, so only the verdict leaves this function.
 * @param text - the pasted text.
 * @returns true when it parses.
 */
export function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    // SyntaxError: not JSON; its message quotes the secret-bearing input, so it is dropped.
    return false
  }
}

/**
 * The redirect URI to register at Google.
 * @param view - the status.
 * @param origin - this page's origin.
 * @returns the configured URI, or `<origin><GMAIL_OAUTH_PATH>`.
 */
export function redirectUriOf(view: GmailView, origin: string): string {
  return view.redirectUri ?? `${origin}${GMAIL_OAUTH_PATH}`
}

/**
 * The home page and privacy statement to enter in Google's app settings, on the redirect URI's origin.
 * @param uri - the redirect URI.
 * @param origin - this page's origin, used when the configured URI does not parse.
 * @returns both URLs.
 */
export function appPagesOf(uri: string, origin: string): { home: string; privacy: string } {
  let base = origin
  try {
    base = new URL(uri).origin
  } catch {
    // TypeError: a malformed configured URI, which the card already flags; this page's origin stands in.
  }
  return { home: `${base}/`, privacy: `${base}${GMAIL_PRIVACY_PATH}` }
}

/**
 * Whether Google accepts a redirect URI: https on a domain name, or http on localhost.
 * @param uri - the redirect URI.
 * @returns false for plain http elsewhere, an IP literal, a single-label host, or a malformed URI.
 */
export function redirectAccepted(uri: string): boolean {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    // TypeError: not a URL, which Google refuses as well.
    return false
  }
  if (url.protocol === 'http:') return url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  return url.protocol === 'https:' && url.hostname.includes('.') && !/^[\d.]+$/u.test(url.hostname)
}

/** Activity kinds the service writes, which the page names in the owner's language. */
const ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  'connected', 'removed', 'policy', 'sent', 'held', 'confirmed', 'discarded', 'expired', 'drafted', 'modified', 'refused', 'error', 'reconnect',
])
/** Activity kinds shown as warnings. */
const WARN_KINDS: ReadonlySet<string> = new Set(['refused', 'error', 'reconnect'])

/**
 * An activity row's kind in the owner's language; a kind the page has no copy for stays as written.
 * @param kind - the row's kind.
 * @param t - the section's copy.
 * @returns the name.
 */
export function activityKind(kind: string, t: Translate): string {
  return ACTIVITY_KINDS.has(kind) ? t(`activity.kind.${kind}` as GmailKey) : kind
}

/**
 * Whether an activity row is a warning.
 * @param kind - the row's kind.
 * @returns true for refusals, errors, and lost sign-ins.
 */
export function activityWarns(kind: string): boolean {
  return WARN_KINDS.has(kind)
}

/** The success line of each action. */
const DONE_KEY = {
  'client': 'done.client',
  'sign-in': 'done.signIn',
  'policy': 'done.policy',
  'remove': 'done.remove',
  'confirm': 'done.confirm',
  'discard': 'done.discard',
} as const satisfies Record<GmailAction['action'], GmailKey>

/**
 * What the last action did, as one line.
 * @param done - the last action that succeeded.
 * @param t - the section's copy.
 * @returns the line.
 */
export function doneLine(done: ActionDone, t: Translate): string {
  return t(DONE_KEY[done.action], { target: done.target })
}

/**
 * Why an action failed, as one line.
 * @param failure - the failure.
 * @param t - the section's copy.
 * @returns the Host's words for a refusal, otherwise generic copy.
 */
export function failureLine(failure: ActionFailure, t: Translate): string {
  if (failure.kind === 'refused') return failure.message
  return t(failure.kind === 'failed' ? 'error.generic' : 'error.offline')
}
