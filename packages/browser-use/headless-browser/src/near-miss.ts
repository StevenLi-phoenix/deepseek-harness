/**
 * What a selector miss tells the model. A selector that matches nothing usually
 * names the right words on the wrong kind of element: a link it called a
 * button, a Workday menu item it called an option, a field it named by a label
 * the page never tied to it. So the miss names the elements the page does call
 * by those words, each with a selector that matches it, and the model's next
 * call can land without a read or another guess.
 *
 * @module @deepseek-ai/dsh-headless-browser/near-miss
 */

import type { Page } from 'playwright-core'

/** The advice a miss carries when the selector names no words to look for. */
export const DEFAULT_MISS_ADVICE = 'check the selector or read the whole page'

/** Most elements one miss names. */
export const MAX_NEAR_MISSES = 3

/** Longest name a suggested selector quotes; a longer text is a paragraph, not a control's name. */
const MAX_QUOTED_NAME = 80

/** The words a selector names its target by. */
export interface NameKey {
  /** The literal words, or a regular expression's source. */
  readonly text: string
  /** The regular expression's flags; absent for literal words. */
  readonly flags?: string
  /** Whether the whole name must equal the words rather than contain them. */
  readonly exact: boolean
}

/** One element the page names by a miss's words, as the page reports it. */
export interface NamedElement {
  /** Lower-case tag name. */
  readonly tag: string
  /** Explicit or implicit ARIA role; absent when it has none a role selector can name. */
  readonly role?: string
  /** Where the name came from. */
  readonly via: 'text' | 'aria-label' | 'label' | 'placeholder' | 'title'
  /** The name, whitespace folded. */
  readonly name: string
  /** Whether it is drawn on screen. */
  readonly visible: boolean
  /** `#id` when that id is unique on the page. */
  readonly idSelector?: string
  /** The one field next to a name that is plain text, as `#id`, for a miss that meant to type. */
  readonly field?: string
}

/** One element a miss names, with the selector the model can send next. */
export interface NearMiss {
  readonly element: NamedElement
  /** A selector that matches this element on the page. */
  readonly selector: string
  /** How many elements that selector matches. */
  readonly count: number
}

const QUOTED = String.raw`"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'`
const REGEX = String.raw`/((?:[^/\\]|\\.)+)/([a-z]*)`

/**
 * Patterns that name an element's words, with how each one compares them. The
 * last match in a selector is its target: earlier ones are context, like the
 * form field a `label:has-text('Yes')` sits in.
 */
const KEY_PATTERNS: readonly { readonly pattern: RegExp; readonly exact: boolean; readonly inRole?: boolean }[] = [
  { pattern: new RegExp(String.raw`:text-is\(\s*(?:${QUOTED})\s*\)`, 'gu'), exact: true },
  { pattern: new RegExp(String.raw`:(?:has-text|text)\(\s*(?:${QUOTED})\s*\)`, 'gu'), exact: false },
  { pattern: new RegExp(String.raw`:text-matches\(\s*(?:${QUOTED})\s*(?:,\s*(?:${QUOTED})\s*)?\)`, 'gu'), exact: false },
  { pattern: new RegExp(String.raw`(?:^|>>\s*|\s)(?:internal:)?text=(?:${QUOTED}|${REGEX}|([^>]+?))\s*[is]?(?=\s*>>|$)`, 'gu'), exact: true },
  // `[name=…]` is an accessible name only inside a role selector; in CSS it is the form field's name attribute.
  { pattern: new RegExp(String.raw`\[\s*name\s*=\s*(?:${QUOTED}|${REGEX})\s*[is]?\s*\]`, 'gu'), exact: false, inRole: true },
  { pattern: new RegExp(String.raw`\[\s*(?:aria-label|placeholder|title)\s*[*^$~|]?=\s*(?:${QUOTED})\s*[is]?\s*\]`, 'gu'), exact: false },
  { pattern: new RegExp(String.raw`internal:label=(?:${QUOTED}|${REGEX})`, 'gu'), exact: false },
]

