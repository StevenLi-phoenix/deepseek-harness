/**
 * The take-over page's wire messages. Everything the page sends is untrusted
 * browser input, so {@link decodeClientMessage} validates one complete message
 * before any field reaches a CDP command; {@link cdpCommand} is the only place
 * that decides which protocol event an accepted message produces.
 *
 * @module @deepseek-ai/dsh-headless-browser/input
 */

/** A pointer event the page forwards. */
export type MouseEventKind = 'move' | 'down' | 'up'

/** A pointer button, named as CDP names it. */
export type MouseButton = 'left' | 'middle' | 'right'

/** Pointer position, pressed-button mask, and click count in page coordinates. */
export interface MouseMessage {
  readonly type: 'mouse'
  /** Tab the pointer event belongs to; absent on a v1 page, which means the active tab. */
  readonly tabId?: string
  readonly event: MouseEventKind
  readonly x: number
  readonly y: number
  readonly button: MouseButton | 'none'
  /** Bit mask of the buttons held after this event: 1 left, 2 right, 4 middle. */
  readonly buttons: number
  readonly clickCount: number
  readonly modifiers: number
}

/** One wheel turn in page coordinates, with the scroll delta in CSS pixels. */
export interface WheelMessage {
  readonly type: 'wheel'
  /** Tab the wheel turn belongs to; absent on a v1 page, which means the active tab. */
  readonly tabId?: string
  readonly x: number
  readonly y: number
  readonly deltaX: number
  readonly deltaY: number
  readonly modifiers: number
}

/** One key transition; printable characters carry `text` so Chrome inserts them. */
export interface KeyMessage {
  readonly type: 'key'
  /** Tab the key belongs to; absent on a v1 page, which means the active tab. */
  readonly tabId?: string
  readonly event: 'down' | 'up'
  readonly key: string
  readonly code: string
  /** DOM `keyCode`; CDP reads it as the Windows and native virtual key code. */
  readonly keyCode: number
  readonly text?: string
  readonly modifiers: number
}

/** Text inserted as a whole, for paste and non-Latin input. */
export interface TextMessage {
  readonly type: 'text'
  /** Tab the inserted text belongs to; absent on a v1 page, which means the active tab. */
  readonly tabId?: string
  readonly text: string
}

/** The page's own control request: take the browser, or hand it back. */
export interface ControlMessage {
  readonly type: 'control'
  readonly action: 'take' | 'release'
  readonly reason?: string
}

/** One tab in the Host's state, as the tab strip draws it. */
export interface TabInfo {
  /** Stable id for the life of the tab. */
  readonly id: string
  /** Document title, empty until the page reports one. */
  readonly title: string
  /** Current URL of the tab. */
  readonly url: string
  /** Whether the tab is navigating. */
  readonly loading: boolean
  /** Whether this tab is the one the screencast follows. */
  readonly active: boolean
}

/** Browser chrome the user can operate from the take-over page. */
export type TabAction = 'new' | 'close' | 'activate' | 'navigate' | 'back' | 'forward' | 'reload'

/** One tab operation; `tabId` names the tab, and is absent for the active one. */
export interface TabMessage {
  readonly type: 'tab'
  readonly action: TabAction
  readonly tabId?: string
  /** Navigation target, required for `navigate` and accepted on `new`. */
  readonly url?: string
}

/** One validated message from the take-over page. */
export type ClientMessage = MouseMessage | WheelMessage | KeyMessage | TextMessage | ControlMessage | TabMessage

/** Parameters of one `Input.dispatchMouseEvent` command, including the wheel turn. */
export interface MouseEventParams {
  readonly type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel'
  readonly x: number
  readonly y: number
  readonly button?: MouseButton | 'none'
  readonly buttons?: number
  readonly clickCount?: number
  readonly modifiers?: number
  readonly deltaX?: number
  readonly deltaY?: number
}

/** Parameters of one `Input.dispatchKeyEvent` command. */
export interface KeyEventParams {
  readonly type: 'keyDown' | 'keyUp' | 'rawKeyDown'
  readonly key: string
  readonly code: string
  readonly windowsVirtualKeyCode: number
  readonly nativeVirtualKeyCode: number
  readonly modifiers: number
  readonly text?: string
  readonly unmodifiedText?: string
}

/** One CDP input command the page can produce; `method` selects its parameter type. */
export type InputCommand =
  | { readonly method: 'Input.dispatchMouseEvent'; readonly params: MouseEventParams }
  | { readonly method: 'Input.dispatchKeyEvent'; readonly params: KeyEventParams }
  | { readonly method: 'Input.insertText'; readonly params: { readonly text: string } }

