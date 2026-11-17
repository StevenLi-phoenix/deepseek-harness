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
  /** Product of the computed opacity of the element and its ancestors. */
  readonly opacity: number
  /** Computed pointer-events of the element, which already reflects inheritance. */
  readonly pointerEvents: string
  /** Whether the element or an ancestor carries `aria-hidden="true"`. */
  readonly ariaHidden: boolean
  /** Border box width in CSS pixels. */
  readonly width: number
  /** Border box height in CSS pixels. */
  readonly height: number
  /** Fraction of the border box inside the viewport after scrolling to it. */
  readonly viewportFraction: number
  /** Fraction of five sampled points where a hit test reaches the element. */
  readonly occlusion: number
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
    node === null ? '' : (node.textContent ?? '').replace(/\s+/gu, ' ').trim()
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
  // A person finds the element by scrolling to it, so measure it there.
  element.scrollIntoView({ block: 'center', inline: 'center' })
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
    if ((!clipsX && !clipsY) || node === doc.documentElement || node === doc.body) continue
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
  const root = element.getRootNode()
  for (const [across, down] of points) {
    const hit = doc.elementFromPoint(inViewLeft + inViewWidth * across, inViewTop + inViewHeight * down)
    if (hit === null) continue
    if (hit === element || element.contains(hit) || (root instanceof ShadowRoot && root.host === hit)) hits += 1
  }
  const anchor = element.closest('a[href]')
  const form = element.closest('form')
  const formActionAttribute = element.getAttribute('formaction')
  return {
    name: nameOf(element).slice(0, 200),
    value: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
      ? element.value
      : '',
    href: anchor === null ? null : new URL(anchor.getAttribute('href') ?? '', doc.baseURI).href,
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
    width: rect.width,
    height: rect.height,
    viewportFraction: fraction(inViewWidth * inViewHeight),
    occlusion: inViewWidth <= 0 || inViewHeight <= 0 ? 0 : hits / points.length,
    clippedBy,
    clippingFraction: fraction(clippedArea),
  }
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
    ariaHidden: facts.ariaHidden ? 0 : 1,
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
  const ariaHidden = record.ariaHidden
  if (typeof ariaHidden !== 'boolean') throw new Error('the visibility probe returned no ariaHidden')
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
    width: number('width'),
    height: number('height'),
    viewportFraction: number('viewportFraction'),
    occlusion: number('occlusion'),
    clippedBy: number('clippedBy'),
    clippingFraction: number('clippingFraction'),
  }
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
