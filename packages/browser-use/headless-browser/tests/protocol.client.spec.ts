/**
 * The browser half of the take-over wire: what the live socket says, what one
 * DOM event becomes, and the check that the Host accepts exactly what this half
 * produces. The client's message builders are fed through the Host's own
 * `decodeClientMessage`, so the two directions cannot drift apart silently.
 */

import { describe, expect, it } from 'vitest'
import { decodeClientMessage } from '../src/input.ts'
import type { FrameMetadata } from '../src/input.ts'
import {
  controlMessage, decodeServerMessage, decodeStatus, encodeClientMessage, keyMessage, liveSocketUrl,
  modifiersOf, mouseMessage, normalizeAddress, pagePoint, tabMessage, textMessage, wheelMessage,
} from '../src/client/protocol.ts'

/** A 1280×800 frame painted into a 640×400 box at the viewport origin. */
const METADATA: FrameMetadata = {
  offsetTop: 0,
  pageScaleFactor: 1,
  deviceWidth: 1280,
  deviceHeight: 800,
  scrollOffsetX: 0,
  scrollOffsetY: 0,
}

const RECT = { left: 0, top: 0, width: 640, height: 400 }

const FLAGS = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }

describe('live socket address', () => {
  it('uses the origin that served the app and the page\'s own scheme', () => {
    expect(liveSocketUrl({ protocol: 'http:', host: '127.0.0.1:3081' })).toBe('ws://127.0.0.1:3081/headless-browser/live')
    expect(liveSocketUrl({ protocol: 'https:', host: 'dsh.example.com' })).toBe('wss://dsh.example.com/headless-browser/live')
  })
})

describe('decodeServerMessage', () => {
  it('reads a state change, its tab strip, and a v1 state without one', () => {
    const tabs = [{ id: 't1', title: 'Sign in', url: 'https://example.com/signin', loading: false, active: true }]
    expect(decodeServerMessage(JSON.stringify({ type: 'state', holder: 'human', reason: 'signing in', tabs })))
      .toEqual({ type: 'state', holder: 'human', reason: 'signing in', tabs })
    expect(decodeServerMessage(JSON.stringify({ type: 'state', holder: 'agent' })))
      .toEqual({ type: 'state', holder: 'agent', tabs: [] })
    expect(decodeServerMessage(JSON.stringify({ type: 'state', holder: 'agent', reason: '', tabs: 'not a list' })))
      .toEqual({ type: 'state', holder: 'agent', tabs: [] })
    expect(decodeServerMessage(JSON.stringify({ type: 'state', holder: 'agent', tabs: [{ id: 't1' }, { title: 'no id' }] })))
      .toEqual({
        type: 'state',
        holder: 'agent',
        tabs: [{ id: 't1', title: '', url: '', loading: false, active: false }],
      })
    expect(decodeServerMessage(JSON.stringify({ type: 'state', holder: 'agent', tabs: [null, 'not a tab', [], { id: 't2', title: 'Two' }] })))
      .toEqual({
        type: 'state',
        holder: 'agent',
        tabs: [{ id: 't2', title: 'Two', url: '', loading: false, active: false }],
      })
  })

  it('reads a frame with the geometry pointer input is scaled by', () => {
    const text = JSON.stringify({ type: 'frame', tabId: 't2', data: '/9j/4AAQ', metadata: { ...METADATA, timestamp: 42 } })
    expect(decodeServerMessage(text)).toEqual({ type: 'frame', tabId: 't2', data: '/9j/4AAQ', metadata: { ...METADATA, timestamp: 42 } })
    expect(decodeServerMessage(JSON.stringify({ type: 'frame', data: '/9j/4AAQ', metadata: METADATA })))
      .toEqual({ type: 'frame', data: '/9j/4AAQ', metadata: METADATA })
  })

  it('reads the browser-unavailable failure', () => {
    expect(decodeServerMessage(JSON.stringify({ type: 'error', message: 'no browser' })))
      .toEqual({ type: 'error', message: 'no browser' })
  })

  it('drops anything the Host never sends', () => {
    expect(decodeServerMessage('not json')).toBeUndefined()
    expect(decodeServerMessage('null')).toBeUndefined()
    expect(decodeServerMessage('[]')).toBeUndefined()
    expect(decodeServerMessage(JSON.stringify({ type: 'close' }))).toBeUndefined()
    expect(decodeServerMessage(JSON.stringify({ type: 'state', holder: 'robot' }))).toBeUndefined()
    expect(decodeServerMessage(JSON.stringify({ type: 'frame', data: '', metadata: METADATA }))).toBeUndefined()
    expect(decodeServerMessage(JSON.stringify({ type: 'frame', data: 'x', metadata: { ...METADATA, deviceWidth: 'wide' } }))).toBeUndefined()
    expect(decodeServerMessage(JSON.stringify({ type: 'frame', data: 'x' }))).toBeUndefined()
    expect(decodeServerMessage(JSON.stringify({ type: 'error', message: '' }))).toBeUndefined()
  })
})

