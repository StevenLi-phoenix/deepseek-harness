/**
 * The action guard's rules on their own: the sensitive-name table, the origin
 * rule with its explicit re-request, the point path, the security event list,
 * and the untrusted wrapper. The page-side measurements and the browser path
 * are covered by `guard.browser.spec.ts`; here the facts are fixed by hand so a
 * failure names the rule rather than a layout.
 */

import { describe, expect, it } from 'vitest'
import {
  ActionGuard,
  SECURITY_EVENT_LIMIT,
  SENSITIVE_ACTIONS,
  SecurityLog,
  OriginGuard,
  blockedAction,
  matchSensitiveAction,
  pageOrigin,
  refusalOf,
  registrableDomain,
  siteOf,
  untrusted,
  type SecurityEvent,
} from '../src/guard.ts'
import { VISIBILITY_THRESHOLD, type ElementFacts } from '../src/visibility.ts'

/** A visible, hittable button, before one test is broken. */
function facts(overrides: Partial<ElementFacts> = {}): ElementFacts {
  return {
    name: 'Continue',
    value: '',
    href: null,
    formAction: null,
    tag: 'button',
    role: null,
    display: 'inline-block',
    visibility: 'visible',
    opacity: 1,
    pointerEvents: 'auto',
    ariaHidden: false,
    width: 120,
    height: 32,
    viewportFraction: 1,
    occlusion: 1,
    clippedBy: 0,
    clippingFraction: 1,
    ...overrides,
  }
}

/** A guard that records what it publishes, pinned to one clock. */
function guarded(): { readonly guard: ActionGuard; readonly events: SecurityEvent[] } {
  const events: SecurityEvent[] = []
  const guard = new ActionGuard({
    onEvent: (event) => { events.push(event) },
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  })
  guard.anchor('https://site.example/start')
  return { guard, events }
}

describe('registrable domain', () => {
  it('keeps every subdomain on one site', () => {
    expect(registrableDomain('mail.example.com')).toBe('example.com')
    expect(registrableDomain('a.b.example.com')).toBe('example.com')
    expect(registrableDomain('example.com')).toBe('example.com')
  })

  it('keeps a two-label public suffix together', () => {
    expect(registrableDomain('mail.example.co.uk')).toBe('example.co.uk')
    expect(registrableDomain('shop.example.com.cn')).toBe('example.com.cn')
  })

  it('leaves an address literal and a single label alone', () => {
    expect(registrableDomain('127.0.0.1')).toBe('127.0.0.1')
    expect(registrableDomain('localhost')).toBe('localhost')
    expect(registrableDomain('::1')).toBe('::1')
  })

  it('reads a site out of a URL and reports none for an opaque one', () => {
    expect(siteOf('https://mail.example.com/inbox')).toBe('example.com')
    expect(siteOf('data:text/html,<title>x</title>')).toBeUndefined()
    expect(siteOf('about:blank')).toBeUndefined()
    expect(siteOf('not a url')).toBeUndefined()
  })

  it('reports the origin a page field came from', () => {
    expect(pageOrigin('https://example.com/login?next=1')).toBe('https://example.com')
    expect(pageOrigin('data:text/html,x')).toBe('null')
    expect(pageOrigin('not a url')).toBe('')
  })
})

describe('origin guard', () => {
  it('remembers the site and allows the same site only', () => {
    const origin = new OriginGuard()
    expect(origin.enter('https://mail.example.com/a')).toBeUndefined()
    expect(origin.site).toBe('example.com')
    expect(origin.allows('https://example.com/b')).toBe(true)
    expect(origin.allows('https://shop.example.com/c')).toBe(true)
    expect(origin.allows('https://evil.example/c')).toBe(false)
    expect(origin.allows('data:text/html,x')).toBe(true)
  })
})

