// @vitest-environment jsdom

/**
 * The near-miss probe inside a document: which elements a page names by a
 * miss's words, the role and selector each one is reported with, and the field
 * that sits next to a question. jsdom computes no layout and has no
 * `innerText`, `checkVisibility`, or `CSS.escape`, so each case gives the boxes
 * a page would draw and installs the engine features it relies on. The
 * selector and advice arithmetic is fixed in `near-miss.spec.ts`, and a real
 * Chromium runs the probe in `near-miss.browser.spec.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findNamedElements, type NameKey } from '../src/near-miss.ts'

/** Elements with a drawn border box; every other element has none. */
let drawn = new Set<Element>()

beforeEach(() => {
  drawn = new Set()
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element): DOMRect {
    return drawn.has(this) ? new DOMRect(0, 0, 120, 24) : new DOMRect(0, 0, 0, 0)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

/** Replace the body and draw every element in it. */
function mount(html: string): void {
  document.body.innerHTML = html
  for (const element of Array.from(document.body.querySelectorAll('*'))) drawn.add(element)
}

/** The element a selector names; a missing one fails the test. */
function find(selector: string): Element {
  const found = document.querySelector(selector)
  if (found === null) throw new Error(`the fixture has no ${selector}`)
  return found
}

const words = (text: string): NameKey => ({ text, exact: false })

describe('which element a miss meant', () => {
  it('reports the control around a span that carries the words, not the span', () => {
    mount('<button id="apply"><span>Apply</span></button>')
    expect(findNamedElements(words('apply'))).toEqual([
      { tag: 'button', role: 'button', via: 'text', name: 'Apply', visible: true, idSelector: '#apply' },
    ])
  })

  it('reports the innermost plain text that holds the words, with the one field next to it', () => {
    mount('<section><div class="field"><p>Please provide your <b>zip code</b></p><div><input id="zip"></div></div></section>')
    expect(findNamedElements(words('ZIP  code'))).toEqual([
      { tag: 'b', via: 'text', name: 'zip code', visible: true, field: '#zip' },
    ])
  })

  it('names no field when two sit next to the question, or none sits within four levels of it', () => {
    mount('<div><p>Phone number</p><input id="area"><input id="local"></div>'
      + '<div><input id="far"><div><div><div><div><p>Fax number</p></div></div></div></div></div>'
      + '<p>Pager number</p>')
    expect(findNamedElements(words('number')).map(entry => [entry.name, entry.field])).toEqual([
      ['Phone number', undefined], ['Fax number', undefined], ['Pager number', undefined],
    ])
  })

  it('keeps a label and drops the control inside it that carries the same words', () => {
    mount('<label id="terms">I accept the terms <input type="checkbox" aria-label="I accept the terms"></label>')
    expect(findNamedElements(words('accept'))).toEqual([
      { tag: 'label', via: 'text', name: 'I accept the terms', visible: true, idSelector: '#terms' },
    ])
  })

  it('compares exact words with the whole name', () => {
    mount('<button>Apply now</button><button>Apply</button>')
    expect(findNamedElements({ text: 'apply', exact: true }).map(entry => entry.name)).toEqual(['Apply'])
  })

  it('compares a regular expression with every match, ignoring its global and sticky flags', () => {
    mount('<button>Zip code</button><button>Zip code</button><button>Postcode</button>')
    expect(findNamedElements({ text: '^zip', flags: 'giy', exact: false })).toHaveLength(2)
  })

  it('finds nothing for a regular expression that does not compile or for blank words', () => {
    mount('<button>Apply</button>')
    expect(findNamedElements({ text: '(', flags: '', exact: false })).toEqual([])
    expect(findNamedElements(words('  '))).toEqual([])
  })

  it('takes no paragraph-long text as the name of contained words', () => {
    mount(`<p id="long">${'Apply '.repeat(17)}</p><p id="short">${'Apply '.repeat(12)}</p>`)
    expect(findNamedElements(words('apply')).map(entry => entry.idSelector)).toEqual(['#short'])
  })

  it('takes no name longer than three hundred characters for exact words', () => {
    const long = 'a'.repeat(301)
    mount(`<button aria-label="${long}">Go</button>`)
    expect(findNamedElements({ text: long, exact: true })).toEqual([])
  })

  it('skips scripts, styles, templates, and drawings', () => {
    document.body.innerHTML = '<script aria-label="Apply"></script><style aria-label="Apply"></style><noscript aria-label="Apply"></noscript>'
      + '<template aria-label="Apply"></template><svg aria-label="Apply"><path aria-label="Apply"></path></svg>'
    expect(findNamedElements(words('apply'))).toEqual([])
  })

  it('names no select or text area by the text inside it', () => {
    mount('<textarea>Apply</textarea><select><option id="choice">Apply</option></select>')
    expect(findNamedElements(words('apply'))).toEqual([
      { tag: 'option', role: 'option', via: 'text', name: 'Apply', visible: true, idSelector: '#choice' },
    ])
  })

  it('finds nothing on a document without a body', () => {
    vi.spyOn(document, 'body', 'get').mockReturnValue(null as never)
    expect(findNamedElements(words('apply'))).toEqual([])
  })
})

describe('the name an element is reported by', () => {
  it('reads the label every naming attribute gives, skipping a missing labelled-by id', () => {
    mount('<span id="home">Home</span><a href="/" aria-labelledby="home gone">⌂</a>'
      + '<input id="mail" placeholder="Email address"><input id="phone" title="Phone"><button aria-label="Close">×</button>'
      + '<input type="submit" value="Submit"><input type="text" value="Submit later"><input type="hidden" value="Submit">')
    expect(findNamedElements(words('home')).map(entry => [entry.tag, entry.via, entry.name])).toEqual([['span', 'text', 'Home'], ['a', 'label', 'Home']])
    expect(findNamedElements(words('email')).map(entry => [entry.via, entry.name])).toEqual([['placeholder', 'Email address']])
    expect(findNamedElements(words('phone')).map(entry => [entry.via, entry.name])).toEqual([['title', 'Phone']])
    expect(findNamedElements(words('close')).map(entry => [entry.via, entry.name])).toEqual([['aria-label', 'Close']])
    expect(findNamedElements(words('submit')).map(entry => [entry.tag, entry.via, entry.name])).toEqual([['input', 'text', 'Submit']])
  })

  it('names a field by its label, and reports the label too', () => {
    mount('<label for="email">Work email</label><input id="email">')
    expect(findNamedElements(words('work email')).map(entry => [entry.tag, entry.via])).toEqual([['label', 'text'], ['input', 'label']])
  })

  it('reports the rendered text where the engine provides it', () => {
    mount('<button id="save">Save<span hidden>draft copy</span></button>')
    Object.defineProperty(find('#save'), 'innerText', { value: 'Save' })
    expect(findNamedElements(words('save'))[0]?.name).toBe('Save')
  })
})

describe('the role an element is reported with', () => {
  it.each([
    ['<a href="/jobs" aria-label="Target">x</a>', 'link'],
    ['<a aria-label="Target">x</a>', undefined],
    ['<div role="  menuitem option" aria-label="Target">x</div>', 'menuitem'],
    ['<div role=" " aria-label="Target">x</div>', undefined],
    ['<button aria-label="Target">x</button>', 'button'],
    ['<details><summary aria-label="Target">x</summary></details>', 'button'],
    ['<select multiple aria-label="Target"></select>', 'listbox'],
    ['<select aria-label="Target"></select>', 'combobox'],
    ['<textarea aria-label="Target"></textarea>', 'textbox'],
    ['<select><option aria-label="Target">x</option></select>', 'option'],
    ['<h3 aria-label="Target">x</h3>', 'heading'],
    ['<section aria-label="Target">x</section>', undefined],
    ['<input type="checkbox" aria-label="Target">', 'checkbox'],
    ['<input type="radio" aria-label="Target">', 'radio'],
    ['<input type="submit" aria-label="Target">', 'button'],
    ['<input type="image" aria-label="Target">', 'button'],
    ['<input type="number" aria-label="Target">', 'spinbutton'],
    ['<input type="search" aria-label="Target">', 'searchbox'],
    ['<input type="range" aria-label="Target">', 'slider'],
    ['<input type="email" aria-label="Target">', 'textbox'],
    ['<input type="date" aria-label="Target">', undefined],
    ['<input type="hidden" aria-label="Target">', undefined],
  ])('reports %s with role %s', (html, role) => {
    mount(html)
    const [found] = findNamedElements(words('target'))
    expect(found?.name).toBe('Target')
    expect(found?.role).toBe(role)
  })
})

describe('what the probe says about where an element is', () => {
  it('lists drawn elements before hidden ones, and a box the engine hides as hidden', () => {
    mount('<button id="collapsed">Apply</button><button id="faded">Apply</button><button id="shown">Apply</button>')
    drawn.delete(find('#collapsed'))
    Object.defineProperty(find('#faded'), 'checkVisibility', { value: () => false })
    Object.defineProperty(find('#shown'), 'checkVisibility', { value: () => true })
    expect(findNamedElements(words('apply')).map(entry => [entry.idSelector, entry.visible]))
      .toEqual([['#shown', true], ['#collapsed', false], ['#faded', false]])
  })

  it('reports at most the first two hundred matches in document order', () => {
    document.body.innerHTML = `${'<p>Apply</p>'.repeat(200)}<p id="late">Apply</p>`
    drawn.add(find('#late'))
    expect(findNamedElements(words('apply')).map(entry => entry.visible)).toEqual([false, false, false])
  })

  it('names an element by its id only when the id is unique, escaping what CSS reads as syntax', () => {
    mount('<button id="a.b:c">Apply</button><button id="twin">Apply</button><button id="twin">Apply</button><button>Apply</button>')
    expect(findNamedElements(words('apply')).map(entry => entry.idSelector)).toEqual(['#a\\.b\\:c', undefined, undefined])
  })

  it('escapes an id with the engine’s CSS.escape where there is one', () => {
    vi.stubGlobal('CSS', { escape: (value: string) => value.replace('.', '\\2e ') })
    document.body.innerHTML = '<button id="a.b">Apply</button>'
    expect(findNamedElements(words('apply'))[0]?.idSelector).toBe('#a\\2e b')
  })
})
