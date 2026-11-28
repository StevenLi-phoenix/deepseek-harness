/**
 * How well a person can see and hit one element, as a score from 0 to 1. The
 * probe measures the element inside the page and returns plain facts; the
 * scoring runs in the host, so the weights and the refusal threshold are one
 * reviewable table rather than numbers spread through injected script.
 *
 * The probe scrolls the element into view before measuring, because that is
 * where a person would find it and where a click would land; an element below
 * the fold is reachable, not invisible. A page-side script is a string by
 * nature, so the facts it returns are validated at {@link readElementFacts}.
 *
 * @module @deepseek-ai/dsh-headless-browser/visibility
 */

/**
 * Score below which a click or type is refused. A person's target has to clear
 * this on every test at once; a decoy that hides one of them scores zero.
 */
export const VISIBILITY_THRESHOLD = 0.2

/** Opacity at or below which an element is invisible rather than faint. */
const INVISIBLE_OPACITY = 0.05

/**
 * How hard one failed test drags the score, as the exponent in
 * `score = Π factor ** weight`. A test a person cannot work around (display,
 * visibility, pointer events, aria-hidden) outweighs one that merely narrows
 * the target (partial clipping), so a single unworkable condition alone lands
 * under {@link VISIBILITY_THRESHOLD} while one partial condition does not.
 */
export const VISIBILITY_WEIGHTS = {
  display: 4,
  visibility: 4,
  pointerEvents: 3,
  ariaHidden: 3,
  opacity: 2,
  viewport: 2,
  occlusion: 2,
  area: 1.5,
  clipping: 1,
} as const

/** One test of {@link VISIBILITY_WEIGHTS}, in report order: hardest first. */
export type VisibilityFactor = keyof typeof VISIBILITY_WEIGHTS

/** Report order of the tests, which is also weight order. */
const FACTORS: readonly VisibilityFactor[] = [
  'display',
  'visibility',
  'pointerEvents',
  'ariaHidden',
  'opacity',
  'viewport',
  'occlusion',
  'area',
  'clipping',
]

/** What the probe measured about one element. */
export interface ElementFacts {
  /** Accessible name, the text a person reads for this control. */
  readonly name: string
  /** Current value, for a form control; the empty string otherwise. */
  readonly value: string
  /** Absolute URL a click would navigate to, from the enclosing link. */
  readonly href: string | null
  /** Absolute URL the enclosing form submits to. */
  readonly formAction: string | null
  /** Lowercase tag name. */
  readonly tag: string
  /** Explicit ARIA role, or nothing. */
  readonly role: string | null
  /** Computed display of the element, or `none` when an ancestor is not displayed. */
  readonly display: string
  /** Computed visibility of the element, which already reflects inheritance. */
  readonly visibility: string
  /**
   * Product of the computed opacity of the element and its ancestors; for a
   * styled checkbox or radio at opacity 0, that of the box painted under it or of its label.
   */
  readonly opacity: number
  /** Computed pointer-events of the element, which already reflects inheritance. */
  readonly pointerEvents: string
  /** Whether the element or an ancestor carries `aria-hidden="true"`. */
  readonly ariaHidden: boolean
  /**
   * Whether the element itself carries `aria-hidden="true"`. False when only an
   * ancestor does: a dialog library hides the page behind it from screen readers,
   * and the control a person sees can sit inside that region. Absent means unknown,
   * which scores as the element's own.
   */
  readonly ariaHiddenOwn?: boolean
  /** Width in CSS pixels of the box a person aims at: the border box, or a searchable dropdown's control around its caret-wide input. */
  readonly width: number
  /** Height in CSS pixels of the same box. */
  readonly height: number
  /** Fraction of the border box inside the viewport after scrolling to it. */
  readonly viewportFraction: number
  /** Fraction of five sampled points where a hit test reaches the element. */
  readonly occlusion: number
  /**
   * What a click at the element's centre reaches instead, when something else is
   * on top there (a cookie banner's backdrop, a dialog): its tag, id, role and
   * the start of its label or text. Page-derived, so only ever shown as page data.
   */
  readonly coveredBy?: string
  /**
   * Opening tags of the element and its parent, and of what covers its centre and
   * that element's parent: what a refusal needs for a fix to be written from it.
   * Never carries a `value` attribute. Page-derived, so only ever shown as page data.
   */
  readonly markup?: string
  /**
   * Where inside the element a click lands on it, relative to its box, when its label's own transparent input lies
   * over its centre (Eightfold's radios); absent otherwise.
   */
  readonly labelAim?: { readonly x: number; readonly y: number }
  /** Number of ancestors that clip the element's box. */
  readonly clippedBy: number
  /** Fraction of the border box left after every clipping ancestor. */
  readonly clippingFraction: number
}