/** Live-view frame geometry from `Page.screencastFrame`. */
export interface FrameMetadata {
  readonly offsetTop: number
  readonly pageScaleFactor: number
  readonly deviceWidth: number
  readonly deviceHeight: number
  readonly scrollOffsetX: number
  readonly scrollOffsetY: number
  readonly timestamp?: number
}

const MAX_COORDINATE = 100_000
const MAX_SCROLL_DELTA = 10_000
const MAX_TEXT_CHARS = 4_000
const MAX_KEY_CHARS = 32
const MAX_KEY_TEXT_CHARS = 16
const MAX_VIRTUAL_KEY_CODE = 255
const MAX_MODIFIERS = 15
const MAX_BUTTONS = 7
const MAX_CLICK_COUNT = 3
const MAX_REASON_CHARS = 500
const MAX_TAB_ID_CHARS = 32
const MAX_URL_CHARS = 2_048

/**
 * Decode one message received from the take-over page.
 * @param value - the parsed JSON value the socket delivered.
 * @returns the validated message, or `undefined` for anything this page does not send.
 */
export function decodeClientMessage(value: unknown): ClientMessage | undefined {
  const message = asRecord(value)
  if (message === undefined) return undefined
  switch (message.type) {
    case 'mouse': return decodeMouse(message)
    case 'wheel': return decodeWheel(message)
    case 'key': return decodeKey(message)
    case 'text': return decodeText(message)
    case 'control': return decodeControl(message)
    case 'tab': return decodeTab(message)
    // An unknown tag is not a page message this plugin understands.
    default: return undefined
  }
}

/**
 * Map an accepted message to the CDP command that performs it.
 * @param message - a message from {@link decodeClientMessage}.
 * @returns the command, or `undefined` when the message changes control instead of input.
 */
export function cdpCommand(message: ClientMessage): InputCommand | undefined {
  switch (message.type) {
    case 'mouse':
      return {
        method: 'Input.dispatchMouseEvent',
        params: {
          type: message.event === 'move' ? 'mouseMoved' : message.event === 'down' ? 'mousePressed' : 'mouseReleased',
          x: message.x,
          y: message.y,
          button: message.event === 'move' ? 'none' : message.button,
          buttons: message.buttons,
          clickCount: message.clickCount,
          modifiers: message.modifiers,
        },
      }
    case 'wheel':
      return {
        method: 'Input.dispatchMouseEvent',
        params: {
          type: 'mouseWheel',
          x: message.x,
          y: message.y,
          deltaX: message.deltaX,
          deltaY: message.deltaY,
          button: 'none',
          modifiers: message.modifiers,
        },
      }
    case 'key':
      return {
        method: 'Input.dispatchKeyEvent',
        params: {
          type: message.event === 'up' ? 'keyUp' : message.text === undefined ? 'rawKeyDown' : 'keyDown',
          key: message.key,
          code: message.code,
          windowsVirtualKeyCode: message.keyCode,
          nativeVirtualKeyCode: message.keyCode,
          modifiers: message.modifiers,
          ...message.text === undefined ? {} : { text: message.text, unmodifiedText: message.text },
        },
      }
    case 'text':
      return { method: 'Input.insertText', params: { text: message.text } }
    case 'control':
    case 'tab':
      return undefined
    default:
      return assertNever(message)
  }
}

/**
 * Encode one screencast frame for every viewer.
 * @param data - base64 JPEG bytes as CDP reported them.
 * @param metadata - page geometry that tells the page how to scale pointer input.
 * @returns the JSON text a viewer receives.
 */
export function encodeFrame(tabId: string, data: string, metadata: FrameMetadata): string {
  return JSON.stringify({ type: 'frame', tabId, data, metadata })
}

function decodeMouse(message: Readonly<Record<string, unknown>>): MouseMessage | undefined {
  const tabId = optionalTabId(message.tabId)
  const event = message.event === 'move' || message.event === 'down' || message.event === 'up' ? message.event : undefined
  const x = coordinate(message.x)
  const y = coordinate(message.y)
  const button = message.button === 'left' || message.button === 'middle' || message.button === 'right' || message.button === 'none'
    ? message.button
    : undefined
  const buttons = integer(message.buttons, MAX_BUTTONS)
  const clickCount = integer(message.clickCount, MAX_CLICK_COUNT)
  const modifiers = integer(message.modifiers, MAX_MODIFIERS)
  if (tabId === null || event === undefined || x === undefined || y === undefined || button === undefined
    || buttons === undefined || clickCount === undefined || modifiers === undefined) return undefined
  return {
    type: 'mouse',
    ...tabId === undefined ? {} : { tabId },
    event,
    x,
    y,
    button,
    buttons,
    clickCount,
    modifiers,
  }
}

