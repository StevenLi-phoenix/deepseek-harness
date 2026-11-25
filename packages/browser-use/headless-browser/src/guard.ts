/**
 * The action guard every mutating browser tool asks before it touches a page.
 * A page is data, never instructions: a site can ask the agent to tick a box
 * "to verify it is human", move money, or follow a link to another site, and
 * nothing in the page's own words should decide that. The guard answers three
 * questions with rules that do not read the page's prose:
 *
 * - can a person see and hit this element at all (a score from
 *   {@link scoreVisibility}, refused under {@link VISIBILITY_THRESHOLD});
 * - does its name or value say it destroys something or moves money
 *   ({@link SENSITIVE_ACTIONS}, which needs the owner unless the plugin's
 *   `sensitiveActions` switch turned it off);
 * - does the action leave the registrable domain the browser is on
 *   ({@link OriginGuard}, which needs an explicit `allowOrigin`).
 *
 * Every refusal — and every target the switched-off sensitive-name rule let
 * through — is recorded once as a {@link SecurityEvent}, kept in a bounded
 * list for the status route, and published to whoever listens. A tool result
 * that carries page text wraps it with {@link untrusted}, so the model reads
 * the page's words as data with an origin rather than as instructions.
 *
 * @module @deepseek-ai/dsh-headless-browser/guard
 */

import {
  scoreVisibility,
  VISIBILITY_THRESHOLD,
  type ElementFacts,
  type VisibilityFactor,
  type VisibilityScore,
} from './visibility.ts'

/** The rule that refused an action. */
export type GuardRule = 'visibility' | 'sensitive' | 'origin' | 'ax-id'

/**
 * The rule an event names: a refusal rule, `site-change` for a move the page
 * made itself, or `sensitive-name` for a target the switched-off sensitive-name
 * rule allowed. A refusal keeps `sensitive`, so a tool result reads the same
 * whether or not the switch exists.
 */
export type SecurityRule = GuardRule | 'site-change' | 'sensitive-name'

/** The action an event describes. */
export type GuardAction = 'open' | 'click' | 'type' | 'scroll' | 'eval' | 'navigate'

/** Whether an event is a refusal, an explicit allow (or a skipped rule), a page that moved itself, or a recorded coordinate click. */
export type SecurityKind = 'refusal' | 'allow' | 'drift' | 'point'

/** Most security events the status route keeps. */
export const SECURITY_EVENT_LIMIT = 50

/** One guard decision, as the status route and an event listener see it. */
export interface SecurityEvent {
  /** ISO 8601 time the event was recorded. */
  readonly at: string
  /** Refusal, explicit allow, an unrequested move to another site, or a recorded coordinate click. */
  readonly kind: SecurityKind
  /** The rule that decided, `site-change` for a drift, `sensitive-name` for a skip, or nothing for a recorded coordinate click. */
  readonly rule?: SecurityRule
  /** Set when a rule the plugin switched off would have refused the action but let it run instead. */
  readonly skipped?: boolean
  /** The action the agent asked for. */
  readonly action: GuardAction
  /** URL of the page the action started from, or the destination for a refusal to open one. */
  readonly url: string
  /** Selector, accessibility id, or point the agent named. */
  readonly ref: string
  /** Accessible name of the target, when there was one. */
  readonly name: string
  /** One short line saying why. */
  readonly reason: string
  /** Visibility score, for a refusal, a target that passed or was let through, or the element a point hit. */
  readonly score?: number
  /** Tab the action ran in, when the tool named one. */
  readonly tabId?: string
  /** Viewport point of a coordinate click, which has no selector to report. */
  readonly point?: { readonly x: number; readonly y: number }
}

/** A destructive or money-moving target that needs the owner unless the sensitive-name switch is off. */
export interface SensitiveAction {
  /** Short name used in the refusal, the event, and the tool result. */
  readonly label: string
  /** Words in the accessible name or value that mark the target. */
  readonly pattern: RegExp
}