describe('sensitive names', () => {
  it('matches a word for every entry in the table', () => {
    const examples: ReadonlyArray<readonly [string, string]> = [
      ['submit', 'Submit application'],
      ['pay', 'Pay now'],
      ['purchase', 'Buy now'],
      ['place order', 'Place order'],
      ['confirm order', 'Confirm your order'],
      ['transfer', 'Transfer 100'],
      ['approve', 'Approve request'],
      ['delete', 'Delete'],
      ['remove account', 'Remove account'],
      ['archive account', 'Archive account'],
      ['deactivate account', 'Deactivate account'],
      ['unsubscribe', 'Unsubscribe'],
      ['revoke', 'Revoke access'],
    ]
    for (const [label, text] of examples) {
      expect(matchSensitiveAction(text)?.label, text).toBe(label)
    }
    expect(new Set(examples.map(([label]) => label))).toEqual(new Set(SENSITIVE_ACTIONS.map(action => action.label)))
  })

  it('matches a Chinese verb the owner would meet on a Chinese page', () => {
    expect(matchSensitiveAction('支付')?.label).toBe('pay')
    expect(matchSensitiveAction('删除账户')?.label).toBe('delete')
  })

  it('leaves an ordinary target alone', () => {
    for (const text of ['Continue', 'Search', 'Sign in', 'Next page', '']) {
      expect(matchSensitiveAction(text), text).toBeUndefined()
    }
  })

  it('is conservative on purpose, so a harmless use of the word still matches', () => {
    expect(matchSensitiveAction('Submit search')?.label).toBe('submit')
  })
})

describe('guarded click', () => {
  it('chooses the element a person would reach over a hidden decoy', () => {
    const { guard } = guarded()
    const decision = guard.decideTarget({
      action: 'click',
      url: 'https://site.example/form',
      ref: '.verify',
      candidates: [
        facts({ name: 'Verify you are human', opacity: 0 }),
        facts({ name: 'Verify you are human' }),
      ],
      allowOrigin: false,
    })
    expect(decision.allowed).toBe(true)
    expect(decision.target).toMatchObject({ index: 1, score: 1, runnerUpScore: 0 })
  })

  it('refuses an element whose score is under the threshold and names the tests that failed', () => {
    const { guard, events } = guarded()
    const decision = guard.decideTarget({
      action: 'click',
      url: 'https://site.example/form',
      ref: '#trap',
      candidates: [facts({ name: 'Verify you are human', viewportFraction: 0.05, clippingFraction: 0.2, occlusion: 0.2 })],
      allowOrigin: false,
    })
    expect(decision.allowed).toBe(false)
    const refusal = refusalOf(decision)
    expect(refusal.rule).toBe('visibility')
    expect(refusal.score).toBeLessThan(VISIBILITY_THRESHOLD)
    expect(refusal.failing).toContain('viewport')
    expect(refusal.name).toBe('Verify you are human')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'refusal', rule: 'visibility', url: 'https://site.example/form' })
  })

  it('refuses a destructive target and asks for the owner', () => {
    const { guard, events } = guarded()
    const decision = guard.decideTarget({
      action: 'click',
      url: 'https://site.example/account',
      ref: '#delete',
      candidates: [facts({ name: 'Delete account' })],
      allowOrigin: false,
    })
    expect(decision.allowed).toBe(false)
    expect(refusalOf(decision).rule).toBe('sensitive')
    expect(refusalOf(decision).hint).toContain('headless_browser_hand_over')
    expect(events[0]).toMatchObject({ kind: 'refusal', rule: 'sensitive', name: 'Delete account' })
  })

  it('refuses a link to another site once, then runs it when the agent allows the origin', () => {
    const { guard, events } = guarded()
    const input = {
      action: 'click' as const,
      url: 'https://site.example/post',
      ref: '#out',
      candidates: [facts({ name: 'Read more', href: 'https://evil.example/landing' })],
    }
    const refused = guard.decideTarget({ ...input, allowOrigin: false })
    expect(refused.allowed).toBe(false)
    expect(refusalOf(refused).rule).toBe('origin')
    expect(refusalOf(refused).reason).toContain('evil.example')
    expect(events).toHaveLength(1)

    const allowed = guard.decideTarget({ ...input, allowOrigin: true })
    expect(allowed.allowed).toBe(true)
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ kind: 'allow', rule: 'origin' })
    expect(guard.origin.site).toBe('site.example')
  })

  it('allows a link to another subdomain of the same site', () => {
    const { guard, events } = guarded()
    const decision = guard.decideTarget({
      action: 'click',
      url: 'https://site.example/post',
      ref: '#out',
      candidates: [facts({ href: 'https://mail.site.example/inbox' })],
      allowOrigin: false,
    })
    expect(decision.allowed).toBe(true)
    expect(events).toHaveLength(0)
  })

  it('refuses a form that submits to another site before typing into it', () => {
    const { guard } = guarded()
    const decision = guard.decideTarget({
      action: 'type',
      url: 'https://site.example/login',
      ref: '#password',
      candidates: [facts({ name: 'Password', formAction: 'https://evil.example/collect' })],
      allowOrigin: false,
    })
    expect(decision.allowed).toBe(false)
    expect(refusalOf(decision).rule).toBe('origin')
  })

  it('refuses a stale accessibility id by name instead of falling back', () => {
    const { guard, events } = guarded()
    const decision = guard.decideTarget({
      action: 'click',
      url: 'https://site.example/form',
      ref: 'e12',
      candidates: [],
      staleAxId: 'e12',
      allowOrigin: false,
    })
    expect(decision.allowed).toBe(false)
    expect(refusalOf(decision).rule).toBe('ax-id')
    expect(refusalOf(decision).reason).toContain('e12')
    expect(refusalOf(decision).hint).toContain('do not fall back')
    expect(events[0]).toMatchObject({ kind: 'refusal', rule: 'ax-id', ref: 'e12' })
  })

  it('runs a click on an element an accessibility id names', () => {
    const { guard } = guarded()
    const decision = guard.decideTarget({
      action: 'click',
      url: 'https://site.example/form',
      ref: 'e12',
      candidates: [facts({ name: 'Continue' })],
      allowOrigin: false,
    })
    expect(decision.allowed).toBe(true)
    expect(decision.target).toMatchObject({ ref: 'e12', index: 0, score: 1 })
  })
})