/** The verdict on one element. */
export interface VisibilityScore {
  /** Product of every weighted test, rounded to three decimals. */
  readonly score: number
  /** Each test's own value, 0 through 1. */
  readonly factors: Readonly<Record<VisibilityFactor, number>>
  /** Tests that are not perfect, hardest first; what dragged the score down. */
  readonly failing: readonly VisibilityFactor[]
}

/**
 * Measure one element inside its page. Playwright serialises this function, so
 * it must not reference anything outside itself; it scrolls the element into
 * view first, so the score describes where a person would see it.
 * @param element - the element to measure.
 * @returns the measured facts, as plain data.
 */
export function probeElement(element: Element): ElementFacts {
  const doc = element.ownerDocument
  const view = doc.defaultView
  if (view === null) throw new Error('the element has no window to measure')
  const parentOf = (node: Element): Element | null => {
    if (node.parentElement !== null) return node.parentElement
    const root = node.getRootNode()
    return root instanceof ShadowRoot ? root.host : null
  }
  const flatText = (node: Element | null): string =>
    node === null ? '' : node.textContent.replace(/\s+/gu, ' ').trim()
  const nameOf = (node: Element): string => {
    const labelledBy = node.getAttribute('aria-labelledby')
    if (labelledBy !== null && labelledBy.trim() !== '') {
      const fromIds = labelledBy.split(/\s+/u)
        .map(id => doc.getElementById(id))
        .map(target => flatText(target))
        .join(' ')
        .replace(/\s+/gu, ' ')
        .trim()
      if (fromIds !== '') return fromIds
    }
    const label = node.getAttribute('aria-label')
    if (label !== null && label.trim() !== '') return label
    if (node instanceof HTMLInputElement && (node.type === 'submit' || node.type === 'button' || node.type === 'reset')) return node.value
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) {
      if (node.labels !== null && node.labels.length > 0) {
        const fromLabels = Array.from(node.labels).map(label => flatText(label)).join(' ').replace(/\s+/gu, ' ').trim()
        if (fromLabels !== '') return fromLabels
      }
      const placeholder = node.getAttribute('placeholder')
      if (placeholder !== null && placeholder.trim() !== '') return placeholder
      const title = node.getAttribute('title')
      if (title !== null && title.trim() !== '') return title
    }
    if (node instanceof HTMLImageElement) {
      const alt = node.getAttribute('alt')
      if (alt !== null && alt.trim() !== '') return alt
    }
    const own = flatText(node)
    if (own !== '') return own
    const title = node.getAttribute('title')
    return title === null ? '' : title.trim()
  }
  // A person finds the element by scrolling to it, so measure it there. The
  // scroll is instant: under `scroll-behavior: smooth` (Greenhouse's job boards)
  // the default one animates, and the measurement would see the old position.
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const chain: Element[] = []
  for (let node: Element | null = element; node !== null; node = parentOf(node)) chain.push(node)
  let hiddenByDisplay = false
  let ariaHidden = false
  let opacity = 1
  let clippedBy = 0
  let clipLeft = Number.NEGATIVE_INFINITY
  let clipTop = Number.NEGATIVE_INFINITY
  let clipRight = Number.POSITIVE_INFINITY
  let clipBottom = Number.POSITIVE_INFINITY
  for (const node of chain) {
    const style = view.getComputedStyle(node)
    if (style.display === 'none') hiddenByDisplay = true
    if (node.getAttribute('aria-hidden') === 'true') ariaHidden = true
    const nodeOpacity = Number.parseFloat(style.opacity)
    if (Number.isFinite(nodeOpacity)) opacity *= nodeOpacity
    const clipsX = style.overflowX !== 'visible'
    const clipsY = style.overflowY !== 'visible'
    // An element's own overflow clips its content, not its box: Chrome gives every
    // input `overflow: clip`, which would otherwise shave its border off its score.
    // Overflow clips only a box that holds blocks: an inline or display:contents
    // ancestor clips nothing, and its client box reads as zero, which would shrink
    // the target to nothing (SuccessFactors draws its sign-in dialog inside
    // `<div class="modal">` at display:inline with overflow:auto).
    const clipsNothing = style.display === 'inline' || style.display === 'contents'
    if ((!clipsX && !clipsY) || clipsNothing || node === element || node === doc.documentElement || node === doc.body) continue
    const box = node.getBoundingClientRect()
    if (clipsX) {
      clipLeft = Math.max(clipLeft, box.left + node.clientLeft)
      clipRight = Math.min(clipRight, box.left + node.clientLeft + node.clientWidth)
    }
    if (clipsY) {
      clipTop = Math.max(clipTop, box.top + node.clientTop)
      clipBottom = Math.min(clipBottom, box.top + node.clientTop + node.clientHeight)
    }
    clippedBy += 1
  }
  const own = view.getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  const area = rect.width * rect.height
  // A styled checkbox or radio (Workday's terms box) keeps the real input on top
  // at opacity 0 and paints the box a person sees right under it, so a click on
  // the box lands on the input. What a person sees there is that painted box, or
  // else the input's own label, so the opacity test measures that instead.
  if (opacity <= 0.05 && element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio') && area > 0) {
    const opacityOf = (node: Element): number => {
      let product = 1
      for (let current: Element | null = node; current !== null; current = parentOf(current)) {
        const value = Number.parseFloat(view.getComputedStyle(current).opacity)
        if (Number.isFinite(value)) product *= value
      }
      return product
    }
    const painted = (node: Element): boolean => {
      const box = node.getBoundingClientRect()
      return box.width * box.height > 0 && view.getComputedStyle(node).visibility === 'visible' && opacityOf(node) > 0.05
    }
    const overlapsInput = (node: Element): boolean => {
      const box = node.getBoundingClientRect()
      const boxArea = box.width * box.height
      const across = Math.max(0, Math.min(box.right, rect.right) - Math.max(box.left, rect.left))
      const down = Math.max(0, Math.min(box.bottom, rect.bottom) - Math.max(box.top, rect.top))
      // The box sits where the input is and is about its size; the page behind it is not a box.
      return boxArea <= area * 4 && across * down >= Math.min(area, boxArea) / 2
    }
    const stack = doc.elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    const under = stack[0] === element ? stack[1] : undefined
    const label = Array.from(element.labels ?? []).find(painted)
    const standIn = under !== undefined && painted(under) && overlapsInput(under) ? under : label
    if (standIn !== undefined) opacity = opacityOf(standIn)
  }
  // A searchable dropdown's input (react-select, which Greenhouse uses for every
  // choice) autosizes to its text, so empty it is a caret wide; a person aims at
  // the control around it, so the area test measures the nearest enclosing box
  // that has room for a click and holds the input's centre.
  let aimWidth = rect.width
  let aimHeight = rect.height
  const combobox = element instanceof HTMLInputElement
    && (element.getAttribute('role') === 'combobox' || ['list', 'both', 'inline'].includes(element.getAttribute('aria-autocomplete') ?? ''))
  if (combobox && area > 0 && area < 100) {
    const centreX = rect.left + rect.width / 2
    const centreY = rect.top + rect.height / 2
    let field = element.parentElement
    for (let depth = 0; field !== null && depth < 4; depth += 1, field = field.parentElement) {
      const box = field.getBoundingClientRect()
      if (box.width * box.height >= 100 && box.left <= centreX && centreX <= box.right && box.top <= centreY && centreY <= box.bottom) {
        aimWidth = box.width
        aimHeight = box.height
        break
      }
    }
  }
  // A searchable dropdown that draws its own value (ADP's MDFSelectBox, a react-select) keeps its text input at
  // opacity 0 until a person types, so what they see and click there is the control around it: the nearest box that
  // holds the input's centre, has room for a click and holds no other control.
  if (combobox && opacity <= 0.05 && area > 0) {
    const centreX = rect.left + rect.width / 2
    const centreY = rect.top + rect.height / 2
    const CONTROLS = 'input, select, textarea, button, a[href], [role="button"], [role="checkbox"], [role="radio"], [role="switch"], [role="link"]'
    const otherControl = (node: Element): boolean => Array.from(node.querySelectorAll(CONTROLS))
      .some(control => control !== element && !(control instanceof HTMLInputElement && control.type === 'hidden'))
    let field = element.parentElement
    for (let depth = 0; field !== null && depth < 4 && !otherControl(field); depth += 1, field = field.parentElement) {
      const box = field.getBoundingClientRect()
      if (box.width * box.height >= 100 && box.left <= centreX && centreX <= box.right && box.top <= centreY && centreY <= box.bottom) {
        let painted = 1
        for (let current: Element | null = field; current !== null; current = parentOf(current)) {
          const value = Number.parseFloat(view.getComputedStyle(current).opacity)
          if (Number.isFinite(value)) painted *= value
        }
        if (painted > 0.05) opacity = painted
        break
      }
    }
  }
  const visibleLeft = Math.max(rect.left, clipLeft)
  const visibleTop = Math.max(rect.top, clipTop)
  const visibleRight = Math.min(rect.right, clipRight)
  const visibleBottom = Math.min(rect.bottom, clipBottom)
  const clippedArea = Math.max(0, visibleRight - visibleLeft) * Math.max(0, visibleBottom - visibleTop)
  const inViewLeft = Math.max(visibleLeft, 0)
  const inViewTop = Math.max(visibleTop, 0)
  const inViewRight = Math.min(visibleRight, view.innerWidth)
  const inViewBottom = Math.min(visibleBottom, view.innerHeight)
  const inViewWidth = Math.max(0, inViewRight - inViewLeft)
  const inViewHeight = Math.max(0, inViewBottom - inViewTop)
  const fraction = (part: number): number => (area <= 0 ? 0 : Math.min(1, part / area))
  // A hit test answers what a click would actually reach; five points keep a
  // half-covered element above zero instead of turning the test into a flag.
  const points: readonly (readonly [number, number])[] = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]
  let hits = 0
  // The document's hit test stops at the outermost shadow host, so follow open
  // shadow roots down to what a click would reach (SmartRecruiters nests its
  // fields two hosts deep). A closed root stops the descent at its host, which
  // then counts when it is one of the hosts the element lives under.
  const deepHit = (x: number, y: number): Element | null => {
    let hit = doc.elementFromPoint(x, y)
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y)
      if (inner === null || inner === hit) break
      hit = inner
    }
    return hit
  }
  // Workday draws each date segment as a caret-sized input[role=spinbutton] under an
  // aria-hidden sibling that paints the segment's text ("YYYY", then the digits typed),
  // and a click on that text focuses the input. Such a display is the field a person
  // sees: aria-hidden itself, a sibling of the field, holding no control, and showing
  // exactly the field's own value, placeholder or aria-valuetext; a number may be
  // zero-padded on the display (month "02" for aria-valuetext "2"). A layer with any
  // other text still covers the field.
  const fieldTexts = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
    ? [element.value, element.getAttribute('placeholder') ?? '', element.getAttribute('aria-valuetext') ?? '']
      .map(text => text.replace(/\s+/gu, ' ').trim())
      .filter(text => text !== '')
    : []
  const showsField = (shown: string): boolean => fieldTexts.some(text =>
    text === shown || (/^\d+$/u.test(text) && /^\d+$/u.test(shown) && Number(text) === Number(shown)))
  const fieldParent = parentOf(element)
  const displayOf = (hit: Element): Element | null => {
    if (fieldTexts.length === 0 || fieldParent === null) return null
    let node: Element | null = hit
    while (node !== null && parentOf(node) !== fieldParent) node = parentOf(node)
    if (node === null || node === element || node.getAttribute('aria-hidden') !== 'true') return null
    if (node.querySelector('a[href], button, input, select, textarea, [role=button], [role=link]') !== null) return null
    return showsField(flatText(node)) ? node : null
  }
  // A label's text under its own transparent input (Eightfold's radios at careers.qualcomm.com): a click there
  // reaches the input, which is what a click on the label does, so that hit counts as reaching the label.
  const ownControl = element.closest('label')?.control ?? null
  const reaches = (hit: Element): boolean => {
    for (let node: Element | null = hit; node !== null; node = parentOf(node)) if (node === element) return true
    if (ownControl !== null && hit === ownControl) return true
    for (let node: Element | null = element; node !== null; node = parentOf(node)) {
      const nodeRoot = node.getRootNode()
      if (node.parentElement === null && nodeRoot instanceof ShadowRoot && nodeRoot.host === hit) return true
    }
    return displayOf(hit) !== null
  }
  for (const [across, down] of points) {
    const hit = deepHit(inViewLeft + inViewWidth * across, inViewTop + inViewHeight * down)
    if (hit !== null && reaches(hit)) hits += 1
  }
  // Name what sits on top at the centre, so a refusal can say what to close first.
  const centreHit = inViewWidth <= 0 || inViewHeight <= 0 ? null : deepHit(inViewLeft + inViewWidth / 2, inViewTop + inViewHeight / 2)
  // A person aims a caret-sized field at the display that draws it, so the area test measures that box.
  const display = centreHit === null || area >= 100 ? null : displayOf(centreHit)
  if (display !== null) {
    const box = display.getBoundingClientRect()
    aimWidth = box.width
    aimHeight = box.height
  }
  const cover = centreHit === null || reaches(centreHit) ? null : centreHit
  // Playwright refuses a click whose point another element takes, even the label's own input, so a label's text under
  // that input is clicked at the point nearest its centre where the text itself is on top.
  const onElement = (hit: Element | null): boolean => {
    for (let node: Element | null = hit; node !== null; node = parentOf(node)) if (node === element) return true
    return false
  }
  let labelAim: { readonly x: number; readonly y: number } | undefined
  if (ownControl !== null && centreHit === ownControl) {
    search: for (const down of [0.5, 0.25, 0.75]) {
      for (let step = 1; step < 10; step += 1) {
        for (const across of [0.5 + step * 0.05, 0.5 - step * 0.05]) {
          const x = inViewLeft + inViewWidth * across
          const y = inViewTop + inViewHeight * down
          if (onElement(deepHit(x, y))) {
            labelAim = { x: x - rect.left, y: y - rect.top }
            break search
          }
        }
      }
    }
  }
  const coverText = cover === null ? '' : (cover.getAttribute('aria-label') ?? flatText(cover)).slice(0, 60)
  const coverRole = cover?.getAttribute('role') ?? null
  const coveredBy = cover === null
    ? undefined
    : [
      cover.tagName.toLowerCase() + (cover.id === '' ? '' : `#${cover.id}`),
      ...Array.from(cover.classList).slice(0, 2).map(name => `.${name}`),
      coverRole === null ? '' : `role=${coverRole}`,
      coverText === '' ? '' : JSON.stringify(coverText),
    ].filter(part => part !== '').join(' ').slice(0, 160)
  const openTag = (node: Element): string => {
    const attributes = Array.from(node.attributes)
      .filter(attribute => attribute.name !== 'value')
      .map(attribute => ` ${attribute.name}="${attribute.value.slice(0, 80)}"`)
      .join('')
    return `<${node.tagName.toLowerCase()}${attributes}>`.slice(0, 240)
  }
  const inParent = (node: Element): string => {
    const parent = parentOf(node)
    return parent === null ? openTag(node) : `${openTag(node)} in ${openTag(parent)}`
  }
  const markup = cover === null ? inParent(element) : `${inParent(element)}; under ${inParent(cover)}`
  const href = element.closest('a[href]')?.getAttribute('href') ?? null
  const form = element.closest('form')
  const formActionAttribute = element.getAttribute('formaction')
  return {
    name: nameOf(element).slice(0, 200),
    value: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
      ? element.value
      : '',
    href: href === null ? null : new URL(href, doc.baseURI).href,
    formAction: formActionAttribute !== null
      ? new URL(formActionAttribute, doc.baseURI).href
      : form === null ? null : new URL(form.getAttribute('action') ?? '', doc.baseURI).href,
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute('role'),
    display: hiddenByDisplay ? 'none' : own.display,
    visibility: own.visibility,
    opacity: Math.min(1, Math.max(0, opacity)),
    pointerEvents: own.pointerEvents,
    ariaHidden,
    ariaHiddenOwn: element.getAttribute('aria-hidden') === 'true',
    width: aimWidth,
    height: aimHeight,
    viewportFraction: fraction(inViewWidth * inViewHeight),
    occlusion: inViewWidth <= 0 || inViewHeight <= 0 ? 0 : hits / points.length,
    ...coveredBy === undefined ? {} : { coveredBy },
    ...labelAim === undefined ? {} : { labelAim },
    markup,
    clippedBy,
    clippingFraction: fraction(clippedArea),
  }
}

