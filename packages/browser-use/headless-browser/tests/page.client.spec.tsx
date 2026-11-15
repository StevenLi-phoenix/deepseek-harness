// @vitest-environment jsdom

/**
 * 浏览器接管 inside the app shell: the page connects to the live socket it
 * finds on its own origin, paints the frame, and forwards pointer, wheel, key,
 * and text input only while the user holds control. The socket and the status
 * route are scripted here; the message shapes they receive are the Host's own.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { BrowserTakeoverPage, type BrowserTakeoverViewProps } from '../src/client/BrowserTakeoverPage.tsx'
import { zh } from '../src/client/locales.ts'

/** One painted 1280×800 frame inside a 640×400 box at the viewport origin. */
const METADATA = {
  offsetTop: 0,
  pageScaleFactor: 1,
  deviceWidth: 1280,
  deviceHeight: 800,
  scrollOffsetX: 0,
  scrollOffsetY: 0,
}

const RECT = { left: 0, top: 0, width: 640, height: 400, right: 640, bottom: 400, x: 0, y: 0, toJSON: () => RECT }

/** One scripted live socket; every message the page sends lands in `sent`. */
class FakeSocket {
  static readonly instances: FakeSocket[] = []
  readyState = 0
  readonly sent: string[] = []
  onopen: (() => void) | undefined
  onmessage: ((event: { data: string }) => void) | undefined
  onclose: (() => void) | undefined
  readonly url: string

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }

  send(text: string): void {
    this.sent.push(text)
  }

  close(): void {
    this.readyState = 3
  }

  /** Mark the socket open, the way a live Host would. */
  open(): void {
    this.readyState = 1
    act(() => { this.onopen?.() })
  }

  /** Deliver one Host message. */
  deliver(message: unknown): void {
    act(() => { this.onmessage?.({ data: JSON.stringify(message) }) })
  }

  /** Everything the page sent after `from`, decoded. */
  after(from: number): unknown[] {
    return this.sent.slice(from).map(text => JSON.parse(text) as unknown)
  }
}

const t = makeTranslate(zh)

function renderPage() {
  return render(<BrowserTakeoverPage {...({ t } as BrowserTakeoverViewProps)} />)
}

/** The frame's image, once one is painted, with a real on-screen box in jsdom. */
function paintedFrame(): HTMLImageElement {
  const image = screen.getByRole('img') as HTMLImageElement
  Object.defineProperty(image, 'getBoundingClientRect', { value: () => RECT })
  return image
}

const stage = (): HTMLElement => screen.getByRole('application')

