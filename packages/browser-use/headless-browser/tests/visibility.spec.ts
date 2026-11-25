/**
 * The visibility score on its own: each test a person's target must pass, the
 * score it produces, and the validation that keeps a page from handing the host
 * something that is not a measurement. The probe itself runs against a real
 * Chromium in `guard.browser.spec.ts`; these cases fix the arithmetic.
 */

import { describe, expect, it } from 'vitest'
import {
  readElementFacts,
  scoreVisibility,
  VISIBILITY_THRESHOLD,
  VISIBILITY_WEIGHTS,
  type ElementFacts,
} from '../src/visibility.ts'

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

describe('visibility score', () => {
  it('scores a visible, hittable element at the top of the range', () => {
    expect(scoreVisibility(facts())).toEqual({
      score: 1,
      factors: {
        display: 1,
        visibility: 1,
        pointerEvents: 1,
        ariaHidden: 1,
        opacity: 1,
        viewport: 1,
        occlusion: 1,
        area: 1,
        clipping: 1,
      },
      failing: [],
    })
  })

  it('scores a display:none element zero and names display as the failed test', () => {
    const scored = scoreVisibility(facts({ display: 'none', width: 0, height: 0, viewportFraction: 0, occlusion: 0 }))
    expect(scored.score).toBe(0)
    expect(scored.failing).toContain('display')
    expect(scored.score).toBeLessThan(VISIBILITY_THRESHOLD)
  })

  it('scores a visibility:hidden element zero and names visibility', () => {
    const scored = scoreVisibility(facts({ visibility: 'hidden', occlusion: 0 }))
    expect(scored.score).toBe(0)
    expect(scored.failing).toContain('visibility')
  })

  it('scores an element at zero opacity as invisible rather than faint', () => {
    const scored = scoreVisibility(facts({ opacity: 0 }))
    expect(scored.score).toBe(0)
    expect(scored.failing).toContain('opacity')
  })

  it('scores a zero box zero and names the area test', () => {
    const scored = scoreVisibility(facts({ width: 0, height: 0, viewportFraction: 0, occlusion: 0 }))
    expect(scored.score).toBe(0)
    expect(scored.failing).toContain('area')
  })

  it('scores pointer-events:none zero, because a person cannot hit it', () => {
    const scored = scoreVisibility(facts({ pointerEvents: 'none', occlusion: 0 }))
    expect(scored.score).toBe(0)
    expect(scored.failing).toContain('pointerEvents')
  })

  it('scores aria-hidden="true" zero, because the page says a person cannot see it', () => {
    const scored = scoreVisibility(facts({ ariaHidden: true }))
    expect(scored.score).toBe(0)
    expect(scored.failing).toContain('ariaHidden')
  })

  it('scores an element whose own aria-hidden is set zero even when it is plainly on screen', () => {
    const scored = scoreVisibility(facts({ ariaHidden: true, ariaHiddenOwn: true }))
    expect(scored.score).toBe(0)
    expect(scored.failing).toContain('ariaHidden')
  })

  it('passes a control that inherits aria-hidden from a dialog ancestor while wholly on screen and on top', () => {
    const scored = scoreVisibility(facts({ ariaHidden: true, ariaHiddenOwn: false }))
    expect(scored.factors.ariaHidden).toBe(1)
    expect(scored.failing).not.toContain('ariaHidden')
  })

  it('still fails an inherited aria-hidden when the control is covered or partly off screen', () => {
    expect(scoreVisibility(facts({ ariaHidden: true, ariaHiddenOwn: false, occlusion: 0.8 })).failing).toContain('ariaHidden')
    expect(scoreVisibility(facts({ ariaHidden: true, ariaHiddenOwn: false, viewportFraction: 0.9 })).failing).toContain('ariaHidden')
  })

  it('rejects an ariaHiddenOwn field that is not a boolean', () => {
    expect(() => readElementFacts({ ...facts(), ariaHiddenOwn: 'no' })).toThrow('the visibility probe returned no ariaHiddenOwn')
  })

  it('scores an element fully outside the viewport zero and names the viewport test', () => {
    const scored = scoreVisibility(facts({ viewportFraction: 0, occlusion: 0 }))
    expect(scored.score).toBe(0)
    expect(scored.failing).toContain('viewport')
  })

  it('keeps a half-visible element above the threshold and reports the viewport fraction', () => {
    const scored = scoreVisibility(facts({ viewportFraction: 0.5 }))
    expect(scored.factors.viewport).toBe(0.5)
    expect(scored.score).toBeGreaterThan(VISIBILITY_THRESHOLD)
    expect(scored.score).toBeLessThan(1)
    expect(scored.failing).toContain('viewport')
  })

  it('drops a fully covered element below the threshold through the hit test', () => {
    const scored = scoreVisibility(facts({ occlusion: 0 }))
    expect(scored.score).toBe(0)
    expect(scored.failing).toContain('occlusion')
  })

  it('keeps a partially covered element above the threshold', () => {
    const scored = scoreVisibility(facts({ occlusion: 0.6 }))
    expect(scored.score).toBeGreaterThan(VISIBILITY_THRESHOLD)
    expect(scored.failing).toContain('occlusion')
  })

  it('drops an element clipped away by its ancestors', () => {
    const scored = scoreVisibility(facts({ clippedBy: 2, clippingFraction: 0.1, viewportFraction: 0.1 }))
    expect(scored.failing).toContain('clipping')
    expect(scored.score).toBeLessThan(VISIBILITY_THRESHOLD)
  })

  it('penalises a box too small to aim at without hiding a normal small control', () => {
    expect(scoreVisibility(facts({ width: 2, height: 2 })).factors.area).toBeLessThan(0.1)
    expect(scoreVisibility(facts({ width: 8, height: 8 })).factors.area).toBeGreaterThan(0.1)
    expect(scoreVisibility(facts({ width: 16, height: 16 })).factors.area).toBe(1)
  })

  it('weighs a hard blocker above a narrow one', () => {
    expect(VISIBILITY_WEIGHTS.display).toBeGreaterThan(VISIBILITY_WEIGHTS.clipping)
    expect(VISIBILITY_WEIGHTS.pointerEvents).toBeGreaterThan(VISIBILITY_WEIGHTS.area)
  })
})

