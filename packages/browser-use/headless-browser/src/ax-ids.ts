/**
 * Stable short ids for the nodes an agent can act on. `headless_browser_ax`
 * prints `e12` beside a button, and the digest of `headless_browser_look` uses
 * the same ids, so a model can read a page once and then click or type by id
 * instead of guessing a selector.
 *
 * An id belongs to one page and one document: the page keeps the mapping from
 * the first read onwards, so consecutive reads hand out the same id for the same
 * node, and a navigation drops the mapping because the DOM behind every id is
 * gone. The session's allocator numbers ids for the whole browser, so an id read
 * on one tab can never resolve to a node on another.
 *
 * @module @deepseek-ai/dsh-headless-browser/ax-ids
 */

/** The element attribute a resolved id is written into, for one locator lookup. */
export const AX_ID_ATTRIBUTE = 'data-dsh-axid'

/** An id that cannot be resolved to an element of the page. */
export class AxIdError extends Error {
  /** The id that failed, so a caller can name it without parsing the message. */
  readonly id: string

  /**
   * @param id - the id the caller asked for.
   * @param message - the refusal text shown to the model.
   */
  constructor(id: string, message: string) {
    super(message)
    this.name = 'AxIdError'
    this.id = id
  }
}

/** The id was never handed out, so no read ever printed it. */
export class UnknownAxIdError extends AxIdError {
  /**
   * @param id - the id the caller asked for.
   */
  constructor(id: string) {
    super(id, `no element has axId ${id}; read the page with headless_browser_ax and use an id it printed`)
  }
}

/** The id was handed out, but its document or tab is no longer the one acting. */
export class StaleAxIdError extends AxIdError {
  /**
   * @param id - the id the caller asked for.
   * @param detail - why resolution failed, when the browser said so.
   */
  constructor(id: string, detail?: string) {
    const why = detail === undefined ? '' : ` (${detail})`
    super(id, `axId ${id} no longer names an element on this page${why}; ids die on navigation, so read the page again with headless_browser_ax`)
  }
}

/**
 * Read the number of an `eN` id.
 * @param id - the printed id.
 * @returns the number, or nothing when the text is not one of these ids.
 */
export function parseAxId(id: string): number | undefined {
  const match = /^e(\d+)$/u.exec(id)
  if (match?.[1] === undefined) return undefined
  const value = Number.parseInt(match[1], 10)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** The ids of one page, and the node behind each of them. */
export class PageAxIds {
  readonly #allocate: () => string
  readonly #idByNode = new Map<number, string>()
  readonly #nodeById = new Map<string, number>()

  /**
   * @param allocate - the browser-wide allocator, so an id is unique across tabs.
   */
  constructor(allocate: () => string) {
    this.#allocate = allocate
  }

  /**
   * The id printed for one node; the first call allocates it, later calls reuse it.
   * @param backendDOMNodeId - the DOM node behind the accessibility node.
   * @returns the stable id.
   */
  idFor(backendDOMNodeId: number): string {
    const existing = this.#idByNode.get(backendDOMNodeId)
    if (existing !== undefined) return existing
    const id = this.#allocate()
    this.#idByNode.set(backendDOMNodeId, id)
    this.#nodeById.set(id, backendDOMNodeId)
    return id
  }

  /**
   * The node one printed id names on this page.
   * @param id - the id a tool call carried.
   * @returns the DOM node, or nothing once the document that printed it is gone.
   */
  nodeFor(id: string): number | undefined {
    return this.#nodeById.get(id)
  }

  /** Drop every mapping; the document behind the ids has been replaced. */
  invalidate(): void {
    this.#idByNode.clear()
    this.#nodeById.clear()
  }
}
