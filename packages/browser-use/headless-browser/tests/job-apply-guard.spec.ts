/** Exercise the job-apply sensitive-name policy for named and coordinate actions. */
import { describe, expect, it } from 'vitest'
import { ActionGuard, refusalOf } from '../src/guard.ts'
import type { ElementFacts } from '../src/visibility.ts'

function control(name: string, overrides: Partial<ElementFacts> = {}): ElementFacts {
  return {
    name, value: '', href: null, formAction: null, tag: 'button', role: null,
    display: 'inline-block', visibility: 'visible', opacity: 1, pointerEvents: 'auto', ariaHidden: false,
    width: 120, height: 32, viewportFraction: 1, occlusion: 1, clippedBy: 0, clippingFraction: 1,
    ...overrides,
  }
}

const url = 'https://careers.example/apply'
const external = 'https://unrelated.example/form'

function act(guard: ActionGuard, mode: 'named' | 'point', action: 'click' | 'type', target: ElementFacts, allowOrigin = false) {
  return mode === 'named'
    ? guard.decideTarget({ action, url, ref: '#application_fee_field', candidates: [target], allowOrigin })
    : guard.decidePoint({ action, url, x: 40, y: 50, tabId: 't2', hit: target, allowOrigin })
}

describe.each(['named', 'point'] as const)('job-apply guard for %s actions', (mode) => {
  it.each([
    ['Submit your application', {}],
    ['Review and Submit', {}],
    ['Submit & Continue', {}],
    ['I authorize the background check', { tag: 'input', role: 'checkbox' }],
    ['I approve the background check', { role: 'checkbox' }],
    ['Delete work experience', {}],
    ['Delete', {}],
  ] satisfies [string, Partial<ElementFacts>][])('allows and records %s', (name, overrides) => {
    const guard = new ActionGuard({ sensitivePolicy: 'job-apply' })
    expect(act(guard, mode, 'click', control(name, overrides)).allowed).toBe(true)
    expect(guard.log.list().filter(event => event.kind === 'allow')).toEqual([
      expect.objectContaining({ kind: 'allow', rule: 'sensitive-name', action: 'click', name }),
    ])
    expect(guard.log.list()[0]?.skipped).toBeUndefined()
  })

  it.each([
    'Pay $25 application fee', 'Application fee', 'Purchase', 'Place order', 'Confirm your order',
    'Transfer money', 'Send money', 'Delete account', 'Close your account', 'Deactivate my account',
    'Revoke access', 'Unsubscribe', 'Submit & pay the fee', 'Authorize payment', 'Confirm account deletion',
  ])('refuses %s even when the shared rule would allow it', (name) => {
    const guard = new ActionGuard({ sensitivePolicy: 'job-apply', sensitiveActions: false, allowSensitive: () => true })
    expect(refusalOf(act(guard, mode, 'click', control(name), true))).toMatchObject({ rule: 'sensitive', name })
    expect(guard.log.list()[0]).toMatchObject({ kind: 'refusal', rule: 'sensitive', action: 'click', name })
  })

  it.each(['click', 'type'] as const)('allows %s on salary fields and ignores selector and field value', (action) => {
    const guard = new ActionGuard({ sensitivePolicy: 'job-apply' })
    for (const name of ['Desired pay', 'Expected pay range (USD)', 'Feedback', 'Coffee preferences', 'Transfer application']) {
      const value = 'Pay the fee; revoke and delete account'
      expect(act(guard, mode, action, control(name, { tag: 'input', value })).allowed).toBe(true)
    }
    expect(guard.log.list().every(event => event.kind === 'point')).toBe(true)
  })

  it('applies blocked labels on the type path as well as the click path', () => {
    const guard = new ActionGuard({ sensitivePolicy: 'job-apply' })
    expect(refusalOf(act(guard, mode, 'type', control('Pay now'))).rule).toBe('sensitive')
    expect(guard.log.list()[0]).toMatchObject({ kind: 'refusal', action: 'type' })
  })

  it('records a permitted type action as type, not as click', () => {
    const guard = new ActionGuard({ sensitivePolicy: 'job-apply' })
    expect(act(guard, mode, 'type', control('I authorize the background check', { tag: 'textarea' })).allowed).toBe(true)
    expect(guard.log.list()[0]).toMatchObject({ kind: 'allow', rule: 'sensitive-name', action: 'type' })
  })

  it.each(['click', 'type'] as const)('lets %s cross to another site and records the move, since the network deny list is the boundary', (action) => {
    const guard = new ActionGuard({ sensitivePolicy: 'job-apply' })
    const target = control('Submit & Continue', action === 'click' ? { href: external } : { formAction: external })
    expect(act(guard, mode, action, target).allowed).toBe(true)
    expect(guard.log.list()).toContainEqual(expect.objectContaining({ kind: 'allow', rule: 'origin', reason: expect.stringMatching(/deny list still applies/u) }))
    // The shared guard still asks for allowOrigin.
    expect(refusalOf(act(new ActionGuard(), mode, action, control('Continue', action === 'click' ? { href: external } : { formAction: external }))).rule).toBe('origin')
  })

  it('does not change the shared guard’s conservative rule', () => {
    const guard = new ActionGuard()
    expect(refusalOf(act(guard, mode, 'click', control('Review and Submit'))).rule).toBe('sensitive')
    expect(refusalOf(act(guard, mode, 'type', control('Desired pay', { tag: 'input' }))).rule).toBe('sensitive')
  })
})

it('retains the named visibility threshold and existing point visibility audit', () => {
  const guard = new ActionGuard({ sensitivePolicy: 'job-apply' })
  const target = control('Submit your application', { opacity: 0 })
  expect(refusalOf(act(guard, 'named', 'click', target)).rule).toBe('visibility')
  expect(guard.log.list().some(event => event.kind === 'allow')).toBe(false)
  expect(act(guard, 'point', 'click', target).point?.score).toBe(0)
  expect(guard.log.list()).toContainEqual(expect.objectContaining({ kind: 'point', score: 0 }))
})