/**
 * The control a person actually hits when they aim at an element that is
 * covered: Workday, for one, hides each real `<button>` (`aria-hidden`) under a
 * transparent `role="button"` overlay with the same label, and the overlay takes
 * the click. Returns the interactive element at the target's centre when it is
 * not the target, does not contain it, and carries the same accessible name, or
 * is named "Submit" over a `type="submit"` control (Workday's sign-in hides
 * `<button type="submit">Sign In</button>` under a `click_filter` overlay
 * labelled "Submit"); nothing otherwise, so a decoy under an unrelated element
 * stays refused.
 * Playwright serialises this function, so it must not reference anything
 * outside itself; run it after {@link probeElement}, which scrolled the element
 * into view.
 * @param element - the covered element.
 * @returns the covering control, or `null`.
 */
export function findSameNameCover(element: Element): Element | null {
  const doc = element.ownerDocument
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  let hit = doc.elementFromPoint(x, y)
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y)
    if (inner === null || inner === hit) break
    hit = inner
  }
  if (hit === null || hit === element || element.contains(hit)) return null
  const interactive = (node: Element): boolean => {
    const tag = node.tagName.toLowerCase()
    const role = node.getAttribute('role') ?? ''
    return tag === 'button' || tag === 'a' || tag === 'input'
      || ['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'option', 'switch'].includes(role)
  }
  let cover: Element | null = hit
  while (cover !== null && !interactive(cover)) cover = cover.parentElement
  if (cover === null || cover.contains(element)) return null
  const nameOf = (node: Element): string => {
    const label = node.getAttribute('aria-label')
    const text = label !== null && label.trim() !== '' ? label : node.textContent
    return text.replace(/\s+/gu, ' ').trim().toLowerCase()
  }
  const name = nameOf(element)
  if (name === '') return null
  const coverName = nameOf(cover)
  const submitsTheForm = coverName === 'submit' && element.getAttribute('type')?.trim().toLowerCase() === 'submit'
  return coverName === name || submitsTheForm ? cover : null
}