/**
 * Undo a selector string's backslash escapes.
 * @param text - the quoted text without its quotes.
 * @returns the text the selector means.
 */
function unescape(text: string): string {
  return text.replace(/\\(.)/gu, '$1')
}

/**
 * Read one key pattern's match.
 * @param match - the regular expression match.
 * @param exact - whether the pattern compares whole names.
 * @returns the key, or nothing when the match names no words.
 */
function keyOf(match: RegExpMatchArray, exact: boolean): NameKey | undefined {
  const source = match[0]
  const groups = match.slice(1)
  if (source.startsWith(':text-matches')) {
    const text = groups[0] ?? groups[1]
    if (text === undefined) return undefined
    return { text: unescape(text), flags: groups[2] ?? groups[3] ?? '', exact: false }
  }
  const quoted = groups[0] ?? groups[1]
  if (quoted !== undefined) {
    // An unquoted `text=Apply` compares like `:has-text`; a quoted one like `:text-is`.
    return { text: unescape(quoted), exact }
  }
  const regex = groups[2]
  if (regex !== undefined) return { text: regex, flags: groups[3] ?? '', exact: false }
  const bare = groups[4]?.trim()
  return bare === undefined || bare === '' ? undefined : { text: bare, exact: false }
}

/**
 * The words a selector names its target by: the text, accessible name, label,
 * placeholder, or title it compares, taken from the last part that compares
 * one, since earlier parts are context.
 * @param selector - the model's selector.
 * @returns the key, or nothing for a selector that names no words, such as `input[type=email]`.
 */
export function selectorKey(selector: string): NameKey | undefined {
  let best: { readonly at: number; readonly key: NameKey } | undefined
  for (const { pattern, exact, inRole } of KEY_PATTERNS) {
    for (const match of selector.matchAll(pattern)) {
      const at = match.index
      if (inRole === true && !/(?:^|>>|\s|,)(?:internal:)?role=[\w-]+(?:\s*\[[^\]]*\])*\s*$/u.test(selector.slice(0, at))) continue
      const key = keyOf(match, exact)
      if (key !== undefined && key.text.trim() !== '' && (best === undefined || at > best.at)) best = { at, key }
    }
  }
  return best?.key
}

/**
 * Find the elements a page names by one key. Playwright serialises this
 * function, so it is self-contained. A match inside a control or link that also
 * matches yields to it, and plain text that holds another match yields to the
 * inner one, so `<button><span>Apply</span></button>` reports the button.
 * @param key - the words, compared case-insensitively with whitespace folded.
 * @returns the named elements, visible ones first, at most a few.
 */