describe('decodeStatus', () => {
  it('reads the holder, the page URL, and the viewers', () => {
    expect(decodeStatus({ holder: 'human', reason: 'paying', url: 'https://example.com/pay', viewers: 2, launched: true }))
      .toEqual({ holder: 'human', reason: 'paying', url: 'https://example.com/pay', viewers: 2 })
  })

  it('leaves out an absent URL and reason, and needs a holder', () => {
    expect(decodeStatus({ holder: 'agent', viewers: 0 })).toEqual({ holder: 'agent', viewers: 0 })
    expect(decodeStatus({ viewers: 0 })).toBeUndefined()
    expect(decodeStatus('holder')).toBeUndefined()
    expect(decodeStatus({ holder: 'agent', url: '', viewers: -1 })).toEqual({ holder: 'agent', viewers: 0 })
  })
})

describe('pointer mapping', () => {
  it('scales a painted frame back to device pixels', () => {
    expect(pagePoint(RECT, METADATA, 320, 200)).toEqual({ x: 640, y: 400 })
    expect(pagePoint(RECT, METADATA, 0, 0)).toEqual({ x: 0, y: 0 })
  })

  it('keeps a pointer outside the frame inside the page', () => {
    expect(pagePoint(RECT, METADATA, -100, -100)).toEqual({ x: 0, y: 0 })
    expect(pagePoint(RECT, METADATA, 10_000, 10_000)).toEqual({ x: 20_000, y: 20_000 })
  })

  it('maps nothing before the frame is painted', () => {
    expect(pagePoint({ ...RECT, width: 0 }, METADATA, 10, 10)).toBeUndefined()
    expect(pagePoint({ ...RECT, height: 0 }, METADATA, 10, 10)).toBeUndefined()
    expect(pagePoint(RECT, METADATA, Number.NaN, 10)).toBeUndefined()
  })

  it('keeps a point inside the page when the frame box has no finite position', () => {
    expect(pagePoint({ ...RECT, left: Number.NaN }, METADATA, 320, 200)).toEqual({ x: 0, y: 400 })
    expect(pagePoint({ ...RECT, top: Number.POSITIVE_INFINITY }, METADATA, 320, 200)).toEqual({ x: 640, y: 0 })
  })

  it('packs the modifier keys the Host expects', () => {
    expect(modifiersOf(FLAGS)).toBe(0)
    expect(modifiersOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15)
    expect(modifiersOf({ ...FLAGS, shiftKey: true })).toBe(8)
  })

  it('builds a press, a release, and a move the Host accepts', () => {
    const down = mouseMessage('down', { ...FLAGS, clientX: 320, clientY: 200, button: 0, buttons: 1 }, RECT, METADATA)
    const up = mouseMessage('up', { ...FLAGS, clientX: 320, clientY: 200, button: 2, buttons: 0 }, RECT, METADATA)
    const move = mouseMessage('move', { ...FLAGS, clientX: 10, clientY: 20, button: -1, buttons: 0 }, RECT, METADATA)
    expect(down).toEqual({ type: 'mouse', event: 'down', x: 640, y: 400, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 })
    expect(up).toMatchObject({ button: 'right', clickCount: 1 })
    expect(move).toMatchObject({ button: 'none', clickCount: 0, x: 20, y: 40 })
    for (const message of [down, up, move]) expect(decodeClientMessage(message)).toEqual(message)
  })

  it('presses no button for a back or forward button and releases the left one', () => {
    const down = mouseMessage('down', { ...FLAGS, clientX: 320, clientY: 200, button: 3, buttons: 8 }, RECT, METADATA)
    const up = mouseMessage('up', { ...FLAGS, clientX: 320, clientY: 200, button: 4, buttons: 0 }, RECT, METADATA)
    expect(down).toMatchObject({ event: 'down', button: 'none', buttons: 0 })
    expect(up).toMatchObject({ event: 'up', button: 'left', buttons: 0 })
    for (const message of [down, up]) expect(decodeClientMessage(message)).toEqual(message)
  })

  it('maps no pointer event before the frame is painted', () => {
    expect(mouseMessage('down', { ...FLAGS, clientX: 1, clientY: 1, button: 0, buttons: 1 }, { ...RECT, width: 0 }, METADATA))
      .toBeUndefined()
  })
})

