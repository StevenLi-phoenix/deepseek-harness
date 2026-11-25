// @vitest-environment jsdom

/**
 * The visibility probe inside a document: the name a person reads, the
 * ancestors that hide, fade, or clip an element, what a click at its sampled
 * points reaches, and the overlay that takes a covered button's click. jsdom
 * computes styles but no layout, so each case places the boxes and paints the
 * hit-test order a page would have. The score arithmetic is fixed in
 * `visibility.spec.ts`, and a real Chromium runs the probe in
 * `guard.browser.spec.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findSameNameCover, probeElement, readElementFacts, scoreVisibility } from '../src/visibility.ts'

/** A box in viewport CSS pixels. */
interface Box {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

const NO_BOX: Box = { left: 0, top: 0, width: 0, height: 0 }

/** The element a hit test reports for a node, as seen from one tree scope. */
function retarget(element: Element, scope: Document | ShadowRoot): Element {
  let current = element
  for (let root = current.getRootNode(); root !== scope && root instanceof ShadowRoot; root = current.getRootNode()) current = root.host
  return current
}

/**
 * The layout jsdom leaves out, for one test: each element's border box and
 * client box, the paint order a hit test walks topmost first, and the
 * `scrollIntoView` calls the probe makes.
 */
class Layout {
  readonly scrolls: Array<boolean | ScrollIntoViewOptions | undefined> = []
  readonly #boxes = new Map<Element, Box>()
  readonly #clients = new Map<Element, Box>()
  readonly #blind = new Set<ShadowRoot>()
  readonly #unreported = new Set<Element>()
  #painted: readonly Element[] = []

  /** Give an element its border box. */
  place(element: Element, box: Box): this {
    this.#boxes.set(element, box)
    return this
  }

  /** Give an element a client box, as offsets inside its border box. */
  client(element: Element, box: Box): this {
    this.#clients.set(element, box)
    return this
  }

  /** Set the paint order a hit test walks, topmost first. */
  paint(...elements: Element[]): this {
    this.#painted = elements
    return this
  }

  /** Make a shadow root's own hit test report nothing. */
  blind(root: ShadowRoot): this {
    this.#blind.add(root)
    return this
  }

  /** Report an empty computed opacity for an element, as a browser does for an unstyled one. */
  unreported(element: Element): this {
    this.#unreported.add(element)
    return this
  }

  install(): void {
    const boxOf = (element: Element): Box => this.#boxes.get(element) ?? NO_BOX
    const clientOf = (element: Element): Box => {
      const box = boxOf(element)
      return this.#clients.get(element) ?? { left: 0, top: 0, width: box.width, height: box.height }
    }
    const stack = (scope: Document | ShadowRoot, x: number, y: number): Element[] => {
      const hits = this.#painted
        .filter((element) => {
          const box = boxOf(element)
          return x >= box.left && x <= box.left + box.width && y >= box.top && y <= box.top + box.height
        })
        .map(element => retarget(element, scope))
      return [...new Set(hits)]
    }
    const blind = this.#blind
    const unreported = this.#unreported
    const scrolls = this.scrolls
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element): DOMRect {
      const box = boxOf(this)
      return new DOMRect(box.left, box.top, box.width, box.height)
    })
    vi.spyOn(Element.prototype, 'clientLeft', 'get').mockImplementation(function (this: Element): number { return clientOf(this).left })
    vi.spyOn(Element.prototype, 'clientTop', 'get').mockImplementation(function (this: Element): number { return clientOf(this).top })
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element): number { return clientOf(this).width })
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element): number { return clientOf(this).height })
    const computed = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null): CSSStyleDeclaration => {
      const style = computed(element, pseudo)
      if (unreported.has(element)) Object.defineProperty(style, 'opacity', { value: '' })
      return style
    })
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: (x: number, y: number): Element[] => stack(document, x, y),
    })
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: (x: number, y: number): Element | null => stack(document, x, y)[0] ?? null,
    })
    Object.defineProperty(ShadowRoot.prototype, 'elementFromPoint', {
      configurable: true,
      value: function (this: ShadowRoot, x: number, y: number): Element | null {
        return blind.has(this) ? null : stack(this, x, y)[0] ?? null
      },
    })
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: (options?: boolean | ScrollIntoViewOptions): void => { scrolls.push(options) },
    })
  }

  uninstall(): void {
    vi.restoreAllMocks()
    Reflect.deleteProperty(document, 'elementsFromPoint')
    Reflect.deleteProperty(document, 'elementFromPoint')
    Reflect.deleteProperty(ShadowRoot.prototype, 'elementFromPoint')
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  }
}