function decodeWheel(message: Readonly<Record<string, unknown>>): WheelMessage | undefined {
  const tabId = optionalTabId(message.tabId)
  const x = coordinate(message.x)
  const y = coordinate(message.y)
  const deltaX = delta(message.deltaX)
  const deltaY = delta(message.deltaY)
  const modifiers = integer(message.modifiers, MAX_MODIFIERS)
  if (tabId === null || x === undefined || y === undefined || deltaX === undefined
    || deltaY === undefined || modifiers === undefined) return undefined
  return {
    type: 'wheel',
    ...tabId === undefined ? {} : { tabId },
    x,
    y,
    deltaX,
    deltaY,
    modifiers,
  }
}

function decodeKey(message: Readonly<Record<string, unknown>>): KeyMessage | undefined {
  const tabId = optionalTabId(message.tabId)
  const event = message.event === 'down' || message.event === 'up' ? message.event : undefined
  const key = boundedString(message.key, MAX_KEY_CHARS, 1)
  const code = boundedString(message.code, MAX_KEY_CHARS, 0)
  const keyCode = integer(message.keyCode, MAX_VIRTUAL_KEY_CODE)
  const modifiers = integer(message.modifiers, MAX_MODIFIERS)
  const text = message.text === undefined ? undefined : boundedString(message.text, MAX_KEY_TEXT_CHARS, 1)
  if (tabId === null || event === undefined || key === undefined || code === undefined || keyCode === undefined
    || modifiers === undefined || (message.text !== undefined && text === undefined)) return undefined
  return {
    type: 'key',
    ...tabId === undefined ? {} : { tabId },
    event,
    key,
    code,
    keyCode,
    modifiers,
    ...text === undefined ? {} : { text },
  }
}

function decodeText(message: Readonly<Record<string, unknown>>): TextMessage | undefined {
  const tabId = optionalTabId(message.tabId)
  const text = boundedString(message.text, MAX_TEXT_CHARS, 1)
  if (tabId === null || text === undefined) return undefined
  return { type: 'text', ...tabId === undefined ? {} : { tabId }, text }
}

function decodeControl(message: Readonly<Record<string, unknown>>): ControlMessage | undefined {
  const action = message.action === 'take' || message.action === 'release' ? message.action : undefined
  if (action === undefined) return undefined
  if (message.reason === undefined) return { type: 'control', action }
  const reason = boundedString(message.reason, MAX_REASON_CHARS, 0)
  return reason === undefined ? undefined : { type: 'control', action, reason }
}

function decodeTab(message: Readonly<Record<string, unknown>>): TabMessage | undefined {
  const action = message.action
  if (action !== 'new' && action !== 'close' && action !== 'activate'
    && action !== 'navigate' && action !== 'back' && action !== 'forward' && action !== 'reload') return undefined
  const tabId = optionalTabId(message.tabId)
  if (tabId === null) return undefined
  if (message.url === undefined) {
    return action === 'navigate'
      ? undefined
      : { type: 'tab', action, ...tabId === undefined ? {} : { tabId } }
  }
  const url = boundedString(message.url, MAX_URL_CHARS, 1)
  if (url === undefined) return undefined
  return { type: 'tab', action, ...tabId === undefined ? {} : { tabId }, url }
}

/** Decode an optional tab id: `undefined` when absent, `null` when present but malformed. */
function optionalTabId(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  return boundedString(value, MAX_TAB_ID_CHARS, 1) ?? null
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Readonly<Record<string, unknown>>
}

function coordinate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_COORDINATE ? value : undefined
}

function delta(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_SCROLL_DELTA ? value : undefined
}

function integer(value: unknown, limit: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= limit ? value : undefined
}

function boundedString(value: unknown, max: number, min: number): string | undefined {
  return typeof value === 'string' && value.length >= min && value.length <= max ? value : undefined
}

/** Fail at compile time when a case is missing; only a closed-union default reaches it. */
/* v8 ignore next 3 -- only reachable through the closed-union default above. */
function assertNever(value: never): never {
  throw new Error(`unreachable client message: ${JSON.stringify(value)}`)
}
