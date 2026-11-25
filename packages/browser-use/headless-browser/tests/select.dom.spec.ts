// @vitest-environment jsdom

/**
 * The option probes inside a document: the options of a native select, which
 * inputs are searchable dropdowns, and the visible options of the list such an
 * input controls. jsdom computes no layout, so each case gives the option boxes
 * a page would have; the matching on top of these options is fixed in
 * `select.spec.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isComboboxInput, matchOption, readComboboxOptions, readOptions, readSelectOptions } from '../src/select.ts'

/** Border box sizes by element; an element without one has no box. */
let sizes = new Map<Element, readonly [number, number]>()

beforeEach(() => {
  sizes = new Map()
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element): DOMRect {
    const [width, height] = sizes.get(this) ?? [0, 0]
    return new DOMRect(0, 0, width, height)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

/** The element a selector names; a missing one fails the test. */
function find(selector: string): Element {
  const found = document.querySelector(selector)
  if (found === null) throw new Error(`the fixture has no ${selector}`)
  return found
}

/** Give every element a selector matches a visible box. */
function show(selector: string): void {
  for (const element of Array.from(document.querySelectorAll(selector))) sizes.set(element, [240, 32])
}

describe('reading a native select', () => {
  it('lists every option with the label a person reads, its value, and whether it is disabled', () => {
    document.body.innerHTML = '<select id="country"><option value="">Select…</option><option value="US">United States</option>'
      + '<option value="MX" disabled>Mexico</option><option label="UK" value="GB">United Kingdom</option></select>'
    const options = readOptions(find('#country'))
    expect(options).toEqual([
      { label: 'Select…', value: '', disabled: false },
      { label: 'United States', value: 'US', disabled: false },
      { label: 'Mexico', value: 'MX', disabled: true },
      { label: 'UK', value: 'GB', disabled: false },
    ])
    expect(matchOption(readSelectOptions(options), 'united')).toBe(1)
  })

  it('lists nothing for an element that is not a select', () => {
    document.body.innerHTML = '<input id="country" list="countries">'
    expect(readOptions(find('#country'))).toEqual([])
  })
})

describe('recognising a searchable dropdown', () => {
  it('accepts an input that names itself a combobox or autocompletes from a list', () => {
    document.body.innerHTML = '<input id="role" role="combobox"><input id="list" aria-autocomplete="list"><input id="both" aria-autocomplete="both">'
    expect(['#role', '#list', '#both'].map(selector => isComboboxInput(find(selector)))).toEqual([true, true, true])
  })

  it('refuses a plain input, an inline-completing input, and a combobox that is not an input', () => {
    document.body.innerHTML = '<input id="plain"><input id="inline" aria-autocomplete="inline"><div id="widget" role="combobox"></div>'
    expect(['#plain', '#inline', '#widget'].map(selector => isComboboxInput(find(selector)))).toEqual([false, false, false])
  })
})

describe('reading the options a combobox controls', () => {
  it('lists the visible options with an id, by their folded text, and marks the disabled ones', () => {
    document.body.innerHTML = '<input id="city" role="combobox" aria-controls="cities" aria-expanded="true">'
      + '<div id="cities" role="listbox">'
      + '<div role="option" id="nyc">  New\n  York </div>'
      + '<div role="option" id="ewr" aria-disabled="true">Newark</div>'
      + '<div role="option" id="bos" aria-disabled="false">Boston</div>'
      + '<div role="option" id="gone">Collapsed</div>'
      + '<div role="option" id="flat">Flat</div>'
      + '<div role="option" class="no-id">No id</div>'
      + '</div>'
    show('#nyc, #ewr, #bos, .no-id')
    sizes.set(find('#flat'), [240, 0])
    expect(readComboboxOptions(find('#city'))).toEqual([
      { label: 'New York', value: 'nyc', disabled: false },
      { label: 'Newark', value: 'ewr', disabled: true },
      { label: 'Boston', value: 'bos', disabled: false },
    ])
  })

  it('follows aria-owns when the input names no aria-controls', () => {
    document.body.innerHTML = '<input id="zone" aria-autocomplete="list" aria-owns="zones"><ul id="zones"><li role="option" id="utc">UTC</li></ul>'
    show('#utc')
    expect(readComboboxOptions(find('#zone'))).toEqual([{ label: 'UTC', value: 'utc', disabled: false }])
  })

  it('lists nothing while the input names no list, an empty id, or a list that is not on the page', () => {
    document.body.innerHTML = '<input id="closed" role="combobox"><input id="blank" role="combobox" aria-controls="">'
      + '<input id="missing" role="combobox" aria-controls="not-rendered-yet">'
    expect(['#closed', '#blank', '#missing'].map(selector => readComboboxOptions(find(selector)))).toEqual([[], [], []])
  })
})