export function findNamedElements(key: NameKey): NamedElement[] {
  const LIMIT = 3
  const MAX_TEXT = 300
  const fold = (text: string): string => text.replace(/\s+/gu, ' ').trim()
  const loose = fold(key.text).toLowerCase()
  let test: (name: string) => boolean
  let maxLength = MAX_TEXT
  if (key.flags !== undefined) {
    let pattern: RegExp
    try {
      pattern = new RegExp(key.text, key.flags.replace(/[gy]/gu, ''))
    } catch {
      return []
    }
    test = name => pattern.test(name)
  } else {
    if (loose === '') return []
    test = key.exact ? name => name.toLowerCase() === loose : name => name.toLowerCase().includes(loose)
    if (!key.exact) maxLength = Math.max(80, loose.length * 3)
  }
  const CONTROL = 'input:not([type=hidden]), select, textarea, [contenteditable="true"], [role="textbox"], [role="combobox"], [role="searchbox"], [role="spinbutton"]'
  const INTERACTIVE = `${CONTROL}, button, a[href], summary, label, [role="button"], [role="link"], [role="option"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="treeitem"]`
  const implicitRole = (element: Element): string | undefined => {
    const explicit = element.getAttribute('role')?.trim().split(/\s+/u)[0]
    if (explicit !== undefined && explicit !== '') return explicit
    const tag = element.tagName.toLowerCase()
    if (tag === 'a') return element.hasAttribute('href') ? 'link' : undefined
    if (tag === 'button' || tag === 'summary') return 'button'
    if (tag === 'select') return (element as HTMLSelectElement).multiple ? 'listbox' : 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'option') return 'option'
    if (/^h[1-6]$/u.test(tag)) return 'heading'
    if (tag !== 'input') return undefined
    const type = (element as HTMLInputElement).type
    if (type === 'checkbox' || type === 'radio') return type
    if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button'
    if (type === 'number') return 'spinbutton'
    if (type === 'search') return 'searchbox'
    if (type === 'range') return 'slider'
    return ['text', 'email', 'tel', 'url', 'password', ''].includes(type) ? 'textbox' : undefined
  }
  const textOf = (element: Element): string => {
    const rendered = (element as HTMLElement).innerText as string | undefined
    return fold(typeof rendered === 'string' ? rendered : element.textContent)
  }
  const namesOf = (element: Element): { readonly via: NamedElement['via']; readonly name: string }[] => {
    const names: { via: NamedElement['via']; name: string }[] = []
    const push = (via: NamedElement['via'], raw: string | null | undefined): void => {
      const name = raw === null || raw === undefined ? '' : fold(raw)
      if (name !== '' && name.length <= maxLength) names.push({ via, name })
    }
    push('aria-label', element.getAttribute('aria-label'))
    const labelledBy = element.getAttribute('aria-labelledby')
    if (labelledBy !== null) push('label', labelledBy.split(/\s+/u).map(id => element.ownerDocument.getElementById(id)?.textContent ?? '').join(' '))
    const labels = (element as HTMLInputElement).labels as NodeListOf<HTMLLabelElement> | null | undefined
    if (labels !== null && labels !== undefined) for (const label of Array.from(labels)) push('label', textOf(label))
    push('placeholder', element.getAttribute('placeholder'))
    push('title', element.getAttribute('title'))
    const tag = element.tagName.toLowerCase()
    if (tag === 'input') {
      const input = element as HTMLInputElement
      if (['submit', 'button', 'reset'].includes(input.type)) push('text', input.value)
    } else if (tag !== 'select' && tag !== 'textarea') {
      // textContent is cheap and holds every rendered word, so it rules an element out before layout is asked for.
      const raw = fold(element.textContent)
      if (raw !== '' && (key.flags !== undefined ? test(raw) : raw.toLowerCase().includes(loose))) push('text', textOf(element))
    }
    return names
  }
  const shown = (element: Element): boolean => {
    const box = element.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0) return false
    // Older engines and test documents have no checkVisibility; a drawn box is then enough.
    if (!('checkVisibility' in element)) return true
    return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true })
  }
  // A DOM without CSS.escape (a test document) gets a backslash before every character outside [\w-].
  const cssEscape = (globalThis as { CSS?: { escape?: (value: string) => string } }).CSS?.escape
  const unique = (element: Element): string | undefined => {
    if (element.id === '') return undefined
    const escaped = `#${cssEscape === undefined ? element.id.replace(/[^\w-]/gu, '\\$&') : cssEscape(element.id)}`
    return element.ownerDocument.querySelectorAll(escaped).length === 1 ? escaped : undefined
  }
  const FIELD = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea, [contenteditable="true"], [role="textbox"], [role="combobox"]'
  const fieldOf = (element: Element): Element | undefined => {
    if (element instanceof HTMLLabelElement && element.control !== null) return element.control
    let node = element.parentElement
    for (let depth = 0; node !== null && depth < 4 && node !== element.ownerDocument.body; depth += 1, node = node.parentElement) {
      const fields = node.querySelectorAll(FIELD)
      if (fields.length === 1) return fields[0] ?? undefined
      if (fields.length > 1) return undefined
    }
    return undefined
  }
  const body = document.body as HTMLElement | null
  if (body === null) return []
  const matches: { readonly element: Element; readonly via: NamedElement['via']; readonly name: string }[] = []
  for (const element of Array.from(body.querySelectorAll('*')).slice(0, 25_000)) {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg', 'path'].includes(element.tagName)) continue
    const hit = namesOf(element).find(({ name }) => test(name))
    if (hit !== undefined) matches.push({ element, ...hit })
    if (matches.length >= 200) break
  }
  const matched = new Set(matches.map(match => match.element))
  const kept = matches.filter(({ element }) => {
    for (let node = element.parentElement; node !== null; node = node.parentElement) {
      if (matched.has(node) && node.matches(INTERACTIVE)) return false
    }
    if (element.matches(INTERACTIVE)) return true
    for (const other of matched) if (other !== element && element.contains(other)) return false
    return true
  })
  const found = kept.map(({ element, via, name }): NamedElement => {
    const role = implicitRole(element)
    const idSelector = unique(element)
    const field = element.matches(INTERACTIVE) ? undefined : fieldOf(element)
    const fieldSelector = field === undefined ? undefined : unique(field)
    return {
      tag: element.tagName.toLowerCase(),
      ...role === undefined ? {} : { role },
      via,
      name,
      visible: shown(element),
      ...idSelector === undefined ? {} : { idSelector },
      ...fieldSelector === undefined ? {} : { field: fieldSelector },
    }
  })
  return [...found.filter(entry => entry.visible), ...found.filter(entry => !entry.visible)].slice(0, LIMIT)
}