/**
 * Targets a person must decide. Deliberately conservative: a false positive
 * costs one hand-over the owner can answer in seconds, while a false negative
 * costs an account or a payment, so a word like `submit` or `delete` is enough
 * even when it appears in a harmless place. The plugin's `sensitiveActions`
 * setting turns the refusal off for a task the owner supervises, and then only
 * the audit record remains.
 */
export const SENSITIVE_ACTIONS: readonly SensitiveAction[] = [
  { label: 'submit', pattern: /\bsubmit\b|提交/iu },
  { label: 'pay', pattern: /\bpay(?:ment|ments|ing)?\b|支付|付款/iu },
  { label: 'purchase', pattern: /\bpurchase\b|\bbuy now\b|\bcheckout\b|购买|下单/iu },
  { label: 'place order', pattern: /\bplace (?:the |an |your )?order\b|\bcomplete (?:the )?(?:order|purchase)\b/iu },
  { label: 'confirm order', pattern: /\bconfirm (?:the |your )?order\b|\bconfirm and pay\b/iu },
  { label: 'transfer', pattern: /\btransfer\b|\bsend money\b|\bwithdraw\b|转账/iu },
  { label: 'approve', pattern: /\bapprove\b|\bauthori[sz]e\b/iu },
  { label: 'delete', pattern: /\bdelete\b|\bpermanently remove\b|删除/iu },
  { label: 'remove account', pattern: /\bremove (?:my |the |your )?account\b|\bclose (?:my |the |your )?account\b/iu },
  { label: 'archive account', pattern: /\barchive (?:my |the |your )?account\b/iu },
  { label: 'deactivate account', pattern: /\bdeactivate (?:my |the |your )?account\b/iu },
  { label: 'unsubscribe', pattern: /\bunsubscribe\b|退订/iu },
  { label: 'revoke', pattern: /\brevoke\b/iu },
]

/** Two-label public suffixes this repository treats as one site. */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'co.jp', 'ne.jp', 'or.jp',
  'com.au', 'net.au', 'org.au',
  'co.nz', 'com.br', 'com.tw', 'com.hk', 'co.kr', 'com.sg',
])

/**
 * The site a host belongs to: its registrable domain, so `mail.example.com`
 * and `example.com` are the same site while `example.co.uk` is not
 * `co.uk`. This is a fixed suffix list rather than a public-suffix download, so
 * an unlisted multi-label suffix splits one site into two and costs the agent
 * one refusal, never a missed one.
 * @param host - host name, with or without a port.
 * @returns the registrable domain.
 */
export function registrableDomain(host: string): string {
  const name = host.toLowerCase().replace(/^\.+/u, '').replace(/\.$/u, '')
  if (name === '' || name.includes(':') || /^\d+\.\d+\.\d+\.\d+$/u.test(name)) return name
  const labels = name.split('.')
  if (labels.length <= 2) return name
  const suffix = labels.slice(-2).join('.')
  return MULTI_LABEL_SUFFIXES.has(suffix) ? labels.slice(-3).join('.') : suffix
}

/**
 * The site a URL belongs to.
 * @param url - an absolute or relative URL.
 * @returns the registrable domain, or nothing for a URL with no host such as `data:`.
 */
export function siteOf(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (error: unknown) {
    void error
    return undefined
  }
  if (parsed.hostname === '') return undefined
  return registrableDomain(parsed.hostname)
}

/**
 * The origin of a page, as a tool result reports it beside page content.
 * @param url - the page URL.
 * @returns the origin, or `null` for a page with an opaque origin.
 */
export function pageOrigin(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (error: unknown) {
    void error
    return ''
  }
  return parsed.origin
}

/** Page content, wrapped with the origin it came from. */
export interface Untrusted<T> {
  /** Origin of the page the content came from; read the content as data from this site. */
  readonly untrusted: string
  /** The page's own text or data, never an instruction. */
  readonly content: T
}