let layout = new Layout()

beforeEach(() => {
  layout = new Layout()
  layout.install()
})

afterEach(() => {
  layout.uninstall()
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('style')
  document.body.removeAttribute('style')
})

/** Replace the document body. */
function mount(html: string): void {
  document.body.innerHTML = html
}

/** The element a selector names; a missing one fails the test. */
function find(selector: string, root: ParentNode = document): Element {
  const found = root.querySelector(selector)
  if (found === null) throw new Error(`the fixture has no ${selector}`)
  return found
}

describe('naming the control a person reads', () => {
  it('joins the text of every element aria-labelledby names', () => {
    mount('<span id="ship">Ship</span><span id="where">  to\n home </span><button aria-labelledby="ship where gone">→</button>')
    expect(probeElement(find('button')).name).toBe('Ship to home')
  })

  it('falls back to aria-label, then the text, when aria-labelledby names nothing', () => {
    mount('<button id="close" aria-labelledby="gone" aria-label="Close dialog">×</button>'
      + '<button id="save" aria-labelledby=" " aria-label=" ">Save  draft</button>')
    expect(probeElement(find('#close')).name).toBe('Close dialog')
    expect(probeElement(find('#save')).name).toBe('Save draft')
  })

  it('names a submit, button, or reset input by its value', () => {
    mount('<input type="submit" id="send" value="Send"><input type="button" id="preview" value="Preview">'
      + '<input type="reset" id="clear" value="Clear">')
    expect(['#send', '#preview', '#clear'].map(selector => probeElement(find(selector)).name)).toEqual(['Send', 'Preview', 'Clear'])
  })

  it('names a field by its label, then its placeholder, then its title, then its text', () => {
    mount([
      '<label for="email">Work <b>email</b></label><input id="email">',
      '<label for="query"></label><input id="query" placeholder="Search jobs">',
      '<input id="zip" placeholder=" " title="Postcode">',
      '<textarea id="letter" title=" ">Dear team</textarea>',
      '<label>Country <select id="country"><option>Canada</option></select></label>',
      '<input type="hidden" id="token" value="abc">',
    ].join(''))
    expect(['#email', '#query', '#zip', '#letter', '#country', '#token'].map(selector => probeElement(find(selector)).name))
      .toEqual(['Work email', 'Search jobs', 'Postcode', 'Dear team', 'Country Canada', ''])
  })

  it('names an image by its alt text, and an element without text by its title', () => {
    mount('<img id="logo" alt="Acme logo"><img id="blank" alt=" " title=" Acme "><img id="bare" src="x.png">'
      + '<a id="map" href="/map" title=" Map "></a><button id="empty"></button>')
    expect(['#logo', '#blank', '#bare', '#map', '#empty'].map(selector => probeElement(find(selector)).name))
      .toEqual(['Acme logo', 'Acme', '', 'Map', ''])
  })
})