/**
 * The visible control a person clicks for a checkbox or radio the page hides
 * completely: LinkedIn's Easy Apply draws each box itself and shrinks the native
 * input to nothing (zero size, opacity 0, no pointer events), so the "Follow
 * <company>" box and the résumé radio refused every click. Returns the input's
 * painted `<label>`, or else the nearest painted ancestor (four levels up at
 * most) whose label or text is the input's accessible name and that holds no
 * other control; nothing otherwise, so a hidden decoy beside other controls
 * stays refused. A label the page makes click-through (`pointer-events: none`)
 * toggles its control when a click lands on a part of it that takes pointer
 * events: D. E. Shaw's privacy acknowledgment lays such a `<p>` over the native
 * box, so the part at the box's centre stands in, clicked there through
 * {@link findToggleAim}. A label target stands for its checkbox or radio. The
 * stand-in is scored and name-checked like any target.
 * Playwright serialises this function, so it must not reference anything
 * outside itself; run it after {@link probeElement}, which scrolled the element
 * into view.
 * @param target - the hidden checkbox or radio, or its label.
 * @returns the element a person's click reaches, or `null`.
 */
export function findToggleStandIn(target: Element): Element | null {
  const view = target.ownerDocument.defaultView
  if (view === null) return null
  const element = target instanceof view.HTMLLabelElement ? target.control : target
  if (!(element instanceof view.HTMLInputElement)) return null
  if (element.type !== 'checkbox' && element.type !== 'radio') return null
  const fold = (text: string): string => text.replace(/\s+/gu, ' ').trim().toLowerCase()
  const painted = (node: Element): boolean => {
    const box = node.getBoundingClientRect()
    if (box.width * box.height <= 0) return false
    const style = view.getComputedStyle(node)
    if (style.visibility !== 'visible' || style.pointerEvents === 'none') return false
    let opacity = 1
    for (let current: Element | null = node; current !== null; current = current.parentElement) {
      const value = Number.parseFloat(view.getComputedStyle(current).opacity)
      if (Number.isFinite(value)) opacity *= value
    }
    return opacity > 0.05
  }
  const CONTROLS = 'input, select, textarea, button, a[href], [role="button"], [role="checkbox"], [role="radio"], [role="switch"], [role="link"]'
  const labels = Array.from(element.labels ?? [])
  const label = labels.find(painted)
  // A painted label the guard already scored low gains nothing from standing in for itself.
  if (label !== undefined) return label === target ? null : label
  const box = element.getBoundingClientRect()
  const hit = box.width * box.height > 0 && typeof element.ownerDocument.elementFromPoint === 'function'
    ? element.ownerDocument.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    : null
  // The part must sit inside the box's own label and outside any other control, such as a privacy-notice link.
  const ownPart = hit !== null && hit !== element && labels.some(owner => owner !== hit && owner.contains(hit))
    && painted(hit) && hit.closest(CONTROLS) === null
  if (ownPart) return hit
  const name = fold(element.getAttribute('aria-label') ?? labels.map(node => node.textContent).join(' '))
  if (name === '') return null
  const nameOf = (node: Element): string => fold(node.getAttribute('aria-label') ?? node.textContent)
  let node = element.parentElement
  for (let depth = 0; node !== null && depth < 4 && node !== element.ownerDocument.body; depth += 1, node = node.parentElement) {
    // A wider ancestor holds the same other control, so the climb stops at the first one.
    if (Array.from(node.querySelectorAll(CONTROLS)).some(control => control !== element)) return null
    if (painted(node) && nameOf(node) === name) return node
  }
  return null
}