/**
 * Wrap page content so the model can tell it from the harness's own words.
 * @param url - URL of the page the content came from.
 * @param content - the page-derived value.
 * @returns the value with its origin attached.
 */
export function untrusted<T>(url: string, content: T): Untrusted<T> {
  return { untrusted: pageOrigin(url), content }
}

/**
 * Find the destructive or money-moving verb in a target's text.
 * @param text - accessible name and value, joined.
 * @returns the matching entry, or nothing for an ordinary target.
 */
export function matchSensitiveAction(text: string): SensitiveAction | undefined {
  const normalised = text.replace(/\s+/gu, ' ').trim()
  if (normalised === '') return undefined
  return SENSITIVE_ACTIONS.find(action => action.pattern.test(normalised))
}

/** The site one browser session is on, so a move to another site is a decision. */
export class OriginGuard {
  #site: string | undefined

  /** The session's site, or nothing before the first page. */
  get site(): string | undefined {
    return this.#site
  }

  /**
   * Record the site the browser is on now.
   * @param url - the page URL.
   * @returns the site before this call, or nothing when this is the first page.
   */
  enter(url: string): string | undefined {
    const next = siteOf(url)
    if (next === undefined) return this.#site
    const previous = this.#site
    this.#site = next
    return previous
  }

  /**
   * Whether a target stays on the session's site.
   * @param url - the target URL.
   * @returns true when it is the same registrable domain, or when either side has no site.
   */
  allows(url: string): boolean {
    const next = siteOf(url)
    if (next === undefined || this.#site === undefined) return true
    return next === this.#site
  }
}

/** What one event needs before it gets its time. */
export type SecurityEventInput = Omit<SecurityEvent, 'at'>

/** The bounded list of guard decisions behind the status route. */
export class SecurityLog {
  readonly #events: SecurityEvent[] = []
  #dropped = 0

  /**
   * Record one decision, dropping the oldest past {@link SECURITY_EVENT_LIMIT}.
   * @param input - the decision without its time.
   * @param now - clock for the timestamp.
   * @returns the recorded event.
   */
  record(input: SecurityEventInput, now: Date = new Date()): SecurityEvent {
    const event: SecurityEvent = { at: now.toISOString(), ...input }
    this.#events.unshift(event)
    if (this.#events.length > SECURITY_EVENT_LIMIT) {
      this.#events.pop()
      this.#dropped += 1
    }
    return event
  }

