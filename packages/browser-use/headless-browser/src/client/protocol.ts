/**
 * The browser half of the take-over wire: what the live socket says, and what
 * one DOM event becomes. The Host's `input.ts` owns the other direction — the
 * messages this module produces are exactly the messages it validates.
 *
 * Inbound text is untrusted only in the sense that any socket is: it is the
 * Host's own protocol, but a dropped connection can hand the page garbage or a
 * proxy can truncate a frame, so a message is decoded into a typed value
 * before a component renders it. Outbound values are clamped to the ranges the
 * Host accepts, so a pointer outside the frame or an oversized paste never
 * produces a message the Host rejects.
 *
 * @module @deepseek-ai/dsh-headless-browser/client/protocol
 */

import type {
  ClientMessage, ControlMessage, FrameMetadata, KeyMessage, MouseMessage, TabAction, TabInfo, TabMessage, TextMessage, WheelMessage,
} from '../input.ts'
import { LIVE_PATH } from '../paths.ts'

/** Who currently controls the browser. */
export type Holder = 'agent' | 'human'

/** A control change the Host broadcasts to every connected viewer. */
export interface StateMessage {
  readonly type: 'state'
  readonly holder: Holder
  readonly reason?: string
  /** The tab strip: every open tab, with the active one marked. */
  readonly tabs: readonly TabInfo[]
}

/** One screencast frame and the geometry pointer input is scaled by. */
export interface FrameMessage {
  readonly type: 'frame'
  /** Tab the frame came from; absent only from a v1 Host. */
  readonly tabId?: string
  readonly data: string
  readonly metadata: FrameMetadata
}

/** The Host could not show the browser; the page shows the reason and retries. */
export interface FailureMessage {
  readonly type: 'error'
  readonly message: string
}

/** One decoded message from the live socket. */
export type ServerMessage = StateMessage | FrameMessage | FailureMessage

/** What the status route reports: who holds control, the page URL, and the viewer count. */
export interface StatusView {
  readonly holder: Holder
  readonly reason?: string
  readonly url?: string
  readonly viewers: number
}

/** A laid-out element's box in CSS pixels, as `getBoundingClientRect` reports it. */
export interface ViewRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** The modifier-key flags every DOM input event carries. */
export interface ModifierFlags {
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
}

/** The pointer share of a DOM event this module maps. */
export interface PointerEventLike extends ModifierFlags {
  readonly clientX: number
  readonly clientY: number
  readonly button: number
  readonly buttons: number
}

/** The wheel share of a DOM event this module maps. */
export interface WheelEventLike extends ModifierFlags {
  readonly clientX: number
  readonly clientY: number
  readonly deltaX: number
  readonly deltaY: number
}

/** The key share of a DOM event this module maps. */
export interface KeyEventLike extends ModifierFlags {
  readonly key: string
  readonly code: string
  readonly keyCode: number
}

/** A pointer position in page coordinates, or nothing when the frame is not painted yet. */
export interface PagePoint {
  readonly x: number
  readonly y: number
}

/** Pointer button names, in the DOM `button` order. */
const BUTTONS = ['left', 'middle', 'right'] as const

/** Highest coordinate the Host accepts. */
const MAX_COORDINATE = 100_000
/** Largest scroll delta the Host accepts, per axis. */
const MAX_SCROLL_DELTA = 10_000
/** Longest inserted text the Host accepts. */
const MAX_TEXT_CHARS = 4_000
/** Largest virtual key code the Host accepts. */
const MAX_KEY_CODE = 255

/**
 * Build the live socket URL of the same origin that served the app.
 * @param location - the window's protocol and host, or a page's own origin.
 * @returns the absolute `ws:` or `wss:` URL of the live socket.
 */
export function liveSocketUrl(location: { readonly protocol: string; readonly host: string }): string {
  const scheme = location.protocol === 'https:' ? 'wss://' : 'ws://'
  return `${scheme}${location.host}${LIVE_PATH}`
}

/**
 * Decode one live-socket message.
 * @param text - the socket's message text.
 * @returns the typed message, or `undefined` for anything the Host never sends.
 */
export function decodeServerMessage(text: string): ServerMessage | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error: unknown) {
    void error
    return undefined
  }
  const message = asRecord(value)
  if (message === undefined) return undefined
  switch (message.type) {
    case 'state': return decodeState(message)
    case 'frame': return decodeFrame(message)
    case 'error': return decodeFailure(message)
    default: return undefined
  }
}

/**
 * Decode the status route's JSON.
 * @param value - the parsed response body.
 * @returns the report, or `undefined` when it carries no usable holder.
 */