/**
 * Where to click the part of a click-through label that {@link findToggleStandIn}
 * returned for a checkbox or radio: the native box's centre, relative to that
 * part, because the part's own centre can be a link inside it. Repeats that
 * function's covering-part test, so it answers only when the part is the
 * stand-in; nothing otherwise, and the stand-in is clicked at its centre.
 * Playwright serialises this function, so it must not reference anything
 * outside itself.
 * @param target - the hidden checkbox or radio, or its label.
 * @returns the click position inside the stand-in, or `null`.
 */
export function findToggleAim(target: Element): { readonly x: number; readonly y: number } | null {
  const view = target.ownerDocument.defaultView
  if (view === null) return null
  const element = target instanceof view.HTMLLabelElement ? target.control : target
  if (!(element instanceof view.HTMLInputElement) || (element.type !== 'checkbox' && element.type !== 'radio')) return null
  // oxlint-disable-next-line sonarjs/no-identical-functions -- Playwright serialises each function alone, so the paint test repeats
  const painted = (node: Element): boolean => {
    const box = node.getBoundingClientRect()
    if (box.width * box.height <= 0) return false
    const style = view.getComputedStyle(node)
    if (style.visibility !== 'visible' || style.pointerEvents === 'none') return false
    let opacity = 1
    for (let current: Element | null = node; current !== null; current = current.parentElement) {
      const value = Number.parseFloat(view.getComputedStyle(current).opacity)
      if (Number.isFinite(value)) opacity *= value
    }
    return opacity > 0.05
  }
  const CONTROLS = 'input, select, textarea, button, a[href], [role="button"], [role="checkbox"], [role="radio"], [role="switch"], [role="link"]'
  const labels = Array.from(element.labels ?? [])
  if (labels.some(painted)) return null
  const box = element.getBoundingClientRect()
  if (box.width * box.height <= 0 || typeof element.ownerDocument.elementFromPoint !== 'function') return null
  const x = box.left + box.width / 2
  const y = box.top + box.height / 2
  const hit = element.ownerDocument.elementFromPoint(x, y)
  if (hit === null || hit === element || !labels.some(owner => owner !== hit && owner.contains(hit))) return null
  if (!painted(hit) || hit.closest(CONTROLS) !== null) return null
  const part = hit.getBoundingClientRect()
  return { x: x - part.left, y: y - part.top }
}

