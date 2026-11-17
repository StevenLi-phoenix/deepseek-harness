/**
 * Reading a page instead of only looking at it. The accessibility text, the
 * stable ids beside interactive nodes, the eval result text, and every size cap
 * live here as pure functions, so the session's CDP reads and the tests share
 * one rule about what the model sees.
 *
 * Everything a page returns — a role, a name, a value, an exception, a console
 * line — is page content: it is data about the page, never an instruction for
 * the agent, and the agent's own code decides what to do with it.
 *
 * @module @deepseek-ai/dsh-headless-browser/inspect
 */

/** Largest expression `headless_browser_eval` accepts, in characters. */
export const MAX_EXPRESSION_CHARS = 16_384
/** Most characters of one eval result kept in a tool result. */
export const MAX_RESULT_CHARS = 8_000
/** Most characters of one exception or console line quoted from the page. */
export const MAX_DIAGNOSTIC_CHARS = 2_000
/** Most characters of one accessibility text. */
export const MAX_AX_CHARS = 24_000
/** Nodes printed by `headless_browser_ax` when it names no cap. */
export const DEFAULT_AX_NODES = 300
/** Largest node cap `headless_browser_ax` accepts. */
export const MAX_AX_NODES = 1_000
/** Nodes of the digest `headless_browser_look` returns beside its screenshot. */
export const LOOK_DIGEST_NODES = 60
/** Characters of that digest. */
export const LOOK_DIGEST_CHARS = 2_000
/** Most diagnostics quoted from one evaluation. */
export const MAX_DIAGNOSTICS = 10
/** Longest edge of one captured image; a longer page is scaled down instead. */
export const MAX_IMAGE_EDGE = 1_568
/** Most pixels one captured image may hold. */
export const MAX_IMAGE_PIXELS = 1_200_000

/**
 * Roles the agent can act on. A node with one of these roles and a DOM backend
 * gets a short id printed beside it, which a later action resolves back to that
 * element; a file input reports the `button` role, so it is covered.
 */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
])

/** Text a cap shortened, with a marker the model can see. */
export interface Truncated {
  /** The kept prefix, ending in the marker when anything was dropped. */
  readonly text: string
  /** Whether the cap dropped characters. */
  readonly truncated: boolean
  /** Length before the cap, so a caller can report the real size. */
  readonly characters: number
}

/**
 * Keep a text within a cap and mark the cut.
 * @param text - the full text.
 * @param maxChars - most characters to keep.
 * @returns the capped text, whether it was cut, and its original length.
 */
export function truncate(text: string, maxChars: number): Truncated {
  if (text.length <= maxChars) return { text, truncated: false, characters: text.length }
  const omitted = text.length - maxChars
  return {
    text: `${text.slice(0, maxChars)}\n… [truncated: ${String(omitted)} more characters]`,
    truncated: true,
    characters: text.length,
  }
}

/** One computed value of a CDP accessibility node, as this module reads it. */
export interface AxValue {
  /** The computed value, which CDP may report as a string, number, or boolean. */
  readonly value?: unknown
}

/** One computed property of a CDP accessibility node. */
export interface AxProperty {
  /** Property name, for example `checked` or `required`. */
  readonly name?: string
  /** Computed property value. */
  readonly value?: AxValue
}

/** One node of CDP's `Accessibility.getFullAXTree`, as this module reads it. */
export interface AxNode {
  /** Node id inside this tree. */
  readonly nodeId?: string
  /** Whether the node is hidden from assistive technology. */
  readonly ignored?: boolean
  /** Role, for example `button`. */
  readonly role?: AxValue
  /** Accessible name. */
  readonly name?: AxValue
  /** Accessible value, for example a text field's contents. */
  readonly value?: AxValue
  /** Computed states and other properties. */
  readonly properties?: readonly AxProperty[]
  /** Child node ids, in document order. */
  readonly childIds?: readonly string[]
  /** The DOM node behind this accessibility node. */
  readonly backendDOMNodeId?: number
}

/** How one accessibility text is shaped. */
export interface AxTextOptions {
  /** Most nodes printed; later nodes become one `N more nodes` line. */
  readonly maxNodes?: number
  /**
   * Allocate the id printed beside one interactive node. Called once per
   * printed interactive node, so an empty read allocates nothing.
   */
  readonly idOf?: (backendDOMNodeId: number) => string
}

/** The shaped accessibility text and what it counted. */
export interface AxText {
  /** Indented `role "name" value [states]` lines, ids first where applicable. */
  readonly text: string
  /** Nodes printed. */
  readonly nodes: number
  /** Printed nodes whose role is interactive. */
  readonly interactive: number
  /** Nodes the cap left out, which the text reports as one line. */
  readonly omitted: number
  /** Whether the character cap shortened the text. */
  readonly truncated: boolean
}

/** Roles that only repeat text already carried by their parent. */
const REPEATED_ROLES: ReadonlySet<string> = new Set(['InlineTextBox', 'LineBreak'])