export function decodeStatus(value: unknown): StatusView | undefined {
  const status = asRecord(value)
  if (status === undefined) return undefined
  const holder = asHolder(status.holder)
  if (holder === undefined) return undefined
  const url = typeof status.url === 'string' && status.url !== '' ? status.url : undefined
  const viewers = typeof status.viewers === 'number' && Number.isInteger(status.viewers) && status.viewers >= 0
    ? status.viewers
    : 0
  const reason = typeof status.reason === 'string' ? status.reason : undefined
  return {
    holder,
    ...reason === undefined ? {} : { reason },
    ...url === undefined ? {} : { url },
    viewers,
  }
}

/**
 * Map one pointer event to a page coordinate, scaling the painted frame back to
 * device pixels and keeping the point inside the page.
 * @param rect - the frame's on-screen box.
 * @param metadata - geometry of the frame that is painted.
 * @param clientX - pointer X in viewport pixels.
 * @param clientY - pointer Y in viewport pixels.
 * @returns the page coordinate, or `undefined` when nothing is painted.
 */
export function pagePoint(rect: ViewRect, metadata: FrameMetadata, clientX: number, clientY: number): PagePoint | undefined {
  if (!(rect.width > 0) || !(rect.height > 0)) return undefined
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return undefined
  const x = Math.round((clientX - rect.left) * metadata.deviceWidth / rect.width)
  const y = Math.round((clientY - rect.top) * metadata.deviceHeight / rect.height)
  return { x: clamp(x, 0, MAX_COORDINATE), y: clamp(y, 0, MAX_COORDINATE) }
}

/**
 * The Host's modifier bit mask: alt 1, ctrl 2, meta 4, shift 8.
 * @param flags - the event's modifier keys.
 * @returns the mask the Host expects.
 */
export function modifiersOf(flags: ModifierFlags): number {
  return (flags.altKey ? 1 : 0) + (flags.ctrlKey ? 2 : 0) + (flags.metaKey ? 4 : 0) + (flags.shiftKey ? 8 : 0)
}

/**
 * Map one pointer transition to the message the Host forwards.
 * @param kind - which transition happened.
 * @param event - the DOM pointer event.
 * @param rect - the painted frame's on-screen box.
 * @param metadata - geometry of the frame that is painted.
 * @returns the message, or `undefined` when no frame is painted.
 */
export function mouseMessage(
  kind: 'down' | 'up' | 'move',
  event: PointerEventLike,
  rect: ViewRect,
  metadata: FrameMetadata,
): MouseMessage | undefined {
  const point = pagePoint(rect, metadata, event.clientX, event.clientY)
  if (point === undefined) return undefined
  return {
    type: 'mouse',
    event: kind,
    x: point.x,
    y: point.y,
    button: kind === 'move' ? 'none' : BUTTONS[event.button] ?? (kind === 'up' ? 'left' : 'none'),
    buttons: event.buttons & 7,
    clickCount: kind === 'move' ? 0 : 1,
    modifiers: modifiersOf(event),
  }
}

/**
 * Map one wheel turn to the message the Host forwards.
 * @param event - the DOM wheel event.
 * @param rect - the painted frame's on-screen box.
 * @param metadata - geometry of the frame that is painted.
 * @returns the message, or `undefined` when no frame is painted.
 */
export function wheelMessage(event: WheelEventLike, rect: ViewRect, metadata: FrameMetadata): WheelMessage | undefined {
  const point = pagePoint(rect, metadata, event.clientX, event.clientY)
  if (point === undefined) return undefined
  return {
    type: 'wheel',
    x: point.x,
    y: point.y,
    deltaX: clamp(Math.round(event.deltaX), -MAX_SCROLL_DELTA, MAX_SCROLL_DELTA),
    deltaY: clamp(Math.round(event.deltaY), -MAX_SCROLL_DELTA, MAX_SCROLL_DELTA),
    modifiers: modifiersOf(event),
  }
}

/**
 * Map one key transition to the message the Host forwards. A printable key
 * carries its own character, so Chrome inserts it; every other key is a raw
 * key event with its DOM key code.
 * @param kind - key down or key up.
 * @param event - the DOM keyboard event.
 * @returns the message, or `undefined` for a key the Host would reject.
 */
export function keyMessage(kind: 'down' | 'up', event: KeyEventLike): KeyMessage | undefined {
  if (event.key === '' || event.key.length > 32) return undefined
  if (!Number.isFinite(event.keyCode) || event.keyCode < 0 || event.keyCode > MAX_KEY_CODE) return undefined
  const text = kind === 'down'
    && event.key.length === 1
    && !event.ctrlKey && !event.metaKey && !event.altKey
    ? event.key
    : undefined
  return {
    type: 'key',
    event: kind,
    key: event.key,
    code: event.code,
    keyCode: event.keyCode,
    modifiers: modifiersOf(event),
    ...text === undefined ? {} : { text },
  }
}