  /**
   * Recorded events, newest first.
   * @returns a copy of the bounded list.
   */
  list(): readonly SecurityEvent[] {
    return [...this.#events]
  }

  /**
   * What the status route reports.
   * @returns the events newest first, and how many were dropped.
   */
  view(): { readonly events: readonly SecurityEvent[]; readonly dropped: number } {
    return { events: this.list(), dropped: this.#dropped }
  }

  /** Forget every event, keeping the dropped count. */
  clear(): void {
    this.#events.length = 0
  }
}

/** The target the guard chose among a selector's matches. */
export interface TargetChoice {
  /** Selector or accessibility id the agent named. */
  readonly ref: string
  /** Zero-based index of the chosen element among the selector's matches. */
  readonly index: number
  /** Accessible name of the chosen element. */
  readonly name: string
  /** Its visibility score. */
  readonly score: number
  /** The best score among the elements it was chosen over. */
  readonly runnerUpScore?: number
}

/** Why one action was refused, in the shape a tool result reports. */
export interface Refusal {
  /** The rule that fired. */
  readonly rule: GuardRule
  /** URL of the page the action started from. */
  readonly url: string
  /** Selector or accessibility id the agent named. */
  readonly ref: string
  /** Accessible name of the target, empty when there was none. */
  readonly name: string
  /** One line saying what the rule saw. */
  readonly reason: string
  /** What the agent should do instead of retrying. */
  readonly hint: string
  /** Visibility score, for a visibility refusal. */
  readonly score?: number
  /** Every visibility test's value, for a visibility refusal. */
  readonly factors?: Readonly<Record<VisibilityFactor, number>>
  /** Tests that failed, for a visibility refusal. */
  readonly failing: readonly VisibilityFactor[]
  /** What sits on top of a covered target, as the probe described it; page-derived. */
  readonly coveredBy?: string
  /** Opening tags of the target, its parent and its cover, for a visibility refusal; page-derived. */
  readonly markup?: string
}

/** What a coordinate click hit, and what it scored. */
export interface PointChoice {
  /** Viewport x in CSS pixels. */
  readonly x: number
  /** Viewport y in CSS pixels. */
  readonly y: number
  /** Accessible name of the element the point hit, empty for a blank area. */
  readonly name: string
  /** Visibility score of the element the point hit, when there was one. */
  readonly score?: number
  /** One line about the hit, such as a blank area. */
  readonly note?: string
}

/** The guard's answer for one action. */
export interface Decision {
  /** Whether the action may run. */
  readonly allowed: boolean
  /** The chosen element, when a target was resolved. */
  readonly target?: TargetChoice
  /** The point a coordinate action hit, when it was given one. */
  readonly point?: PointChoice
  /** Why it may not, when it may not. */
  readonly refusal?: Refusal
}

/** One click or type, as the session resolved its target. */
export interface TargetDecisionInput {
  /** Which mutating action this is. */
  readonly action: 'click' | 'type'
  /** URL of the page the action starts from. */
  readonly url: string
  /** Selector or accessibility id the agent named. */
  readonly ref: string
  /** Facts for every element the selector matched, or the single element an id named. */
  readonly candidates: readonly ElementFacts[]
  /** The accessibility id that resolved to no element, when it did not. */
  readonly staleAxId?: string
  /** Whether the agent asked to cross a site boundary in this call. */
  readonly allowOrigin: boolean
}

/** One click or type at a viewport point, which has no selector to score. */
export interface PointDecisionInput {
  /** Which mutating action this is. */
  readonly action: 'click' | 'type'
  /** URL of the page the action starts from. */
  readonly url: string
  /** Viewport x in CSS pixels. */
  readonly x: number
  /** Viewport y in CSS pixels. */
  readonly y: number
  /** Tab the action runs in, recorded with the point. */
  readonly tabId?: string
  /** Facts for the element a hit test found, or nothing when the point is blank. */
  readonly hit?: ElementFacts
  /** Whether the agent asked to cross a site boundary in this call. */
  readonly allowOrigin: boolean
}

/** One navigation, as a tool asked for it. */
export interface NavigationDecisionInput {
  /** The action that would navigate. */
  readonly action: 'open' | 'scroll'
  /** URL of the page the action starts from. */
  readonly url: string
  /** Destination URL. */
  readonly target: string
  /** Whether the agent asked to cross a site boundary in this call. */
  readonly allowOrigin: boolean
}

/** One mutating eval, as a tool asked for it. */
export interface EvalDecisionInput {
  /** URL of the page the script runs in. */
  readonly url: string
  /** The script the agent wants to run. */
  readonly script: string
  /** Whether the agent asked to cross a site boundary in this call. */
  readonly allowOrigin: boolean
}

/** What the guard publishes and how it tells time. */
export interface ActionGuardOptions {
  /** Called once per recorded event, so the plugin can emit it. */
  readonly onEvent?: (event: SecurityEvent) => void
  /** Clock for event timestamps. */
  readonly now?: () => Date
  /**
   * Whether a target whose accessible name or value matches
   * {@link SENSITIVE_ACTIONS} is refused. On, it needs the owner; off, the
   * action runs and the skip is recorded as a security event with
   * `rule: 'sensitive-name'` and `skipped: true`. The visibility and origin
   * rules are not affected either way.
   * @default true
   */
  readonly sensitiveActions?: boolean
}

/** The refusal a tool result carries, and the error that stops the action. */
export interface BlockedAction {
  /** The rule that fired. */
  readonly rule: GuardRule
  /** URL of the page the action started from. */
  readonly url: string
  /** Selector or accessibility id the agent named. */
  readonly ref: string
  /** Accessible name of the target, wrapped as page data. */
  readonly name: Untrusted<string>
  /** One line saying what the rule saw. */
  readonly reason: string
  /** What the agent should do instead of retrying. */
  readonly hint: string
  /** Visibility score, for a visibility refusal. */
  readonly score?: number
  /** The score a target must reach. */
  readonly threshold?: number
  /** Tests that failed, for a visibility refusal. */
  readonly failing: readonly string[]
  /** Every visibility test's value, for a visibility refusal. */
  readonly factors?: Readonly<Record<VisibilityFactor, number>>
  /** What sits on top of a covered target, wrapped as page data. */
  readonly coveredBy?: Untrusted<string>
  /** Opening tags of the target, its parent and its cover, wrapped as page data. */
  readonly markup?: Untrusted<string>
}

/** A guard refusal, carried as an error so the tool layer reports it once. */
export class ActionRefusedError extends Error {
  /** The refusal, in the shape a tool result reports. */
  readonly blocked: BlockedAction

  /**
   * @param blocked - the refusal, ready for a tool result.
   */
  constructor(blocked: BlockedAction) {
    super(blocked.reason)
    this.name = 'ActionRefusedError'
    this.blocked = blocked
  }
}

/** The action guard: visibility, sensitive names, and origin, plus the event list. */
export class ActionGuard {
  /** Bounded list of refusals, allows, and drifts. */
  readonly log = new SecurityLog()
  /** The site this session is on. */
  readonly origin = new OriginGuard()
  readonly #onEvent: ((event: SecurityEvent) => void) | undefined
  readonly #now: () => Date
  /** Whether the sensitive-name rule refuses, or only records, a matching target. */
  readonly #sensitiveActions: boolean
  /** The site an explicit `allowOrigin` named, so the move after it is not a drift. */
  #allowedSite: string | undefined

  /**
   * @param options - the event listener, the clock, and the sensitive-name switch.
   */
  constructor(options: ActionGuardOptions = {}) {
    this.#onEvent = options.onEvent
    this.#now = options.now ?? (() => new Date())
    this.#sensitiveActions = options.sensitiveActions ?? true
  }

  /**
   * Record the site the browser is on, and report a move no call asked for.
   * @param url - the page URL after an action settled.
   */
  anchor(url: string): void {
    const previous = this.origin.enter(url)
    const next = this.origin.site
    const allowed = this.#allowedSite
    this.#allowedSite = undefined
    if (previous === undefined || next === undefined || previous === next || next === allowed) return
    this.#emit({
      kind: 'drift',
      rule: 'site-change',
      action: 'navigate',
      url,
      ref: '',
      name: '',
      reason: `the page moved from ${previous} to ${next} without an allowed origin`,
    })
  }

