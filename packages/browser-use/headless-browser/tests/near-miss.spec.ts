/**
 * What a selector miss tells the model: the words a selector names its target
 * by, the selectors suggested for an element the page names that way, and the
 * one line of advice the miss carries. A real Chromium finds the elements in
 * `near-miss.browser.spec.ts`.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_MISS_ADVICE, findNearMisses, missAdvice, selectorKey, selectorsFor, type NamedElement, type NearMiss } from '../src/near-miss.ts'

describe('the words a selector names its target by', () => {
  it.each([
    ['role=button[name=\'Apply Now\']', { text: 'Apply Now', exact: false }],
    ['role=button[name=/^Save and Continue$/i]', { text: '^Save and Continue$', flags: 'i', exact: false }],
    ['button:text-is(\'Submit Application\')', { text: 'Submit Application', exact: true }],
    ['a:has-text("Candidate Home")', { text: 'Candidate Home', exact: false }],
    ['text=/^New York$/', { text: '^New York$', flags: '', exact: false }],
    ['[role=listbox] >> text="Yes"', { text: 'Yes', exact: true }],
    ['text=Apply', { text: 'Apply', exact: false }],
    [':text-matches("zip code", "i")', { text: 'zip code', flags: 'i', exact: false }],
    [':text-matches(\'zip code\', \'i\')', { text: 'zip code', flags: 'i', exact: false }],
    [':text-matches("zip code")', { text: 'zip code', flags: '', exact: false }],
    ['input[placeholder="Search"]', { text: 'Search', exact: false }],
    ['internal:label="Preferred Contact Method"i', { text: 'Preferred Contact Method', exact: false }],
    ['button:has-text(\'It\\\'s me\')', { text: "It's me", exact: false }],
  ])('reads %s', (selector, key) => {
    expect(selectorKey(selector)).toEqual(key)
  })

  it('takes the last part that names words, since earlier parts are context', () => {
    expect(selectorKey('.ant-form-item:has-text(\'Are you legally authorized\') label:has-text(\'Yes\')')).toEqual({ text: 'Yes', exact: false })
    expect(selectorKey('[data-automation-id=\'menuItem\']:text-is(\'New York\'), li:text-is(\'Boston\')')).toEqual({ text: 'Boston', exact: true })
  })

  it('finds no words in a selector that names only structure', () => {
    expect(selectorKey('input[type=email] >> nth=1')).toBeUndefined()
    expect(selectorKey('#nowhere')).toBeUndefined()
    expect(selectorKey('input[name=\'email\']')).toBeUndefined()
  })

  it('finds no words in a selector whose words are blank', () => {
    expect(selectorKey('text=  ')).toBeUndefined()
    expect(selectorKey('button:has-text("  ")')).toBeUndefined()
  })
})

const link: NamedElement = { tag: 'a', role: 'link', via: 'text', name: 'Apply Now', visible: true }

describe('the selectors suggested for a named element', () => {
  it('names a role first, then the text, then a unique id', () => {
    expect(selectorsFor({ ...link, idSelector: '#apply' })).toEqual(['role=link[name="Apply Now"]', 'text="Apply Now"', '#apply'])
  })

  it('names a field by its placeholder', () => {
    expect(selectorsFor({ tag: 'input', role: 'textbox', via: 'placeholder', name: 'Search', visible: true })).toEqual(['[placeholder="Search"]'])
  })

  it('quotes no paragraph-long name', () => {
    expect(selectorsFor({ tag: 'p', via: 'text', name: 'x'.repeat(81), visible: true, idSelector: '#intro' })).toEqual(['#intro'])
  })

  it('keeps the first suggestion that matches on the page', async () => {
    const counts: Record<string, number> = { 'role=link[name="Apply Now"]': 0, 'text="Apply Now"': 2 }
    const page = {
      evaluate: async () => [link],
      locator: (selector: string) => ({ count: async () => counts[selector] ?? 0 }),
    } as never
    expect(await findNearMisses(page, { text: 'Apply Now', exact: false })).toEqual([{ element: link, selector: 'text="Apply Now"', count: 2 }])
  })

  it('passes over a suggestion the page cannot count', async () => {
    const page = {
      evaluate: async () => [link],
      locator: (selector: string) => ({ count: async () => selector.startsWith('role=') ? await Promise.reject(new Error('detached')) : 1 }),
    } as never
    expect(await findNearMisses(page, { text: 'Apply Now', exact: false })).toEqual([{ element: link, selector: 'text="Apply Now"', count: 1 }])
  })
})

describe('the advice a miss carries', () => {
  const miss = (element: NamedElement, selector: string, count = 1): NearMiss => ({ element, selector, count })

  it('keeps the old advice for a selector that names no words', () => {
    expect(missAdvice(undefined, [])).toBe(DEFAULT_MISS_ADVICE)
  })

  it('lists each element the page names that way, with what kind it is', () => {
    const option: NamedElement = { tag: 'div', via: 'text', name: 'New York', visible: true }
    const hidden: NamedElement = { tag: 'li', role: 'option', via: 'text', name: 'New York', visible: false }
    expect(missAdvice({ text: 'New York', exact: true }, [miss(option, 'text="New York"', 2), miss(hidden, 'role=option[name="New York"]')]))
      .toBe('the page names "New York" on text="New York" (<div>, 2 matches); role=option[name="New York"] (<li>, hidden). Retry with one of these selectors')
  })

  it('names the field next to a label-like text', () => {
    const label: NamedElement = { tag: 'div', via: 'text', name: 'Please provide your current zip code', visible: true, field: '#zip' }
    expect(missAdvice({ text: 'zip code', flags: '', exact: false }, [miss(label, 'text="Please provide your current zip code"')]))
      .toBe('the page names /zip code/ on text="Please provide your current zip code" (<div>, its field is #zip). Retry with one of these selectors')
  })

  it('says when nothing on the page carries the words, so the step may still be loading', () => {
    expect(missAdvice({ text: 'Submit', exact: true }, []))
      .toBe('nothing on the page is named "Submit" either, so the step may not have loaded; read the page before retrying')
  })
})