/**
 * The element a person clicks for text the page marks `aria-hidden`: LinkedIn's
 * job search draws each card title as an `aria-hidden` span that is the only
 * text of its `<p>`, so `text=<title>` matched the span and was refused
 * (ariaHidden 0, and the gaps of the wrapped span hit the `<p>`). Returns the
 * nearest ancestor, four levels up at most, outside any `aria-hidden` subtree,
 * that reads exactly like the element (its label or text, case and spaces
 * folded) and holds no control besides it; nothing otherwise, so a hidden
 * phrase inside other text or beside another control stays refused. The session
 * asks only when the element itself is painted, and scores the holder like any
 * target. Playwright serialises this function, so it must not reference
 * anything outside itself.
 * @param element - the `aria-hidden` element.
 * @returns the holder a click should land on, or `null`.
 */
export function findHiddenTextHolder(element: Element): Element | null {
  const fold = (text: string): string => text.replace(/\s+/gu, ' ').trim().toLowerCase()
  const nameOf = (node: Element): string => {
    const label = node.getAttribute('aria-label')
    return fold(label !== null && label.trim() !== '' ? label : node.textContent)
  }
  const name = nameOf(element)
  if (name === '') return null
  const CONTROLS = 'input, select, textarea, button, a[href], [role="button"], [role="checkbox"], [role="radio"], [role="switch"], [role="link"]'
  let node = element.parentElement
  for (let depth = 0; node !== null && depth < 4 && node !== element.ownerDocument.body; depth += 1, node = node.parentElement) {
    // A wider ancestor holds the same other control, so the climb stops at the first one.
    if (Array.from(node.querySelectorAll(CONTROLS)).some(control => control !== element)) return null
    if (node.closest('[aria-hidden="true"]') === null && nameOf(node) === name) return node
  }
  return null
}

