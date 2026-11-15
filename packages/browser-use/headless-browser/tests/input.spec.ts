/**
 * The take-over page's wire boundary: every message is decoded from untrusted
 * JSON, and only an accepted message becomes a CDP command.
 */

import { describe, expect, it } from 'vitest'
import { cdpCommand, decodeClientMessage, encodeFrame, type FrameMetadata } from '../src/input.ts'

const MODIFIERS_SHIFT = 8

describe('decodeClientMessage', () => {
  it('decodes a pointer press with its button mask and click count', () => {
    expect(decodeClientMessage({
      type: 'mouse', event: 'down', x: 120.5, y: 80, button: 'left', buttons: 1, clickCount: 1, modifiers: MODIFIERS_SHIFT,
    })).toEqual({
      type: 'mouse', event: 'down', x: 120.5, y: 80, button: 'left', buttons: 1, clickCount: 1, modifiers: MODIFIERS_SHIFT,
    })
  })

  it('decodes a pointer move without a button and a negative wheel delta', () => {
    expect(decodeClientMessage({ type: 'mouse', event: 'move', x: 0, y: 0, button: 'none', buttons: 0, clickCount: 0, modifiers: 0 }))
      .toEqual({ type: 'mouse', event: 'move', x: 0, y: 0, button: 'none', buttons: 0, clickCount: 0, modifiers: 0 })
    expect(decodeClientMessage({ type: 'wheel', x: 10, y: 20, deltaX: 0, deltaY: -120, modifiers: 0 }))
      .toEqual({ type: 'wheel', x: 10, y: 20, deltaX: 0, deltaY: -120, modifiers: 0 })
  })

  it('decodes a printable key with text and a control key without it', () => {
    expect(decodeClientMessage({ type: 'key', event: 'down', key: 'a', code: 'KeyA', keyCode: 65, text: 'a', modifiers: 0 }))
      .toMatchObject({ type: 'key', event: 'down', text: 'a' })
    expect(decodeClientMessage({ type: 'key', event: 'up', key: 'Enter', code: 'Enter', keyCode: 13, modifiers: 0 }))
      .toEqual({ type: 'key', event: 'up', key: 'Enter', code: 'Enter', keyCode: 13, modifiers: 0 })
  })

  it('decodes inserted text and both control requests', () => {
    expect(decodeClientMessage({ type: 'text', text: '你好世界' })).toEqual({ type: 'text', text: '你好世界' })
    expect(decodeClientMessage({ type: 'control', action: 'take', reason: 'sign in' }))
      .toEqual({ type: 'control', action: 'take', reason: 'sign in' })
    expect(decodeClientMessage({ type: 'control', action: 'release' })).toEqual({ type: 'control', action: 'release' })
  })

  it.each([
    ['not an object', 'mouse'],
    ['an array', [1, 2]],
    ['no type', {}],
    ['an unknown type', { type: 'keyboard', key: 'a' }],
    ['a missing coordinate', { type: 'mouse', event: 'down', y: 1, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 }],
    ['a non-finite coordinate', { type: 'mouse', event: 'down', x: Number.NaN, y: 1, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 }],
    ['a negative coordinate', { type: 'mouse', event: 'down', x: -1, y: 1, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 }],
    ['an unknown button', { type: 'mouse', event: 'down', x: 1, y: 1, button: 'back', buttons: 1, clickCount: 1, modifiers: 0 }],
    ['a click count above the limit', { type: 'mouse', event: 'down', x: 1, y: 1, button: 'left', buttons: 1, clickCount: 9, modifiers: 0 }],
    ['a modifier mask outside the protocol bits', { type: 'wheel', x: 1, y: 1, deltaX: 0, deltaY: 0, modifiers: 16 }],
    ['an oversized text value', { type: 'text', text: 'x'.repeat(4_001) }],
    ['an empty text value', { type: 'text', text: '' }],
    ['an unknown control action', { type: 'control', action: 'steal' }],
    ['an oversized take-over reason', { type: 'control', action: 'take', reason: 'x'.repeat(501) }],
  ])('rejects %s', (_label, value) => {
    expect(decodeClientMessage(value)).toBeUndefined()
  })
})

describe('cdpCommand', () => {
  it('maps a press and a release to Input.dispatchMouseEvent', () => {
    const press = decodeClientMessage({ type: 'mouse', event: 'down', x: 5, y: 6, button: 'right', buttons: 2, clickCount: 1, modifiers: 0 })!
    expect(cdpCommand(press)).toEqual({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x: 5, y: 6, button: 'right', buttons: 2, clickCount: 1, modifiers: 0 },
    })
    const move = decodeClientMessage({ type: 'mouse', event: 'move', x: 5, y: 6, button: 'none', buttons: 0, clickCount: 0, modifiers: 0 })!
    expect(cdpCommand(move)).toMatchObject({ params: { type: 'mouseMoved', button: 'none' } })
  })

  it('maps a wheel turn to a mouseWheel event with both deltas', () => {
    const wheel = decodeClientMessage({ type: 'wheel', x: 7, y: 8, deltaX: 0, deltaY: 240, modifiers: 0 })!
    expect(cdpCommand(wheel)).toEqual({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseWheel', x: 7, y: 8, deltaX: 0, deltaY: 240, button: 'none', modifiers: 0 },
    })
  })

  it('maps a printable key to keyDown and a control key to rawKeyDown', () => {
    const printable = decodeClientMessage({ type: 'key', event: 'down', key: 'a', code: 'KeyA', keyCode: 65, text: 'a', modifiers: 0 })!
    expect(cdpCommand(printable)).toEqual({
      method: 'Input.dispatchKeyEvent',
      params: {
        type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
        modifiers: 0, text: 'a', unmodifiedText: 'a',
      },
    })
    const controlKey = decodeClientMessage({ type: 'key', event: 'down', key: 'Enter', code: 'Enter', keyCode: 13, modifiers: 0 })!
    expect(cdpCommand(controlKey)).toMatchObject({ params: { type: 'rawKeyDown' } })
    const release = decodeClientMessage({ type: 'key', event: 'up', key: 'Enter', code: 'Enter', keyCode: 13, modifiers: 0 })!
    expect(cdpCommand(release)).toMatchObject({ params: { type: 'keyUp' } })
  })

  it('maps inserted text to Input.insertText and a control request to no command', () => {
    const text = decodeClientMessage({ type: 'text', text: '你好' })!
    expect(cdpCommand(text)).toEqual({ method: 'Input.insertText', params: { text: '你好' } })
    const control = decodeClientMessage({ type: 'control', action: 'take' })!
    expect(cdpCommand(control)).toBeUndefined()
  })
})

describe('encodeFrame', () => {
  it('encodes one JPEG frame with the geometry the page scales pointer input by', () => {
    const metadata: FrameMetadata = {
      offsetTop: 0, pageScaleFactor: 1, deviceWidth: 1280, deviceHeight: 800, scrollOffsetX: 0, scrollOffsetY: 0,
    }
    const text = encodeFrame('AAAA', metadata)
    expect(JSON.parse(text)).toEqual({ type: 'frame', data: 'AAAA', metadata })
  })
})