describe('visibility facts from the page', () => {
  it('accepts a complete measurement', () => {
    expect(readElementFacts(facts())).toEqual(facts())
  })

  it('keeps the name of what covers the element', () => {
    expect(readElementFacts(facts({ coveredBy: 'div#consent role=dialog' })).coveredBy).toBe('div#consent role=dialog')
  })

  it('rejects a measurement whose text, link, cover, or aria-hidden field has the wrong type', () => {
    expect(() => readElementFacts({ ...facts(), name: 7 })).toThrow('the visibility probe returned no name')
    expect(() => readElementFacts({ ...facts(), href: 7 })).toThrow('the visibility probe returned no href')
    expect(() => readElementFacts({ ...facts(), coveredBy: 7 })).toThrow('the visibility probe returned no coveredBy')
    expect(() => readElementFacts({ ...facts(), ariaHidden: 'false' })).toThrow('the visibility probe returned no ariaHidden')
  })

  it('rejects a measurement that is missing a field', () => {
    const { width: _width, ...partial } = facts()
    expect(() => readElementFacts(partial)).toThrow('the visibility probe returned no width')
  })

  it('rejects a measurement whose number arrived as text', () => {
    expect(() => readElementFacts({ ...facts(), opacity: '1' })).toThrow('the visibility probe returned no opacity')
  })

  it('rejects a value that is not an object at all', () => {
    expect(() => readElementFacts(null)).toThrow('the visibility probe returned no object')
  })
})