describe('measuring what a person sees', () => {
  it('scrolls the element to the centre of the view and reports a clear target in full', () => {
    mount('<form action="/apply"><button id="go">Apply now</button></form>')
    const button = find('#go')
    layout.place(button, { left: 100, top: 100, width: 120, height: 32 }).paint(button)
    const facts = probeElement(button)
    expect(layout.scrolls).toEqual([{ block: 'center', inline: 'center', behavior: 'instant' }])
    expect(facts).toEqual({
      name: 'Apply now',
      value: '',
      href: null,
      formAction: 'http://localhost:3000/apply',
      tag: 'button',
      role: null,
      display: 'inline-block',
      visibility: 'visible',
      opacity: 1,
      pointerEvents: 'auto',
      ariaHidden: false,
      ariaHiddenOwn: false,
      width: 120,
      height: 32,
      viewportFraction: 1,
      occlusion: 1,
      clippedBy: 0,
      clippingFraction: 1,
    })
    expect(readElementFacts(facts)).toEqual(facts)
    expect(scoreVisibility(facts).score).toBe(1)
  })

  it('refuses an element whose document has no window', () => {
    const detached = document.implementation.createHTMLDocument('detached')
    detached.body.innerHTML = '<button>Go</button>'
    expect(() => probeElement(find('button', detached))).toThrow('the element has no window to measure')
  })

  it('tells an element\'s own aria-hidden from one it inherits', () => {
    mount('<div aria-hidden="true"><button id="next">Next</button></div><button id="decoy" aria-hidden="true">Verify</button>')
    expect(probeElement(find('#next'))).toMatchObject({ ariaHidden: true, ariaHiddenOwn: false })
    expect(probeElement(find('#decoy'))).toMatchObject({ ariaHidden: true, ariaHiddenOwn: true })
  })

  it('reports an ancestor that is not displayed, aria-hidden, invisible, or not hittable', () => {
    mount('<div style="display:none" aria-hidden="true"><div style="visibility:hidden; pointer-events:none"><button id="go">Go</button></div></div>')
    expect(probeElement(find('#go'))).toMatchObject({ display: 'none', ariaHidden: true, visibility: 'hidden', pointerEvents: 'none' })
  })

  it('multiplies the opacity of the element and every ancestor, skipping one the browser does not report', () => {
    mount('<div style="opacity:0.5"><div id="row"><button id="go" style="opacity:0.5">Go</button></div></div>')
    layout.unreported(find('#row'))
    expect(probeElement(find('#go')).opacity).toBe(0.25)
  })

  it('keeps the part of the box its clipping ancestors leave, inside their client boxes', () => {
    mount('<div id="list" style="overflow-x:hidden"><div id="pane" style="overflow-y:auto"><div>'
      + '<input id="name" style="overflow-x:clip; overflow-y:clip"></div></div></div>')
    document.documentElement.style.overflowX = 'hidden'
    document.body.style.overflowX = 'hidden'
    const list = find('#list')
    const input = find('#name')
    layout
      .place(list, { left: 0, top: 0, width: 100, height: 500 })
      .client(list, { left: 2, top: 0, width: 96, height: 500 })
      .place(find('#pane'), { left: 0, top: 0, width: 400, height: 40 })
      .place(input, { left: 50, top: 20, width: 100, height: 40 })
      .paint(input)
    // Visible x runs 50..98 inside the list's client box, visible y 20..40 inside the pane.
    expect(probeElement(input)).toMatchObject({ clippedBy: 2, clippingFraction: 0.24, viewportFraction: 0.24, occlusion: 1 })
  })

  it('counts only the part of the box inside the viewport', () => {
    mount('<button id="fold">Below the fold</button><button id="right">Off to the right</button>'
      + '<button id="below">Off the bottom</button><button id="none">No box</button>')
    const fold = find('#fold')
    const right = find('#right')
    const below = find('#below')
    layout
      .place(fold, { left: 10, top: 700, width: 100, height: 136 })
      .place(right, { left: 2000, top: 10, width: 100, height: 20 })
      .place(below, { left: 10, top: 900, width: 100, height: 20 })
      .paint(fold, right, below)
    expect(probeElement(fold)).toMatchObject({ viewportFraction: 0.5, occlusion: 1 })
    for (const element of [right, below, find('#none')]) {
      const facts = probeElement(element)
      expect(facts).toMatchObject({ viewportFraction: 0, occlusion: 0 })
      expect(facts.coveredBy).toBeUndefined()
    }
  })
})

