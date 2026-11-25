/**
 * Reading one tab as text instead of pixels. A screenshot captures the
 * viewport, so rows below the fold never reach the model; the page's own text
 * has no such limit. A single page of text can still be far longer than a tool
 * result should carry, so a read returns a character window and its header
 * names the page, the character range, and the length of the whole text.
 *
 * Windows are counted in characters, not UTF-16 units: a cut never splits a
 * surrogate pair, so every window is valid text on its own.
 *
 * @module @deepseek-ai/dsh-headless-browser/read
 */

/** Characters one read returns when the call names no limit. */
export const DEFAULT_READ_LIMIT = 8_000

/** Most characters one read returns, whatever limit the call names. */
export const MAX_READ_LIMIT = 20_000

/**
 * URL length the header keeps. A `data:` page carries its whole document in its
 * URL, so an untruncated header would dwarf the text it describes.
 */
const HEADER_URL_LIMIT = 120

/**
 * Smallest frame, in CSS pixels squared, a read lists: room for a form (iCIMS
 * shows its whole application in one), well above a tracking pixel or a
 * one-line widget.
 */
export const MIN_FRAME_AREA = 200 * 100

/** Most frames one read lists. */
export const MAX_READ_FRAMES = 5

/** One page embedded in the tab, whose text a read of the tab does not include. */
export interface FrameRef {
  /** The frame's own address; opening it shows the embedded page on its own. */
  readonly url: string
  /** Width on screen in CSS pixels. */
  readonly width: number
  /** Height on screen in CSS pixels. */
  readonly height: number
}

/** The selector a read named matches no element in the page. */
export class SelectorMissError extends Error {
  /**
   * @param selector - the selector that matched nothing.
   */
  constructor(selector: string) {
    super(`no element matches ${selector}; check the selector or read the whole page`)
    this.name = 'SelectorMissError'
  }
}

/** One read: which text, and which character window of it. */
export interface ReadRequest {
  /** CSS selector whose first match is read; the document body when omitted. */
  readonly selector?: string
  /** Characters skipped from the start of the text; clamped into the text, 0 when omitted. */
  readonly offset?: number
  /** Characters returned; {@link DEFAULT_READ_LIMIT} when omitted, at least 1, at most {@link MAX_READ_LIMIT}. */
  readonly limit?: number
}

/** One tab's text, cut to the requested character window. */
export interface ReadResult {
  /** One line naming the tab, its URL, the page, and the character range. */
  readonly header: string
  /** The characters of this window. */
  readonly text: string
  /** Characters in the whole text. */
  readonly total: number
  /** Offset of the next window; absent when this window reaches the end of the text. */
  readonly nextOffset?: number
  /** URL of the page the text came from, so a tool result can name its origin. */
  readonly url: string
  /** Embedded pages large enough to hold a form, for a read of the whole page; absent when there is none. */
  readonly frames?: readonly FrameRef[]
}

/** What one read needs from a page; a Playwright `Page` satisfies it. */
export interface ReadPage {
  /** URL of the page, named in the header. */
  url(): string
  /**
   * The rendered text of one element, or of the document body.
   * @param selector - CSS selector; omitted reads the whole document body.
   * @returns the text, or nothing when the target matches no element.
   */
  innerText(selector?: string): Promise<string | undefined>
  /**
   * The http(s) pages embedded in this one, with their size on screen.
   * @returns every child frame that has an address and a box.
   */
  frames?(): Promise<readonly FrameRef[]>
}

/** One character window of a text. */
interface TextWindow {
  /** Characters skipped from the start. */
  readonly start: number
  /** Characters before the window's end. */
  readonly end: number
}

/**
 * Read one tab's text and cut it to the requested character window.
 * @param page - the tab's page.
 * @param tab - the tab id the header names.
 * @param request - the selector and the character window.
 * @returns the window, the whole text's length, and the header line.
 * @throws SelectorMissError - when the selector matches no element.
 */
export async function readText(page: ReadPage, tab: string, request: ReadRequest): Promise<ReadResult> {
  const found = await page.innerText(request.selector)
  if (found === undefined && request.selector !== undefined) throw new SelectorMissError(request.selector)
  const text = found ?? ''
  const total = countCharacters(text)
  const limit = windowLimit(request.limit)
  const start = Math.min(Math.max(request.offset ?? 0, 0), total)
  const window: TextWindow = { start, end: Math.min(start + limit, total) }
  // A frame's text is not the tab's text, so a whole-page read names the frames a form may live in.
  const frames = request.selector === undefined && page.frames !== undefined
    ? (await page.frames()).filter(frame => frame.width * frame.height >= MIN_FRAME_AREA).slice(0, MAX_READ_FRAMES)
    : []
  return {
    header: headerOf(page.url(), tab, total, limit, window),
    text: text.slice(characterBoundary(text, window.start), characterBoundary(text, window.end)),
    total,
    url: page.url(),
    ...window.end < total ? { nextOffset: window.end } : {},
    ...frames.length === 0 ? {} : { frames },
  }
}

/** Clamp a requested limit into the range one read returns. */
function windowLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_READ_LIMIT
  return Math.min(Math.max(limit, 1), MAX_READ_LIMIT)
}

/**
 * The header line: what was read, which page of how many characters, and which range.
 * @param url - the page's URL.
 * @param tab - the tab id.
 * @param total - characters in the whole text.
 * @param limit - characters per page.
 * @param window - the returned window.
 * @returns one line naming the page and the range.
 */
function headerOf(url: string, tab: string, total: number, limit: number, window: TextWindow): string {
  const shown = url.length <= HEADER_URL_LIMIT ? url : `${url.slice(0, HEADER_URL_LIMIT)}…`
  const prefix = `text of ${tab} (${shown})`
  if (total === 0) return `${prefix}: the page has no text`
  const pages = Math.ceil(total / limit)
  const page = Math.min(pages, Math.floor(window.start / limit) + 1)
  if (window.start >= window.end) return `${prefix}: page ${page} of ${pages}, the text has ${total} characters`
  return `${prefix}: page ${page} of ${pages}, characters ${window.start + 1}-${window.end} of ${total}`
}

/** Characters (Unicode code points) in a text, counting a surrogate pair once. */
function countCharacters(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; index += unitLength(text, index)) count += 1
  return count
}

/**
 * The UTF-16 index of one character boundary, so a window never splits a pair.
 * @param text - the text to measure.
 * @param characters - characters to count from the start; past the end returns the text's length.
 * @returns the index of the first unit of that character.
 */
function characterBoundary(text: string, characters: number): number {
  let index = 0
  for (let count = 0; count < characters && index < text.length; count += 1) index += unitLength(text, index)
  return index
}

/** UTF-16 units one character occupies at an index: two for a surrogate pair, one otherwise. */
function unitLength(text: string, index: number): number {
  const code = text.charCodeAt(index)
  const next = text.charCodeAt(index + 1)
  return code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? 2 : 1
}