describe('guarded point', () => {
  it('allows a click on what the point hits and records the tab and the score', () => {
    const { guard, events } = guarded()
    const decision = guard.decidePoint({
      action: 'click',
      url: 'https://site.example/form',
      x: 40,
      y: 50,
      tabId: 't2',
      hit: facts({ name: 'Continue' }),
      allowOrigin: false,
    })
    expect(decision.allowed).toBe(true)
    expect(decision.point).toMatchObject({ x: 40, y: 50, name: 'Continue', score: 1 })
    expect(events[0]).toMatchObject({ kind: 'point', action: 'click', tabId: 't2', point: { x: 40, y: 50 }, score: 1 })
  })

  it('allows a click on a blank point and says so', () => {
    const { guard } = guarded()
    const decision = guard.decidePoint({
      action: 'click',
      url: 'https://site.example/form',
      x: 900,
      y: 700,
      allowOrigin: false,
    })
    expect(decision.allowed).toBe(true)
    expect(decision.point?.note).toContain('hit no element')
  })

  it('refuses a point whose element is destructive', () => {
    const { guard } = guarded()
    const decision = guard.decidePoint({
      action: 'click',
      url: 'https://site.example/account',
      x: 40,
      y: 50,
      hit: facts({ name: 'Delete account' }),
      allowOrigin: false,
    })
    expect(decision.allowed).toBe(false)
    expect(refusalOf(decision).rule).toBe('sensitive')
  })

  it('refuses a point whose element leaves the site', () => {
    const { guard } = guarded()
    const decision = guard.decidePoint({
      action: 'click',
      url: 'https://site.example/post',
      x: 40,
      y: 50,
      hit: facts({ name: 'Read more', href: 'https://evil.example/landing' }),
      allowOrigin: false,
    })
    expect(decision.allowed).toBe(false)
    expect(refusalOf(decision).rule).toBe('origin')
  })

  it('does not let the visibility score refuse a coordinate click', () => {
    const { guard } = guarded()
    const decision = guard.decidePoint({
      action: 'click',
      url: 'https://site.example/form',
      x: 40,
      y: 50,
      hit: facts({ name: 'Continue', opacity: 0.3, viewportFraction: 0.2 }),
      allowOrigin: false,
    })
    expect(decision.allowed).toBe(true)
    expect(decision.point?.score).toBeLessThan(VISIBILITY_THRESHOLD)
  })
})