  /**
   * Decide one click or type: choose the element a person would reach, then
   * refuse it for a sensitive name or a site boundary.
   * @param input - the action, the page, and the facts of every candidate.
   * @returns the chosen element, or the refusal.
   */
  decideTarget(input: TargetDecisionInput): Decision {
    if (input.staleAxId !== undefined) {
      return this.#refuse(input.action, {
        rule: 'ax-id',
        url: input.url,
        ref: input.staleAxId,
        name: '',
        reason: `accessibility id ${input.staleAxId} names no element on this page`,
        failing: [],
      })
    }
    const chosen = pickCandidate(input.candidates)
    const target = chosen.candidate
    const sensitive = matchSensitiveAction(`${target.name} ${target.value}`)
    if (sensitive !== undefined) {
      if (!this.#sensitiveActions) {
        this.#recordSkip(input.action, input.url, input.ref, target.name, sensitive, chosen.score)
      } else {
        return this.#refuse(input.action, {
          rule: 'sensitive',
          url: input.url,
          ref: input.ref,
          name: target.name,
          reason: `the target ${quote(target.name)} matches the sensitive action "${sensitive.label}"`,
          failing: [],
        })
      }
    }
    const originTarget = input.action === 'click' ? target.href : target.formAction
    const originRefusal = this.#crossesSite(input.action, input.url, originTarget, input.allowOrigin, input.ref, target.name)
    if (originRefusal !== undefined) return originRefusal
    if (chosen.score < VISIBILITY_THRESHOLD) {
      return this.#refuse(input.action, {
        rule: 'visibility',
        url: input.url,
        ref: input.ref,
        name: target.name,
        reason: `the element scored ${chosen.score.toFixed(2)}, under the ${VISIBILITY_THRESHOLD} threshold: ${describeFailing(chosen.visibility)}`,
        score: chosen.score,
        factors: chosen.visibility.factors,
        failing: chosen.visibility.failing,
        ...chosen.visibility.factors.occlusion < 1 && target.coveredBy !== undefined ? { coveredBy: target.coveredBy } : {},
        ...target.markup === undefined ? {} : { markup: target.markup },
      })
    }
    return {
      allowed: true,
      target: {
        ref: input.ref,
        index: chosen.index,
        name: target.name,
        score: chosen.score,
        ...chosen.runnerUpScore === undefined ? {} : { runnerUpScore: chosen.runnerUpScore },
      },
    }
  }

  /**
   * Decide one click or type at a viewport point. The model is acting on what
   * it saw in a screenshot, so the visibility score is recorded and audited
   * rather than used as a gate; only a sensitive name (unless the plugin
   * switched that rule off) or a site boundary refuses. A blank point is
   * allowed and noted.
   * @param input - the point, the facts of the element a hit test found, and whether the agent allowed a move.
   * @returns the recorded hit, or the refusal.
   */
  decidePoint(input: PointDecisionInput): Decision {
    const ref = `point (${String(Math.round(input.x))}, ${String(Math.round(input.y))})`
    const tab = input.tabId === undefined ? {} : { tabId: input.tabId }
    const hit = input.hit
    if (hit === undefined) {
      this.#emit({
        kind: 'point',
        action: input.action,
        url: input.url,
        ref,
        name: '',
        reason: 'the point hit no element',
        ...tab,
        point: { x: input.x, y: input.y },
      })
      return {
        allowed: true,
        point: { x: input.x, y: input.y, name: '', note: 'the point hit no element; the click reaches the page itself' },
      }
    }
    const score = scoreVisibility(hit).score
    this.#emit({
      kind: 'point',
      action: input.action,
      url: input.url,
      ref,
      name: hit.name,
      reason: `the point hit an element scoring ${score.toFixed(2)}`,
      score,
      ...tab,
      point: { x: input.x, y: input.y },
    })
    const sensitive = matchSensitiveAction(`${hit.name} ${hit.value}`)
    if (sensitive !== undefined) {
      if (!this.#sensitiveActions) {
        this.#recordSkip(input.action, input.url, ref, hit.name, sensitive, score)
      } else {
        return this.#refuse(input.action, {
          rule: 'sensitive',
          url: input.url,
          ref,
          name: hit.name,
          reason: `the element under the point ${quote(hit.name)} matches the sensitive action "${sensitive.label}"`,
          failing: [],
          score,
        })
      }
    }
    const originTarget = input.action === 'click' ? hit.href : hit.formAction
    const originRefusal = this.#crossesSite(input.action, input.url, originTarget, input.allowOrigin, ref, hit.name)
    if (originRefusal !== undefined) return originRefusal
    return {
      allowed: true,
      point: {
        x: input.x,
        y: input.y,
        name: hit.name,
        score,
      },
    }
  }

  /**
   * Decide one navigation: opening a page, or a scroll that carries a target URL.
   * @param input - the page, the destination, and whether the agent allowed the move.
   * @returns whether the navigation may run.
   */
  decideNavigation(input: NavigationDecisionInput): Decision {
    const refusal = this.#crossesSite(input.action, input.url, input.target, input.allowOrigin, input.target, '')
    if (refusal !== undefined) return refusal
    return { allowed: true }
  }

  /**
   * Decide one mutating eval. A script can navigate with a URL the guard never
   * sees, so this reads the absolute URLs in the script and holds the same site
   * boundary; it is a tripwire, not a proof.
   * @param input - the page, the script, and whether the agent allowed the move.
   * @returns whether the script may run.
   */
  decideEval(input: EvalDecisionInput): Decision {
    const urls = input.script.match(/https?:\/\/[^\s'"`<>()\\]+/gu) ?? []
    for (const url of urls) {
      const refusal = this.#crossesSite('eval', input.url, url, input.allowOrigin, 'eval', '')
      if (refusal !== undefined) return refusal
    }
    return { allowed: true }
  }

  /** Refuse a move to another site unless this call allowed it; an allowed move is logged. */
  #crossesSite(
    action: GuardAction,
    pageUrl: string,
    targetUrl: string | null,
    allowOrigin: boolean,
    ref: string,
    name: string,
  ): Decision | undefined {
    if (targetUrl === null) return undefined
    // The boundary is the site of the page the action runs in: with several tabs
    // open, the last site any tab visited says nothing about this one. A page
    // with no site of its own (a fresh tab) falls back to that last site.
    const base = siteOf(pageUrl) ?? this.origin.site
    const target = siteOf(targetUrl)
    if (target === undefined || base === undefined || target === base) return undefined
    const site = target
    if (!allowOrigin) {
      return this.#refuse(action, {
        rule: 'origin',
        url: pageUrl,
        ref,
        name,
        reason: `the target is on ${site} while the page is on ${base}`,
        failing: [],
      })
    }
    this.#allowedSite = site
    this.#emit({
      kind: 'allow',
      rule: 'origin',
      action,
      url: pageUrl,
      ref,
      name,
      reason: `the agent allowed the move to ${site}`,
    })
    return undefined
  }

  /**
   * Record that the sensitive-name rule was switched off for a target it would
   * have refused, so the audit trail keeps what the switch let through. The
   * decision is an `allow` with `rule: 'sensitive-name'` and `skipped: true`.
   */
  #recordSkip(
    action: GuardAction,
    url: string,
    ref: string,
    name: string,
    sensitive: SensitiveAction,
    score: number,
  ): void {
    this.#emit({
      kind: 'allow',
      rule: 'sensitive-name',
      action,
      url,
      ref,
      name,
      reason: `the target ${quote(name)} matches the sensitive action "${sensitive.label}", but the sensitive-name rule is off (sensitiveActions: false), so the action ran`,
      skipped: true,
      score,
    })
  }

  #refuse(action: GuardAction, input: Omit<Refusal, 'hint'>): Decision {
    const refusal: Refusal = { ...input, hint: input.coveredBy === undefined ? HINTS[input.rule] : COVERED_HINT }
    this.#emit({
      kind: 'refusal',
      rule: refusal.rule,
      action,
      url: refusal.url,
      ref: refusal.ref,
      name: refusal.name,
      reason: refusal.reason,
      ...refusal.score === undefined ? {} : { score: refusal.score },
    })
    return { allowed: false, refusal }
  }

  #emit(input: SecurityEventInput): void {
    const event = this.log.record(input, this.#now())
    this.#onEvent?.(event)
  }
}