describe('what a click at the element reaches', () => {
  it('counts the sampled points a banner covers and names the banner', () => {
    mount('<button id="go">Continue</button><div id="consent" class="backdrop dim wide" role="dialog" aria-label="Cookie consent"></div>')
    const button = find('#go')
    const consent = find('#consent')
    layout
      .place(button, { left: 100, top: 100, width: 200, height: 40 })
      .place(consent, { left: 0, top: 0, width: 220, height: 768 })
      .paint(consent, button)
    // The banner ends at x 220: the centre and the two left points land on it.
    expect(probeElement(button)).toMatchObject({
      occlusion: 0.4,
      coveredBy: 'div#consent .backdrop .dim role=dialog "Cookie consent"',
    })
  })

  it('names a cover by its text when it has no label, and by its tag alone when it has neither', () => {
    const notice = 'We use cookies to run this site and to measure how visitors use it'
    mount('<button id="go">Accept</button><section id="notice">We use   cookies to run this site and to measure how visitors use it</section>')
    const button = find('#go')
    const box: Box = { left: 0, top: 0, width: 200, height: 40 }
    layout.place(button, box).place(find('#notice'), box).paint(find('#notice'), button)
    expect(probeElement(button).coveredBy).toBe(`section#notice ${JSON.stringify(notice.slice(0, 60))}`)
    const scrim = document.createElement('div')
    document.body.append(scrim)
    layout.place(scrim, box).paint(scrim, button)
    expect(probeElement(button)).toMatchObject({ occlusion: 0, coveredBy: 'div' })
  })

  it('counts a point on the element\'s own child as a hit and a point on nothing as a miss', () => {
    mount('<a id="job" href="/jobs/7"><span id="title">Engineer</span></a>')
    const title = find('#title')
    layout
      .place(find('#job'), { left: 0, top: 0, width: 200, height: 40 })
      .place(title, { left: 0, top: 0, width: 100, height: 40 })
      .paint(title)
    // The points at x 50 and 100 reach the title inside the link; the two at x 150 reach nothing.
    const facts = probeElement(find('#job'))
    expect(facts).toMatchObject({ occlusion: 0.6, href: 'http://localhost:3000/jobs/7', name: 'Engineer' })
    expect(facts.coveredBy).toBeUndefined()
  })

  it('follows open shadow roots down to the field a click reaches', () => {
    mount('<div id="outer"></div>')
    const outer = find('#outer')
    const outerRoot = outer.attachShadow({ mode: 'open' })
    outerRoot.innerHTML = '<div id="inner"></div>'
    const inner = find('#inner', outerRoot)
    const innerRoot = inner.attachShadow({ mode: 'open' })
    innerRoot.innerHTML = '<label>First name <input id="first"></label>'
    const input = find('#first', innerRoot)
    const box: Box = { left: 100, top: 100, width: 200, height: 30 }
    layout.place(input, box).place(inner, box).place(outer, box).paint(input, inner, outer)
    expect(probeElement(input)).toMatchObject({ name: 'First name', occlusion: 1 })
  })

  it('counts the shadow host as the hit when its root reports the host itself or nothing', () => {
    mount('<div id="host"></div>')
    const host = find('#host')
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = '<span id="price">€ 40</span>'
    const price = find('#price', root)
    const box: Box = { left: 0, top: 0, width: 100, height: 20 }
    layout.place(price, box).place(host, box).paint(host)
    expect(probeElement(price).occlusion).toBe(1)
    layout.blind(root)
    expect(probeElement(price).occlusion).toBe(1)
  })

  it('counts a closed shadow host as the hit for a field inside it, and names a cover over it', () => {
    mount('<div id="host"></div><div id="cover"></div>')
    const host = find('#host')
    const root = host.attachShadow({ mode: 'closed' })
    root.innerHTML = '<label><input type="checkbox" id="agree"> I agree</label>'
    const agree = find('#agree', root)
    const box: Box = { left: 0, top: 0, width: 20, height: 20 }
    layout.place(agree, box).place(host, box).paint(agree, host)
    expect(probeElement(agree)).toMatchObject({ name: 'I agree', occlusion: 1 })
    layout.place(find('#cover'), box).paint(find('#cover'), agree, host)
    expect(probeElement(agree)).toMatchObject({ occlusion: 0, coveredBy: 'div#cover' })
  })
})