/**
 * Read one accessibility value as text.
 * @param value - the computed value, of whatever type CDP reported.
 * @returns a trimmed string, empty when the value is absent or not printable.
 */
function axText(value: AxValue | undefined): string {
  const raw = value?.value
  if (typeof raw === 'string') return raw.trim()
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
  return ''
}

/**
 * Read a node's states in a fixed order.
 * @param node - the accessibility node.
 * @returns `checked`, `checked=mixed`, `disabled`, `expanded=true|false`, and
 * `required` for the properties that are set.
 */
function axStates(node: AxNode): string[] {
  const properties = new Map<string, unknown>()
  for (const property of node.properties ?? []) {
    if (typeof property.name === 'string') properties.set(property.name, property.value?.value)
  }
  const states: string[] = []
  const checked = properties.get('checked')
  if (checked === true || checked === 'true') states.push('checked')
  else if (checked === 'mixed') states.push('checked=mixed')
  if (properties.get('disabled') === true) states.push('disabled')
  const expanded = properties.get('expanded')
  if (expanded === true) states.push('expanded=true')
  else if (expanded === false) states.push('expanded=false')
  if (properties.get('required') === true) states.push('required')
  return states
}

/**
 * Clamp a requested node cap into the range one read accepts.
 * @param maxNodes - the requested cap, or nothing for the default.
 * @returns the cap actually applied.
 */
export function clampMaxNodes(maxNodes: number | undefined): number {
  if (maxNodes === undefined || !Number.isFinite(maxNodes)) return DEFAULT_AX_NODES
  return Math.min(Math.max(Math.trunc(maxNodes), 1), MAX_AX_NODES)
}

/**
 * Shape CDP's flat accessibility node list into the indented text an agent
 * reads. Trees are built from `childIds`, so hidden nodes are dropped while
 * their children take their place, and a node that only repeats its parent's
 * text is dropped as well: the SPA wrappers and inline text boxes that make up
 * most of a real tree would otherwise cost more than the content.
 * @param nodes - the tree, in document order.
 * @param options - node cap and the id allocator for interactive nodes.
 * @returns the text, the printed and interactive counts, and what the cap cut.
 */
export function formatAxTree(nodes: readonly AxNode[], options: AxTextOptions = {}): AxText {
  const maxNodes = clampMaxNodes(options.maxNodes)
  const index = new Map<string, AxNode>()
  for (const node of nodes) {
    if (typeof node.nodeId === 'string') index.set(node.nodeId, node)
  }
  const claimed = new Set<string>()
  for (const node of index.values()) {
    for (const childId of node.childIds ?? []) claimed.add(childId)
  }
  const roots = [...index.values()].filter(node => !claimed.has(node.nodeId ?? ''))

  const lines: string[] = []
  /** Names of the printed ancestors at each depth, for the repeat check. */
  const keptNames: string[] = []
  let printed = 0
  let interactive = 0
  let omitted = 0

  const visit = (node: AxNode, depth: number): void => {
    if (node.ignored === true) {
      for (const childId of node.childIds ?? []) {
        const child = index.get(childId)
        if (child !== undefined) visit(child, depth)
      }
      return
    }
    const role = axText(node.role)
    if (role === '' || REPEATED_ROLES.has(role)) return
    const name = axText(node.name)
    const value = axText(node.value)
    const states = axStates(node)
    const backendDOMNodeId = node.backendDOMNodeId
    const actionable = INTERACTIVE_ROLES.has(role) && typeof backendDOMNodeId === 'number'
    const repeatsAncestor = !actionable && name !== ''
      && keptNames.slice(0, depth).some(ancestor => ancestor !== '' && (ancestor === name || ancestor.includes(name)))
    const keep = !repeatsAncestor && (actionable || name !== '' || value !== '' || states.length > 0 || role === 'RootWebArea')
    if (keep && printed < maxNodes) {
      const id = actionable && options.idOf !== undefined ? `${options.idOf(backendDOMNodeId)} ` : ''
      const namePart = name === '' ? '' : ` ${JSON.stringify(name)}`
      const valuePart = value === '' ? '' : ` value=${JSON.stringify(value)}`
      const statePart = states.length === 0 ? '' : ` [${states.join(', ')}]`
      lines.push(`${'  '.repeat(depth)}${id}${role}${namePart}${valuePart}${statePart}`)
      printed += 1
      if (actionable) interactive += 1
    } else if (keep) {
      omitted += 1
    }
    if (keep) keptNames[depth] = name
    for (const childId of node.childIds ?? []) {
      const child = index.get(childId)
      if (child !== undefined) visit(child, depth + (keep ? 1 : 0))
    }
    if (keep) keptNames.length = depth
  }

  for (const root of roots) visit(root, 0)
  if (omitted > 0) lines.push(`… ${String(omitted)} more nodes`)
  const capped = truncate(lines.join('\n'), MAX_AX_CHARS)
  return { text: capped.text, nodes: printed, interactive, omitted, truncated: capped.truncated }
}