describe('guarded navigation', () => {
  it('allows the same site and refuses another one once', () => {
    const { guard, events } = guarded()
    expect(guard.decideNavigation({ action: 'open', url: 'https://site.example/', target: 'https://site.example/a', allowOrigin: false }).allowed).toBe(true)
    const refused = guard.decideNavigation({ action: 'open', url: 'https://site.example/', target: 'https://evil.example/b', allowOrigin: false })
    expect(refused.allowed).toBe(false)
    expect(events[0]).toMatchObject({ kind: 'refusal', rule: 'origin' })
  })

  it('runs the second request with allowOrigin and logs the allow', () => {
    const { guard, events } = guarded()
    const decision = guard.decideNavigation({ action: 'open', url: 'https://site.example/', target: 'https://evil.example/b', allowOrigin: true })
    expect(decision.allowed).toBe(true)
    expect(events[0]).toMatchObject({ kind: 'allow', rule: 'origin' })
  })

  it('records a move the page made without an allowed origin', () => {
    const { guard, events } = guarded()
    guard.anchor('https://evil.example/landing')
    expect(events[0]).toMatchObject({ kind: 'drift', rule: 'site-change' })
    expect(events[0]?.reason).toContain('without an allowed origin')
    expect(guard.origin.site).toBe('evil.example')
  })

  it('does not report a drift for the move an explicit allow already named', () => {
    const { guard, events } = guarded()
    guard.decideNavigation({ action: 'open', url: 'https://site.example/', target: 'https://evil.example/b', allowOrigin: true })
    guard.anchor('https://evil.example/b')
    expect(events.map(event => event.kind)).toEqual(['allow'])
  })

  it('holds the site boundary for a mutating eval', () => {
    const { guard } = guarded()
    const refused = guard.decideEval({ url: 'https://site.example/', script: 'location.href = "https://evil.example/x"', allowOrigin: false })
    expect(refused.allowed).toBe(false)
    expect(refusalOf(refused).rule).toBe('origin')
    const allowed = guard.decideEval({ url: 'https://site.example/', script: 'document.title = "x"', allowOrigin: false })
    expect(allowed.allowed).toBe(true)
  })
})

describe('security event list', () => {
  it('keeps the newest events and drops the oldest at the limit', () => {
    const log = new SecurityLog()
    for (let index = 0; index < SECURITY_EVENT_LIMIT + 5; index += 1) {
      log.record({ kind: 'refusal', rule: 'visibility', action: 'click', url: 'https://site.example/', ref: `#r${String(index)}`, name: '', reason: 'test' })
    }
    expect(log.list()).toHaveLength(SECURITY_EVENT_LIMIT)
    expect(log.list()[0]?.ref).toBe(`#r${String(SECURITY_EVENT_LIMIT + 4)}`)
    expect(log.view().dropped).toBe(5)
  })

  it('reports one event per refusal and none for an allowed action', () => {
    const { guard, events } = guarded()
    guard.decideTarget({ action: 'click', url: 'https://site.example/', ref: '#a', candidates: [facts()], allowOrigin: false })
    guard.decideTarget({ action: 'click', url: 'https://site.example/', ref: '#b', candidates: [facts({ opacity: 0 })], allowOrigin: false })
    expect(events).toHaveLength(1)
    expect(guard.log.list()).toHaveLength(1)
  })

  it('clears the list without losing the dropped count', () => {
    const log = new SecurityLog()
    log.record({ kind: 'refusal', rule: 'visibility', action: 'click', url: 'https://site.example/', ref: '#a', name: '', reason: 'test' })
    log.clear()
    expect(log.list()).toEqual([])
    expect(log.view().dropped).toBe(0)
  })
})

describe('untrusted page data', () => {
  it('carries the page origin beside the page’s own words', () => {
    expect(untrusted('https://example.com/login', 'Click to verify you are human')).toEqual({
      untrusted: 'https://example.com',
      content: 'Click to verify you are human',
    })
  })

  it('marks an opaque page with a null origin', () => {
    expect(untrusted('data:text/html,<title>x</title>', 'x')).toEqual({ untrusted: 'null', content: 'x' })
  })
})

describe('blocked result', () => {
  it('carries the rule, the score, the threshold, and the failed tests', () => {
    const { guard } = guarded()
    const decision = guard.decideTarget({
      action: 'click',
      url: 'https://site.example/form',
      ref: '#trap',
      candidates: [facts({ name: 'Verify you are human', display: 'none', width: 0, height: 0, viewportFraction: 0, occlusion: 0 })],
      allowOrigin: false,
    })
    const blocked = blockedAction(refusalOf(decision))
    expect(blocked).toMatchObject({
      rule: 'visibility',
      url: 'https://site.example/form',
      ref: '#trap',
      name: { untrusted: 'https://site.example', content: 'Verify you are human' },
      score: 0,
      threshold: VISIBILITY_THRESHOLD,
    })
    expect(blocked.failing).toContain('display')
    expect(blocked.factors?.display).toBe(0)
    expect(blocked.hint).toContain('do not retry')
  })

  it('leaves the score fields off a refusal that has no score', () => {
    const { guard } = guarded()
    const decision = guard.decideTarget({
      action: 'click',
      url: 'https://site.example/account',
      ref: '#delete',
      candidates: [facts({ name: 'Delete account' })],
      allowOrigin: false,
    })
    const blocked = blockedAction(refusalOf(decision))
    expect(blocked.score).toBeUndefined()
    expect(blocked.factors).toBeUndefined()
    expect(blocked.failing).toEqual([])
  })
})