/**
 * What the agent should do when something on top covers the target: a person
 * closes a cookie banner or dialog first, with its own visible button.
 */
const COVERED_HINT = 'Something on top covers this element (coveredBy names it). If it is a cookie banner, consent prompt or dialog the owner would close first, close it with its own visible button (accept, reject or close), then retry this action. Do not reach the covered element another way (another selector or id for it, or its coordinates).'

/** What the agent should do after each kind of refusal. */
const HINTS: Readonly<Record<GuardRule, string>> = {
  visibility: 'The owner cannot see or hit this element: do not reach it another way (another selector or id for it, or its coordinates). If you meant a visible field this selector did not single out, name that field by its label and act on it; otherwise report the blocked action.',
  sensitive: 'This target moves money or destroys something. Call headless_browser_hand_over so the owner decides.',
  origin: 'The target is on another site. Call again with allowOrigin: true only after the owner agreed, or hand over.',
  'ax-id': 'The id names no element on the current page. Read the page again for fresh ids; do not fall back to a selector or coordinates.',
}

/**
 * Shape a refusal for a tool result: the rule, the page, the name as page data,
 * and the score that failed.
 * @param refusal - the refusal the guard decided.
 * @returns the body a tool result carries under `blocked`.
 */
export function blockedAction(refusal: Refusal): BlockedAction {
  return {
    rule: refusal.rule,
    url: refusal.url,
    ref: refusal.ref,
    name: untrusted(refusal.url, refusal.name),
    reason: refusal.reason,
    hint: refusal.hint,
    ...refusal.score === undefined ? {} : { score: refusal.score, threshold: VISIBILITY_THRESHOLD },
    failing: refusal.failing,
    ...refusal.factors === undefined ? {} : { factors: refusal.factors },
    ...refusal.coveredBy === undefined ? {} : { coveredBy: untrusted(refusal.url, refusal.coveredBy) },
    ...refusal.markup === undefined ? {} : { markup: untrusted(refusal.url, refusal.markup) },
  }
}