/**
 * Map pasted or typed text to the Host's insert-text message.
 * @param text - the text to insert.
 * @returns the message, or `undefined` for empty text.
 */
export function textMessage(text: string): TextMessage | undefined {
  if (text === '') return undefined
  return { type: 'text', text: text.slice(0, MAX_TEXT_CHARS) }
}

/**
 * Ask the Host to move control.
 * @param action - take the browser, or hand it back.
 * @param reason - what the user is doing, shown to the agent while they work.
 * @returns the control message.
 */
export function controlMessage(action: 'take' | 'release', reason?: string): ControlMessage {
  return reason === undefined ? { type: 'control', action } : { type: 'control', action, reason }
}

/**
 * Build one browser-chrome operation.
 * @param action - new, close, activate, navigate, back, forward, or reload.
 * @param tabId - the tab it names; omit for the active tab.
 * @param url - the target of a navigate, or the first URL of a new tab.
 * @returns the tab message.
 */
export function tabMessage(action: TabAction, tabId?: string, url?: string): TabMessage {
  return {
    type: 'tab',
    action,
    ...tabId === undefined ? {} : { tabId },
    ...url === undefined ? {} : { url },
  }
}

/**
 * Turn an address-bar value into an absolute URL without guessing a scheme
 * for something that already has one. A bare host or search-looking word gets
 * `https://`; the Host validates the result and refuses anything else.
 * @param value - what the owner typed.
 * @returns the absolute URL, or `undefined` for empty input.
 */
export function normalizeAddress(value: string): string | undefined {
  const text = value.trim()
  if (text === '') return undefined
  if (/^(?:https?|data|about):/iu.test(text)) return text
  return `https://${text}`
}

/**
 * Serialize one message for the socket.
 * @param message - the input, control, or tab message the page sends.
 * @returns the JSON text written to the live socket.
 */
export function encodeClientMessage(message: ClientMessage): string {
  return JSON.stringify(message)
}

function decodeState(message: Readonly<Record<string, unknown>>): StateMessage | undefined {
  const holder = asHolder(message.holder)
  if (holder === undefined) return undefined
  return {
    type: 'state',
    holder,
    ...typeof message.reason === 'string' && message.reason !== '' ? { reason: message.reason } : {},
    tabs: decodeTabs(message.tabs),
  }
}

/** Read the tab strip; a v1 Host without one reports no tabs. */
function decodeTabs(value: unknown): TabInfo[] {
  if (!Array.isArray(value)) return []
  const tabs: TabInfo[] = []
  for (const entry of value) {
    const tab = asRecord(entry)
    if (tab === undefined) continue
    if (typeof tab.id !== 'string' || tab.id === '') continue
    tabs.push({
      id: tab.id,
      title: typeof tab.title === 'string' ? tab.title : '',
      url: typeof tab.url === 'string' ? tab.url : '',
      loading: tab.loading === true,
      active: tab.active === true,
    })
  }
  return tabs
}

function decodeFrame(message: Readonly<Record<string, unknown>>): FrameMessage | undefined {
  const data = message.data
  if (typeof data !== 'string' || data === '') return undefined
  const metadata = asRecord(message.metadata)
  if (metadata === undefined) return undefined
  if (!isFiniteNumber(metadata.offsetTop) || !isFiniteNumber(metadata.pageScaleFactor)
    || !isFiniteNumber(metadata.deviceWidth) || !isFiniteNumber(metadata.deviceHeight)
    || !isFiniteNumber(metadata.scrollOffsetX) || !isFiniteNumber(metadata.scrollOffsetY)) return undefined
  return {
    type: 'frame',
    ...typeof message.tabId === 'string' && message.tabId !== '' ? { tabId: message.tabId } : {},
    data,
    metadata: {
      offsetTop: metadata.offsetTop,
      pageScaleFactor: metadata.pageScaleFactor,
      deviceWidth: metadata.deviceWidth,
      deviceHeight: metadata.deviceHeight,
      scrollOffsetX: metadata.scrollOffsetX,
      scrollOffsetY: metadata.scrollOffsetY,
      ...isFiniteNumber(metadata.timestamp) ? { timestamp: metadata.timestamp } : {},
    },
  }
}

function decodeFailure(message: Readonly<Record<string, unknown>>): FailureMessage | undefined {
  return typeof message.message === 'string' && message.message !== '' ? { type: 'error', message: message.message } : undefined
}

function asHolder(value: unknown): Holder | undefined {
  return value === 'agent' || value === 'human' ? value : undefined
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Readonly<Record<string, unknown>>
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}