describe('wheel mapping', () => {
  it('rounds the scroll delta and keeps it inside the Host\'s range', () => {
    const message = wheelMessage({ ...FLAGS, clientX: 320, clientY: 200, deltaX: 12.4, deltaY: 99.6 }, RECT, METADATA)
    expect(message).toEqual({ type: 'wheel', x: 640, y: 400, deltaX: 12, deltaY: 100, modifiers: 0 })
    expect(decodeClientMessage(message)).toEqual(message)
    expect(wheelMessage({ ...FLAGS, clientX: 0, clientY: 0, deltaX: 0, deltaY: 50_000 }, RECT, METADATA))
      .toMatchObject({ deltaY: 10_000 })
    expect(wheelMessage({ ...FLAGS, clientX: 0, clientY: 0, deltaX: -50_000, deltaY: 0 }, RECT, METADATA))
      .toMatchObject({ deltaX: -10_000 })
  })

  it('maps no wheel turn before the frame is painted', () => {
    expect(wheelMessage({ ...FLAGS, clientX: 1, clientY: 1, deltaX: 0, deltaY: 1 }, { ...RECT, height: 0 }, METADATA))
      .toBeUndefined()
  })
})

describe('key mapping', () => {
  it('carries a printable character so Chrome inserts it', () => {
    const down = keyMessage('down', { ...FLAGS, key: 'a', code: 'KeyA', keyCode: 65 })
    expect(down).toEqual({ type: 'key', event: 'down', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0, text: 'a' })
    expect(decodeClientMessage(down)).toEqual(down)
  })

  it('keeps a shortcut and a named key as raw key events', () => {
    const shortcut = keyMessage('down', { ...FLAGS, ctrlKey: true, key: 'a', code: 'KeyA', keyCode: 65 })
    expect(shortcut).toMatchObject({ modifiers: 2 })
    expect(shortcut).not.toHaveProperty('text')
    const arrow = keyMessage('down', { ...FLAGS, key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 })
    expect(arrow).not.toHaveProperty('text')
    expect(decodeClientMessage(arrow)).toEqual(arrow)
  })

  it('never repeats the character on key up', () => {
    const up = keyMessage('up', { ...FLAGS, key: 'a', code: 'KeyA', keyCode: 65 })
    expect(up).toEqual({ type: 'key', event: 'up', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0 })
    expect(decodeClientMessage(up)).toEqual(up)
  })

  it('drops a key the Host would reject', () => {
    expect(keyMessage('down', { ...FLAGS, key: '', code: '', keyCode: 0 })).toBeUndefined()
    expect(keyMessage('down', { ...FLAGS, key: 'x'.repeat(33), code: 'KeyX', keyCode: 88 })).toBeUndefined()
    expect(keyMessage('down', { ...FLAGS, key: 'a', code: 'KeyA', keyCode: 999 })).toBeUndefined()
  })
})

describe('tab chrome messages', () => {
  it('builds every tab operation the Host accepts', () => {
    expect(tabMessage('new')).toEqual({ type: 'tab', action: 'new' })
    expect(tabMessage('new', undefined, 'https://example.com')).toEqual({ type: 'tab', action: 'new', url: 'https://example.com' })
    expect(tabMessage('close', 't3')).toEqual({ type: 'tab', action: 'close', tabId: 't3' })
    expect(tabMessage('activate', 't3')).toEqual({ type: 'tab', action: 'activate', tabId: 't3' })
    expect(tabMessage('navigate', 't3', 'https://example.com/pay')).toEqual({ type: 'tab', action: 'navigate', tabId: 't3', url: 'https://example.com/pay' })
    for (const message of [
      tabMessage('new'), tabMessage('close', 't3'), tabMessage('back', 't3'), tabMessage('forward'),
      tabMessage('reload', 't3'), tabMessage('navigate', 't3', 'https://example.com'),
    ]) expect(decodeClientMessage(message)).toEqual(message)
  })

  it('adds https:// to a bare address but leaves a scheme alone', () => {
    expect(normalizeAddress(' example.com ')).toBe('https://example.com')
    expect(normalizeAddress('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(normalizeAddress('http://127.0.0.1:3081')).toBe('http://127.0.0.1:3081')
    expect(normalizeAddress('data:text/html,hi')).toBe('data:text/html,hi')
    expect(normalizeAddress('about:blank')).toBe('about:blank')
    expect(normalizeAddress('   ')).toBeUndefined()
  })
})

describe('text and control messages', () => {
  it('inserts pasted text and drops an empty insertion', () => {
    expect(textMessage('')).toBeUndefined()
    const message = textMessage('你好')
    expect(message).toEqual({ type: 'text', text: '你好' })
    expect(decodeClientMessage(message)).toEqual(message)
    expect(textMessage('x'.repeat(5_000))).toMatchObject({ text: 'x'.repeat(4_000) })
  })

  it('asks the Host to move control', () => {
    expect(controlMessage('take', '浏览器接管')).toEqual({ type: 'control', action: 'take', reason: '浏览器接管' })
    expect(controlMessage('release')).toEqual({ type: 'control', action: 'release' })
    expect(decodeClientMessage(controlMessage('take', 'x'))).toEqual({ type: 'control', action: 'take', reason: 'x' })
  })

  it('serializes one message as the socket\'s text', () => {
    expect(JSON.parse(encodeClientMessage(controlMessage('release')))).toEqual({ type: 'control', action: 'release' })
  })
})