beforeEach(() => {
  FakeSocket.instances.length = 0
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ holder: 'agent', viewers: 1, url: 'https://example.com/signin', launched: true }),
  })))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('浏览器接管 in-app page', () => {
  it('connects to the live socket on its own origin and shows the status line', async () => {
    renderPage()
    const socket = FakeSocket.instances[0]!
    expect(socket.url).toBe(`ws://${window.location.host}/headless-browser/live`)
    socket.open()
    expect(await screen.findByText('https://example.com/signin')).toBeDefined()
    expect(screen.getByText('1 个查看者')).toBeDefined()
    expect(screen.getByText('agent 控制')).toBeDefined()
    expect(screen.getByText('等待浏览器…')).toBeDefined()
  })

  it('paints a frame the Host sends and follows a control change', () => {
    renderPage()
    const socket = FakeSocket.instances[0]!
    socket.open()
    socket.deliver({ type: 'frame', data: '/9j/4AAQ', metadata: METADATA })
    const image = paintedFrame()
    expect(image.src).toBe('data:image/jpeg;base64,/9j/4AAQ')
    socket.deliver({ type: 'state', holder: 'human', reason: '用户从接管页取得控制' })
    expect(screen.getByText('你控制')).toBeDefined()
    expect(screen.getByText('用户从接管页取得控制')).toBeDefined()
    expect(screen.queryByRole('button', { name: '接管' })).toBeNull()
    socket.deliver({ type: 'state', holder: 'agent' })
    expect(screen.getByText('agent 控制')).toBeDefined()
    expect(screen.queryByRole('button', { name: '交回' })).toBeNull()
  })

  it('asks to take control, then sends pointer, wheel, key, and text input', () => {
    renderPage()
    const socket = FakeSocket.instances[0]!
    socket.open()
    socket.deliver({ type: 'frame', data: '/9j/4AAQ', metadata: METADATA })
    // Nothing reaches the browser while the agent holds it.
    const before = socket.sent.length
    fireEvent(stage(), new MouseEvent('pointerdown', { bubbles: true, clientX: 320, clientY: 200, button: 0, buttons: 1 }))
    expect(socket.after(before)).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: '接管' }))
    expect(socket.after(before)).toEqual([{ type: 'control', action: 'take', reason: '用户从应用内的浏览器接管页取得控制' }])
    socket.deliver({ type: 'state', holder: 'human' })

    const at = socket.sent.length
    paintedFrame()
    fireEvent(stage(), new MouseEvent('pointerdown', { bubbles: true, clientX: 320, clientY: 200, button: 0, buttons: 1 }))
    fireEvent(stage(), new MouseEvent('pointerup', { bubbles: true, clientX: 320, clientY: 200, button: 0, buttons: 0 }))
    fireEvent(stage(), new MouseEvent('pointermove', { bubbles: true, clientX: 64, clientY: 40, button: -1, buttons: 0 }))
    fireEvent(stage(), new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 320, clientY: 200, deltaY: 120 }))
    fireEvent.keyDown(stage(), { key: 'a', code: 'KeyA', keyCode: 65 })
    fireEvent.keyUp(stage(), { key: 'a', code: 'KeyA', keyCode: 65 })
    const input = screen.getByLabelText('输入文本后回车插入')
    fireEvent.change(input, { target: { value: '你好' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(socket.after(at)).toEqual([
      { type: 'mouse', event: 'down', x: 640, y: 400, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 },
      { type: 'mouse', event: 'up', x: 640, y: 400, button: 'left', buttons: 0, clickCount: 1, modifiers: 0 },
      { type: 'mouse', event: 'move', x: 128, y: 80, button: 'none', buttons: 0, clickCount: 0, modifiers: 0 },
      { type: 'wheel', x: 640, y: 400, deltaX: 0, deltaY: 120, modifiers: 0 },
      { type: 'key', event: 'down', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0, text: 'a' },
      { type: 'key', event: 'up', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0 },
      { type: 'text', text: '你好' },
    ])
  })

  it('hands control back and stops forwarding input', () => {
    renderPage()
    const socket = FakeSocket.instances[0]!
    socket.open()
    socket.deliver({ type: 'frame', data: '/9j/4AAQ', metadata: METADATA })
    socket.deliver({ type: 'state', holder: 'human' })
    fireEvent.click(screen.getByRole('button', { name: '交回' }))
    expect(socket.after(0)).toEqual([{ type: 'control', action: 'release' }])
    socket.deliver({ type: 'state', holder: 'agent' })
    const at = socket.sent.length
    paintedFrame()
    fireEvent(stage(), new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, button: 0, buttons: 1 }))
    fireEvent.keyDown(stage(), { key: 'a', code: 'KeyA', keyCode: 65 })
    expect(socket.after(at)).toEqual([])
  })

  it('shows the Host\'s failure and reconnects after the socket drops', () => {
    vi.useFakeTimers()
    try {
      renderPage()
      const socket = FakeSocket.instances[0]!
      socket.open()
      socket.deliver({ type: 'error', message: 'browser unavailable' })
      expect(screen.getByText('browser unavailable')).toBeDefined()

      act(() => { socket.onclose?.() })
      expect(screen.getByText('连接断开，正在重连')).toBeDefined()

      act(() => { vi.advanceTimersByTime(1_500) })
      expect(FakeSocket.instances).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