describe('a styled checkbox or radio', () => {
  it('measures a transparent checkbox by the box painted right under it', () => {
    mount('<div><input type="checkbox" id="terms" style="opacity:0"><span id="box"></span><label for="terms">I accept the terms</label></div>')
    const terms = find('#terms')
    const box = find('#box')
    layout
      .place(terms, { left: 10, top: 10, width: 20, height: 20 })
      .place(box, { left: 10, top: 10, width: 20, height: 20 })
      .paint(terms, box)
      .unreported(document.body)
    expect(probeElement(terms).opacity).toBe(1)
  })

  it('measures a transparent radio by its label when the box under it is the page', () => {
    mount('<label for="remote">Remote</label><input type="radio" id="remote" name="where" style="opacity:0.02">')
    const radio = find('#remote')
    layout
      .place(radio, { left: 10, top: 10, width: 20, height: 20 })
      .place(find('label'), { left: 40, top: 10, width: 80, height: 20 })
      .place(document.body, { left: 0, top: 0, width: 1024, height: 2000 })
      .paint(radio, document.body)
    expect(probeElement(radio).opacity).toBe(1)
  })

  it('keeps a transparent checkbox transparent when nothing painted stands in for it', () => {
    mount('<input type="checkbox" id="opt" style="opacity:0"><span id="rule"></span>'
      + '<label for="opt">No box</label><label for="opt" id="hidden" style="visibility:hidden">Hidden</label>'
      + '<label for="opt" id="faded" style="opacity:0">Faded</label>')
    const opt = find('#opt')
    const rule = find('#rule')
    layout
      .place(opt, { left: 10, top: 10, width: 20, height: 20 })
      // A thin rule across the box's middle overlaps a tenth of it.
      .place(rule, { left: 0, top: 19, width: 80, height: 2 })
      .place(find('#hidden'), { left: 40, top: 10, width: 80, height: 20 })
      .place(find('#faded'), { left: 40, top: 40, width: 80, height: 20 })
      .paint(opt, rule)
    expect(probeElement(opt).opacity).toBe(0)
  })

  it('keeps the own opacity of a transparent control that has no box, no labels list, or is not a box at all', () => {
    mount('<input type="checkbox" id="unlisted" style="opacity:0"><input type="checkbox" id="flat" style="opacity:0">'
      + '<input id="text" style="opacity:0"><button id="button" style="opacity:0">Go</button>')
    const unlisted = find('#unlisted')
    // A page script can replace the labels list; the probe then has no label to fall back on.
    Object.defineProperty(unlisted, 'labels', { value: null })
    const box: Box = { left: 10, top: 10, width: 20, height: 20 }
    layout.place(unlisted, box).place(find('#text'), box).place(find('#button'), box)
    expect(['#unlisted', '#flat', '#text', '#button'].map(selector => probeElement(find(selector)).opacity)).toEqual([0, 0, 0, 0])
  })
})