/**
 * The selectors that could name one element, most specific first.
 * @param element - what the page reported.
 * @returns candidate selectors, in the order to try them.
 */
export function selectorsFor(element: NamedElement): string[] {
  const quoted = element.name.length <= MAX_QUOTED_NAME ? JSON.stringify(element.name) : undefined
  const out: string[] = []
  if (quoted !== undefined && element.role !== undefined && element.via !== 'placeholder') out.push(`role=${element.role}[name=${quoted}]`)
  if (quoted !== undefined && element.via === 'placeholder') out.push(`[placeholder=${quoted}]`)
  if (quoted !== undefined && element.via === 'text') out.push(`text=${quoted}`)
  if (element.idSelector !== undefined) out.push(element.idSelector)
  return out
}

/**
 * Find what a missed selector meant: the elements the page names by its words,
 * each with the first suggested selector that matches on the page.
 * @param page - the page the selector missed on.
 * @param key - the words the selector named.
 * @returns the near misses, or nothing when the page names nothing that way.
 */
export async function findNearMisses(page: Pick<Page, 'evaluate' | 'locator'>, key: NameKey): Promise<NearMiss[]> {
  const named = await page.evaluate(findNamedElements, key)
  const misses: NearMiss[] = []
  for (const element of named.slice(0, MAX_NEAR_MISSES)) {
    for (const selector of selectorsFor(element)) {
      const count = await page.locator(selector).count().catch(() => 0)
      if (count > 0) {
        misses.push({ element, selector, count })
        break
      }
    }
  }
  return misses
}

/**
 * One near miss, as the advice names it.
 * @param miss - the element and its selector.
 * @returns e.g. `role=link[name="Apply Now"] (<a>)`.
 */
function describe(miss: NearMiss): string {
  const { element } = miss
  const notes = [`<${element.tag}>`]
  if (!element.visible) notes.push('hidden')
  if (miss.count > 1) notes.push(`${String(miss.count)} matches`)
  if (element.field !== undefined) notes.push(`its field is ${element.field}`)
  return `${miss.selector} (${notes.join(', ')})`
}

/**
 * The advice a selector miss carries.
 * @param key - the words the selector named, if it named any.
 * @param misses - the elements the page names that way.
 * @returns one line for the model.
 */
export function missAdvice(key: NameKey | undefined, misses: readonly NearMiss[]): string {
  if (key === undefined) return DEFAULT_MISS_ADVICE
  const words = key.flags === undefined ? JSON.stringify(key.text) : `/${key.text}/${key.flags}`
  if (misses.length === 0) return `nothing on the page is named ${words} either, so the step may not have loaded; read the page before retrying`
  return `the page names ${words} on ${misses.map(describe).join('; ')}. Retry with one of these selectors`
}