/**
 * Score the facts the probe returned.
 * @param facts - one element's measurements.
 * @returns the score, every test's value, and the tests that failed.
 */
export function scoreVisibility(facts: ElementFacts): VisibilityScore {
  const factors: Record<VisibilityFactor, number> = {
    display: facts.display === 'none' ? 0 : 1,
    visibility: facts.visibility === 'hidden' || facts.visibility === 'collapse' ? 0 : 1,
    pointerEvents: facts.pointerEvents === 'none' ? 0 : 1,
    ariaHidden: ariaHiddenFactor(facts),
    opacity: facts.opacity <= INVISIBLE_OPACITY ? 0 : clamp(facts.opacity),
    viewport: clamp(facts.viewportFraction),
    occlusion: clamp(facts.occlusion),
    area: areaFactor(facts.width, facts.height),
    clipping: clamp(facts.clippingFraction),
  }
  let score = 1
  for (const factor of FACTORS) score *= factors[factor] ** VISIBILITY_WEIGHTS[factor]
  return {
    score: Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000,
    factors,
    failing: FACTORS.filter(factor => factors[factor] < 1),
  }
}

/**
 * Validate facts that crossed the page boundary, so a page cannot hand the
 * host a value that is not a measurement.
 * @param value - whatever `evaluate` returned.
 * @returns the facts, when every field is present and typed.
 * @throws Error - when a field is missing or mistyped.
 */