describe('a searchable dropdown', () => {
  it('aims a caret-wide combobox input at the control that holds it', () => {
    mount('<div id="control"><div id="sizer"><input id="city" aria-autocomplete="list"></div></div>')
    const input = find('#city')
    layout
      .place(input, { left: 100, top: 100, width: 2, height: 20 })
      .place(find('#sizer'), { left: 100, top: 100, width: 2, height: 20 })
      .place(find('#control'), { left: 90, top: 95, width: 200, height: 30 })
    expect(probeElement(input)).toMatchObject({ width: 200, height: 30 })
  })

  it('keeps the box of a combobox that is roomy, empty, or held by nothing roomy around its centre', () => {
    mount([
      '<input id="wide" role="combobox">',
      '<input id="empty" aria-autocomplete="both">',
      '<input id="top" aria-autocomplete="inline">',
      '<div id="room"><div id="d4"><div id="d3"><div id="d2"><div id="d1"><input id="deep" aria-autocomplete="list"></div></div></div></div></div>',
      '<input id="plain" aria-autocomplete="none">',
    ].join(''))
    const caret: Box = { left: 100, top: 100, width: 2, height: 20 }
    layout
      .place(find('#wide'), { left: 0, top: 0, width: 300, height: 30 })
      .place(find('#top'), caret)
      .place(find('#deep'), caret)
      .place(find('#plain'), caret)
      // Each of the four nearest boxes misses the input's centre (101, 110) on one side.
      .place(find('#d1'), { left: 200, top: 90, width: 100, height: 40 })
      .place(find('#d2'), { left: 0, top: 90, width: 50, height: 40 })
      .place(find('#d3'), { left: 0, top: 200, width: 300, height: 40 })
      .place(find('#d4'), { left: 0, top: 0, width: 300, height: 50 })
      .place(find('#room'), { left: 0, top: 0, width: 1000, height: 1000 })
    expect(['#wide', '#empty', '#top', '#deep', '#plain'].map(selector => probeElement(find(selector)).width)).toEqual([300, 0, 2, 2, 2])
  })
})

describe('the link and form a click would use', () => {
  it('resolves the enclosing link and the form action against the document base', () => {
    document.head.innerHTML = '<base href="https://jobs.example.com/careers/">'
    mount('<a href="apply?id=7"><span id="apply">Apply</span></a>'
      + '<form action="/submit"><button id="send">Send</button><button id="draft" formaction="draft">Save draft</button></form>'
      + '<form><input type="submit" id="go" value="Go"></form>')
    expect(probeElement(find('#apply'))).toMatchObject({ tag: 'span', href: 'https://jobs.example.com/careers/apply?id=7', formAction: null })
    expect(probeElement(find('#send'))).toMatchObject({ href: null, formAction: 'https://jobs.example.com/submit' })
    expect(probeElement(find('#draft')).formAction).toBe('https://jobs.example.com/careers/draft')
    expect(probeElement(find('#go')).formAction).toBe('https://jobs.example.com/careers/')
  })

  it('reports the current value of a field and the element\'s explicit role', () => {
    mount('<input id="name" value="Ada"><textarea id="bio">Engineer</textarea>'
      + '<select id="team"><option value="infra">Infra</option><option value="web" selected>Web</option></select>'
      + '<div id="tab" role="tab">Overview</div>')
    expect(['#name', '#bio', '#team', '#tab'].map(selector => probeElement(find(selector)).value)).toEqual(['Ada', 'Engineer', 'web', ''])
    expect(probeElement(find('#tab')).role).toBe('tab')
  })
})