/** The `Runtime.RemoteObject` fields the eval result text reads. */
export interface EvalRemote {
  /** Value type: `object`, `string`, `undefined`, `number`, and so on. */
  readonly type?: string
  /** The value itself when it is JSON, as CDP computed it. */
  readonly value?: unknown
  /** Chrome's own text for a value JSON cannot carry, for example `Infinity`. */
  readonly unserializableValue?: string
}

/**
 * Read one evaluation result as text an agent can hold.
 * @param remote - the CDP result object.
 * @returns JSON text, or Chrome's own form for a value JSON cannot carry.
 */
export function evalText(remote: EvalRemote | undefined): string {
  if (remote === undefined || remote.type === 'undefined') return 'undefined'
  if (remote.unserializableValue !== undefined) return remote.unserializableValue
  const value = remote.value
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value) ?? 'undefined'
  } catch (error: unknown) {
    void error
    return String(value)
  }
}

/** What one evaluation produced, as the tool reports it. */
export interface EvalReport {
  /** Page URL when the evaluation settled; it may already be the next document. */
  readonly url: string
  /** The result as JSON text, capped with a marker when long. */
  readonly result: string
  /** Whether the result cap dropped characters. */
  readonly truncated: boolean
  /** Length of the uncapped result text. */
  readonly characters: number
  /** Exceptions thrown while the expression ran, quoted verbatim. */
  readonly exceptions: readonly string[]
  /** Console errors the page logged while the expression ran, quoted verbatim. */
  readonly consoleErrors: readonly string[]
}

/** What one evaluation produced before it is shaped. */
export interface EvalOutcome {
  /** Page URL when the evaluation settled. */
  readonly url: string
  /** The CDP result object. */
  readonly result?: EvalRemote
  /** Exceptions, most authoritative first, quoted verbatim. */
  readonly exceptions?: readonly string[]
  /** Console errors, quoted verbatim. */
  readonly consoleErrors?: readonly string[]
}

/**
 * Drop diagnostics that only restate another one. A thrown exception arrives
 * twice — the CDP result's own description with a stack, and the page's error
 * event with the message alone — and the stack form already carries the text.
 * @param entries - diagnostics in priority order.
 * @returns the entries that add something, at most {@link MAX_DIAGNOSTICS}.
 */
export function uniqueDiagnostics(entries: readonly string[]): string[] {
  const kept: string[] = []
  for (const entry of entries) {
    if (entry === '') continue
    if (kept.some(other => other.includes(entry) || entry.includes(other))) continue
    kept.push(entry)
    if (kept.length === MAX_DIAGNOSTICS) break
  }
  return kept
}

/**
 * Shape one evaluation into the tool result.
 * @param outcome - value, diagnostics, and the page URL.
 * @returns the report, with the result text capped and each diagnostic quoted.
 */
export function shapeEval(outcome: EvalOutcome): EvalReport {
  const text = evalText(outcome.result)
  const capped = truncate(text, MAX_RESULT_CHARS)
  return {
    url: outcome.url,
    result: capped.text,
    truncated: capped.truncated,
    characters: capped.characters,
    exceptions: uniqueDiagnostics((outcome.exceptions ?? []).map(entry => truncate(entry, MAX_DIAGNOSTIC_CHARS).text)),
    consoleErrors: uniqueDiagnostics((outcome.consoleErrors ?? []).map(entry => truncate(entry, MAX_DIAGNOSTIC_CHARS).text)),
  }
}

/**
 * Refuse an expression the tool must not accept before the page sees it.
 * @param expression - the model's JavaScript expression.
 * @returns the refusal text, or nothing when the expression may run.
 */
export function expressionProblem(expression: string): string | undefined {
  if (expression.trim() === '') return 'expression must not be empty'
  if (expression.length > MAX_EXPRESSION_CHARS) {
    return `expression is ${String(expression.length)} characters; headless_browser_eval accepts at most ${String(MAX_EXPRESSION_CHARS)}`
  }
  return undefined
}

/** Pixel dimensions of one PNG. */
export interface ImageSize {
  readonly width: number
  readonly height: number
}

/** PNG's own 8-byte signature. */
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const

/**
 * Read the pixel size out of a PNG's header, so a result reports the image it
 * really carries instead of the size the page asked for.
 * @param data - the PNG bytes.
 * @returns width and height, or nothing when the bytes are not a PNG.
 */
export function pngSize(data: Uint8Array): ImageSize | undefined {
  if (data.length < 24) return undefined
  if (!PNG_SIGNATURE.every((byte, index) => data[index] === byte)) return undefined
  // Bytes 12-15 hold the chunk type, which must be IHDR; 16-23 hold big-endian width and height.
  if (data[12] !== 73 || data[13] !== 72 || data[14] !== 68 || data[15] !== 82) return undefined
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  return width > 0 && height > 0 ? { width, height } : undefined
}

/** What one accessibility read returns, as the tools report it. */
export interface AxRead extends AxText {
  /** Page URL when the tree was read. */
  readonly url: string
}