/**
 * The refusal a decision carries.
 * @param decision - the guard's answer.
 * @returns the refusal the action stopped on.
 * @throws Error - when the decision allowed the action, which a caller asking for a refusal already excluded.
 */
export function refusalOf(decision: Decision): Refusal {
  if (decision.refusal === undefined) throw new Error('the action guard allowed the action, so it has no refusal')
  return decision.refusal
}

/** The candidate a person would reach: the highest score, first in document order on a tie. */
function pickCandidate(candidates: readonly ElementFacts[]): {
  readonly index: number
  readonly score: number
  readonly visibility: VisibilityScore
  readonly candidate: ElementFacts
  readonly runnerUpScore?: number
} {
  let index = 0
  let best = -1
  let runnerUp: number | undefined
  let chosen: { readonly visibility: VisibilityScore; readonly candidate: ElementFacts } | undefined
  for (const [position, candidate] of candidates.entries()) {
    const visibility = scoreVisibility(candidate)
    if (visibility.score > best) {
      runnerUp = best < 0 ? undefined : best
      best = visibility.score
      index = position
      chosen = { visibility, candidate }
    } else if (runnerUp === undefined || visibility.score > runnerUp) {
      runnerUp = visibility.score
    }
  }
  if (chosen === undefined) throw new Error('a guarded action needs at least one candidate element')
  return { index, score: best, ...chosen, ...runnerUp === undefined ? {} : { runnerUpScore: runnerUp } }
}

/** Name the tests that failed, hardest first, so the refusal explains itself. */
function describeFailing(visibility: VisibilityScore): string {
  return visibility.failing.map(factor => `${factor}=${visibility.factors[factor].toFixed(2)}`).join(', ')
}

/** Quote a page's own words inside a harness sentence. */
function quote(text: string): string {
  const trimmed = text.trim()
  return trimmed === '' ? '(no accessible name)' : JSON.stringify(trimmed)
}