describe('the overlay that takes a covered control\'s click', () => {
  it('finds the transparent overlay with the same name over a hidden button', () => {
    mount('<div><button id="real" aria-hidden="true">Submit  Application</button>'
      + '<div id="overlay" role="button" aria-label="submit application"><span id="glyph"></span></div></div>')
    const real = find('#real')
    const overlay = find('#overlay')
    const glyph = find('#glyph')
    const box: Box = { left: 100, top: 100, width: 200, height: 40 }
    layout.place(real, box).place(overlay, box).place(glyph, { left: 150, top: 105, width: 100, height: 30 }).paint(glyph, overlay, real)
    expect(findSameNameCover(real)).toBe(overlay)
  })

  it('takes a "Submit" overlay over a hidden submit button with another label, as Workday\'s sign-in draws it', () => {
    // Live roche.wd3.myworkdayjobs.com sign-in, 2026-11-25: the hidden button reads "Sign In", its click_filter overlay "Submit".
    mount('<button type="submit" id="signin" aria-hidden="true" tabindex="-2">Sign In</button>'
      + '<div id="filter" role="button" tabindex="0" aria-label="Submit" data-automation-id="click_filter"></div>'
      + '<button type="button" id="details" aria-hidden="true">Show details</button><div id="decoy" role="button" aria-label="Submit"></div>'
      + '<button id="untyped" aria-hidden="true">Sign In</button><div id="plain" role="button" aria-label="Submit"></div>')
    const box: Box = { left: 0, top: 0, width: 376, height: 40 }
    layout.place(find('#signin'), box).place(find('#filter'), box).paint(find('#filter'), find('#signin'))
    expect(findSameNameCover(find('#signin'))).toBe(find('#filter'))
    layout.place(find('#details'), box).place(find('#decoy'), box).paint(find('#decoy'), find('#details'))
    expect(findSameNameCover(find('#details'))).toBeNull()
    layout.place(find('#untyped'), box).place(find('#plain'), box).paint(find('#plain'), find('#untyped'))
    expect(findSameNameCover(find('#untyped'))).toBeNull()
  })

  it('compares the label or text with case and spaces folded, and refuses a target without a name', () => {
    mount('<button id="next" aria-label=" ">Next step</button><input type="button" id="cover" aria-label="NEXT  step">'
      + '<button id="icon"></button><a id="link" href="#top"></a>')
    const box: Box = { left: 0, top: 0, width: 100, height: 30 }
    layout.place(find('#next'), box).place(find('#cover'), box).paint(find('#cover'), find('#next'))
    expect(findSameNameCover(find('#next'))).toBe(find('#cover'))
    layout.place(find('#icon'), box).place(find('#link'), box).paint(find('#link'), find('#icon'))
    expect(findSameNameCover(find('#icon'))).toBeNull()
  })

  it('refuses a cover with another name, one that holds the target, and one that is not a control', () => {
    mount('<button id="pay">Pay now</button><div id="other" role="menuitem">Cancel</div>'
      + '<a id="link" href="/open"><span id="target">Open</span><i id="icon"></i></a>'
      + '<p id="text">Read more</p><div id="scrim"><span id="dot"></span></div>')
    const box: Box = { left: 0, top: 0, width: 100, height: 20 }
    layout.place(find('#pay'), box).place(find('#other'), box).paint(find('#other'), find('#pay'))
    expect(findSameNameCover(find('#pay'))).toBeNull()
    layout.place(find('#target'), box).place(find('#icon'), box).paint(find('#icon'), find('#target'))
    expect(findSameNameCover(find('#target'))).toBeNull()
    layout.place(find('#text'), box).place(find('#dot'), box).paint(find('#dot'), find('#text'))
    expect(findSameNameCover(find('#text'))).toBeNull()
  })

  it('returns nothing for a target the hit test reaches, misses, or cannot place', () => {
    mount('<button id="go"><span id="label">Go</span></button><button id="flat">Flat</button><button id="thin">Thin</button>')
    const go = find('#go')
    const box: Box = { left: 0, top: 0, width: 100, height: 20 }
    layout.place(go, box).place(find('#label'), box).place(find('#thin'), { left: 0, top: 0, width: 100, height: 0 })
    layout.paint(go)
    expect(findSameNameCover(go)).toBeNull()
    layout.paint(find('#label'), go)
    expect(findSameNameCover(go)).toBeNull()
    layout.paint()
    expect(findSameNameCover(go)).toBeNull()
    expect(findSameNameCover(find('#flat'))).toBeNull()
    expect(findSameNameCover(find('#thin'))).toBeNull()
  })

  it('looks through an open shadow root for the overlay, and stops at a host that reports itself or nothing', () => {
    mount('<button id="real" aria-hidden="true">Next</button><div id="host"></div>')
    const real = find('#real')
    const host = find('#host')
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = '<div id="overlay" role="button" aria-label="Next"></div>'
    const overlay = find('#overlay', root)
    const box: Box = { left: 0, top: 0, width: 100, height: 20 }
    layout.place(real, box).place(host, box).place(overlay, box).paint(overlay, host, real)
    expect(findSameNameCover(real)).toBe(overlay)
    layout.paint(host, real)
    expect(findSameNameCover(real)).toBeNull()
    layout.blind(root)
    expect(findSameNameCover(real)).toBeNull()
  })
})