export function readElementFacts(value: unknown): ElementFacts {
  if (typeof value !== 'object' || value === null) throw new Error('the visibility probe returned no object')
  const record = value as Record<string, unknown>
  const text = (key: string): string => {
    const field = record[key]
    if (typeof field !== 'string') throw new Error(`the visibility probe returned no ${key}`)
    return field
  }
  const number = (key: string): number => {
    const field = record[key]
    if (typeof field !== 'number' || !Number.isFinite(field)) throw new Error(`the visibility probe returned no ${key}`)
    return field
  }
  const nullableText = (key: string): string | null => {
    const field = record[key]
    if (field === null) return null
    if (typeof field !== 'string') throw new Error(`the visibility probe returned no ${key}`)
    return field
  }
  const coveredBy = record.coveredBy
  if (coveredBy !== undefined && typeof coveredBy !== 'string') throw new Error('the visibility probe returned no coveredBy')
  const markup = record.markup
  if (markup !== undefined && typeof markup !== 'string') throw new Error('the visibility probe returned no markup')
  const ariaHidden = record.ariaHidden
  if (typeof ariaHidden !== 'boolean') throw new Error('the visibility probe returned no ariaHidden')
  const ariaHiddenOwn = record.ariaHiddenOwn
  if (ariaHiddenOwn !== undefined && typeof ariaHiddenOwn !== 'boolean') throw new Error('the visibility probe returned no ariaHiddenOwn')
  const labelAim = record.labelAim as { x?: unknown; y?: unknown } | undefined
  if (labelAim !== undefined && (typeof labelAim !== 'object' || labelAim === null || typeof labelAim.x !== 'number' || typeof labelAim.y !== 'number'
    || !Number.isFinite(labelAim.x) || !Number.isFinite(labelAim.y))) throw new Error('the visibility probe returned no labelAim')
  return {
    name: text('name'),
    value: text('value'),
    href: nullableText('href'),
    formAction: nullableText('formAction'),
    tag: text('tag'),
    role: nullableText('role'),
    display: text('display'),
    visibility: text('visibility'),
    opacity: number('opacity'),
    pointerEvents: text('pointerEvents'),
    ariaHidden,
    ...ariaHiddenOwn === undefined ? {} : { ariaHiddenOwn },
    width: number('width'),
    height: number('height'),
    viewportFraction: number('viewportFraction'),
    occlusion: number('occlusion'),
    ...coveredBy === undefined ? {} : { coveredBy },
    ...markup === undefined ? {} : { markup },
    ...labelAim === undefined ? {} : { labelAim: { x: labelAim.x as number, y: labelAim.y as number } },
    clippedBy: number('clippedBy'),
    clippingFraction: number('clippingFraction'),
  }
}

/**
 * aria-hidden only says what a screen reader skips. On the element itself it
 * marks a control the page does not mean anyone to use, such as a decoy "Verify
 * you are human" button, so it fails. Inherited from an ancestor it usually means
 * a dialog library hid the page around the dialog (Phenom's screening steps put
 * their Next button there). That passes only when a person can still plainly reach
 * the control: wholly in the viewport and on top at every sampled point.
 */
function ariaHiddenFactor(facts: ElementFacts): number {
  if (!facts.ariaHidden) return 1
  if (facts.ariaHiddenOwn !== false) return 0
  return facts.viewportFraction >= 1 && facts.occlusion >= 1 ? 1 : 0
}

/** Keep a fraction inside 0 through 1. */
function clamp(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * Penalise a box a person could not aim at: a zero box cannot be hit at all,
 * and a box under a few pixels square is the shape of a hidden trap.
 */
function areaFactor(width: number, height: number): number {
  const area = width * height
  if (area <= 0) return 0
  if (area < 16) return 0.05
  if (area < 100) return 0.4
  return 1
}
