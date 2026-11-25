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
import { BrowserTakeoverPage } from '../src/client/BrowserTakeoverPage.tsx'
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
    this.deliverText(JSON.stringify(message))
  }

  /** Deliver raw socket text, such as a frame a proxy truncated. */
  deliverText(data: string): void {
    act(() => { this.onmessage?.({ data }) })
  }

  /** Everything the page sent after `from`, decoded. */
  after(from: number): unknown[] {
    return this.sent.slice(from).map((text): unknown => JSON.parse(text))
  }
}

const t = makeTranslate(zh)

function renderPage() {
  return render(<BrowserTakeoverPage t={t} />)
}

/** The frame's image, once one is painted, with a real on-screen box in jsdom. */
function paintedFrame(): HTMLImageElement {
  const image = screen.getByRole('img') as HTMLImageElement
  Object.defineProperty(image, 'getBoundingClientRect', { value: () => RECT, configurable: true })
  return image
}

const stage = (): HTMLElement => screen.getByRole('application')

/** The pointer-capture calls the page makes, recorded per test. */
const setPointerCapture = vi.fn()
const releasePointerCapture = vi.fn()

beforeEach(() => {
  // jsdom has no pointer capture; every browser the page runs in has it.
  setPointerCapture.mockClear()
  releasePointerCapture.mockClear()
  Object.defineProperty(Element.prototype, 'setPointerCapture', { configurable: true, value: setPointerCapture })
  Object.defineProperty(Element.prototype, 'releasePointerCapture', { configurable: true, value: releasePointerCapture })
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
  Reflect.deleteProperty(Element.prototype, 'setPointerCapture')
  Reflect.deleteProperty(Element.prototype, 'releasePointerCapture')
})

describe('浏览器接管 in-app page', () => {
  it('connects to the live socket on its own origin and shows the status line', async () => {
    renderPage()
    const socket = FakeSocket.instances[0]!
    expect(socket.url).toBe(`ws://${window.location.host}/headless-browser/live`)
    socket.open()
    expect(await screen.findByDisplayValue('https://example.com/signin')).toBeDefined()
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

  it('draws the tab strip, follows the active tab, and sends chrome operations', () => {
    renderPage()
    const socket = FakeSocket.instances[0]!
    socket.open()
    socket.deliver({
      type: 'state',
      holder: 'human',
      tabs: [
        { id: 't1', title: 'Alpha', url: 'https://alpha.example/', loading: false, active: false },
        { id: 't2', title: 'Beta', url: 'https://beta.example/', loading: true, active: true },
      ],
    })
    expect(screen.getByDisplayValue('https://beta.example/')).toBeDefined()
    expect(screen.getByTitle('Alpha')).toBeDefined()
    expect(screen.getByTitle('Beta')).toBeDefined()

    // A frame from the active tab paints; one from the tab it replaced does not.
    socket.deliver({ type: 'frame', tabId: 't2', data: 'ACTIVE', metadata: METADATA })
    const image = paintedFrame()
    expect(image.src).toContain('ACTIVE')
    socket.deliver({ type: 'frame', tabId: 't1', data: 'STALE', metadata: METADATA })
    expect(paintedFrame().src).toContain('ACTIVE')

    const at = socket.sent.length
    fireEvent.click(screen.getByTitle('Alpha'))
    fireEvent.click(screen.getAllByRole('button', { name: '关闭标签页' })[1]!)
    fireEvent.click(screen.getByRole('button', { name: '新建标签页' }))
    fireEvent.click(screen.getByRole('button', { name: '后退' }))
    fireEvent.click(screen.getByRole('button', { name: '前进' }))
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    expect(socket.after(at)).toEqual([
      { type: 'tab', action: 'activate', tabId: 't1' },
      { type: 'tab', action: 'close', tabId: 't2' },
      { type: 'tab', action: 'new' },
      { type: 'tab', action: 'back', tabId: 't2' },
      { type: 'tab', action: 'forward', tabId: 't2' },
      { type: 'tab', action: 'reload', tabId: 't2' },
    ])
  })

  it('navigates from the address bar and reverts it on Escape', () => {
    renderPage()
    const socket = FakeSocket.instances[0]!
    socket.open()
    socket.deliver({
      type: 'state', holder: 'human',
      tabs: [{ id: 't1', title: 'Alpha', url: 'https://alpha.example/', loading: false, active: true }],
    })
    const address = screen.getByLabelText('地址栏') as HTMLInputElement
    fireEvent.focus(address)
    fireEvent.change(address, { target: { value: 'example.com/pay' } })
    fireEvent.keyDown(address, { key: 'Enter' })
    expect(socket.after(0)).toEqual([{ type: 'tab', action: 'navigate', tabId: 't1', url: 'https://example.com/pay' }])

    fireEvent.focus(address)
    fireEvent.change(address, { target: { value: 'typing...' } })
    fireEvent.keyDown(address, { key: 'Escape' })
    expect(address.value).toBe('https://alpha.example/')
    expect(socket.sent).toHaveLength(1)
  })

  it('focuses the viewport and forwards keys without letting a window shortcut see them', async () => {
    renderPage()
    const socket = FakeSocket.instances[0]!
    socket.open()
    socket.deliver({ type: 'state', holder: 'human', tabs: [{ id: 't1', title: 'A', url: 'https://a.example/', loading: false, active: true }] })
    socket.deliver({ type: 'frame', tabId: 't1', data: '/9j/4AAQ', metadata: METADATA })
    const shortcut = vi.fn()
    window.addEventListener('keydown', shortcut)
    const view = stage()
    fireEvent.pointerDown(view, { clientX: 320, clientY: 200, button: 0, buttons: 1 })
    expect(document.activeElement).toBe(view)
    fireEvent.keyDown(view, { key: 'Tab', code: 'Tab', keyCode: 9 })
    fireEvent.keyDown(view, { key: 'Enter', code: 'Enter', keyCode: 13 })
    fireEvent.keyDown(view, { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 })
    fireEvent.keyDown(view, { key: 'a', code: 'KeyA', keyCode: 65, ctrlKey: true })
    expect(shortcut).not.toHaveBeenCalled()
    await vi.waitFor(() => { expect(socket.after(0)).toContainEqual({ type: 'key', tabId: 't1', event: 'down', key: 'Tab', code: 'Tab', keyCode: 9, modifiers: 0 }) })
    expect(socket.after(0)).toContainEqual({ type: 'key', tabId: 't1', event: 'down', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 2 })
    window.removeEventListener('keydown', shortcut)
  })

  it('shows a reconnect line, never an HTTP error page, when the status is unauthorized and the socket drops', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ message: 'unauthorized' }, { status: 401 }))
    renderPage()
    const socket = FakeSocket.instances[0]!
    socket.open()
    act(() => { socket.onclose?.() })
    expect(screen.getByRole('status').textContent).toBe('连接断开，正在重连')
    expect(screen.queryByText('unauthorized')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
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

/** One open live socket, with the user holding control of a single active tab `t1`. */
function holdTab(tab: { title?: string; url?: string } = {}): FakeSocket {
  renderPage()
  const socket = FakeSocket.instances[0]!
  socket.open()
  socket.deliver({
    type: 'state', holder: 'human',
    tabs: [{ id: 't1', title: tab.title ?? 'Alpha', url: tab.url ?? 'https://alpha.example/', loading: false, active: true }],
  })
  return socket
}

/** Advance fake time by `ms`, then let the status poll's pending reads settle. */
async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

describe('浏览器接管 live socket lifecycle', () => {
  it('sends nothing while the live socket is still connecting', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: '接管' }))
    expect(FakeSocket.instances[0]!.sent).toEqual([])
  })

  it('ignores socket text the Host never sends', () => {
    renderPage()
    const socket = FakeSocket.instances[0]!
    socket.open()
    socket.deliverText('{"type":"frame","da')
    socket.deliver({ type: 'close' })
    expect(screen.getByText('agent 控制')).toBeDefined()
    expect(screen.getByText('等待浏览器…')).toBeDefined()
  })

  it('closes the live socket when the page goes away and opens no new one', () => {
    vi.useFakeTimers()
    try {
      const view = renderPage()
      const socket = FakeSocket.instances[0]!
      socket.open()
      view.unmount()
      expect(socket.readyState).toBe(3)
      // The browser reports the close the page asked for.
      act(() => { socket.onclose?.() })
      act(() => { vi.advanceTimersByTime(1_500) })
      expect(FakeSocket.instances).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a pending reconnect when the page goes away', () => {
    vi.useFakeTimers()
    try {
      const view = renderPage()
      const socket = FakeSocket.instances[0]!
      socket.open()
      act(() => { socket.onclose?.() })
      view.unmount()
      act(() => { vi.advanceTimersByTime(1_500) })
      expect(FakeSocket.instances).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('浏览器接管 status poll', () => {
  it('polls the status route every five seconds and takes the holder from it while the socket is down', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetch)
        .mockResolvedValueOnce(Response.json({ holder: 'agent', viewers: 1 }))
        .mockResolvedValueOnce(Response.json({ holder: 'human', reason: '用户在付款', url: 'https://example.com/pay', viewers: 2 }))
      renderPage()
      await advance(0)
      expect(screen.getByText('1 个查看者')).toBeDefined()
      expect(screen.getByText('agent 控制')).toBeDefined()
      await advance(5_000)
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(screen.getByText('2 个查看者')).toBeDefined()
      expect(screen.getByText('你控制')).toBeDefined()
      expect(screen.getByText('用户在付款')).toBeDefined()
      expect(screen.getByDisplayValue('https://example.com/pay')).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets the open live socket, not the poll, decide who holds control', async () => {
    vi.useFakeTimers()
    try {
      holdTab()
      await advance(5_000)
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(screen.getByText('你控制')).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the last status when a read fails or reports no holder', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetch)
        .mockResolvedValueOnce(Response.json({ holder: 'agent', viewers: 3 }))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(Response.json({ viewers: 9 }))
      renderPage()
      await advance(0)
      expect(screen.getByText('3 个查看者')).toBeDefined()
      await advance(5_000)
      await advance(5_000)
      expect(fetch).toHaveBeenCalledTimes(3)
      expect(screen.getByText('3 个查看者')).toBeDefined()
      expect(screen.getByText('agent 控制')).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('浏览器接管 viewport input', () => {
  it('lets the app scroll and sends no wheel turn until the user holds a laid-out frame', () => {
    renderPage()
    const socket = FakeSocket.instances[0]!
    socket.open()
    socket.deliver({ type: 'frame', data: '/9j/4AAQ', metadata: METADATA })
    const wheel = (): boolean => fireEvent(stage(), new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 320, clientY: 200, deltaY: 120 }))
    expect(wheel()).toBe(true)
    socket.deliver({ type: 'state', holder: 'human' })
    // jsdom lays nothing out, so the painted image still has an empty box.
    expect(wheel()).toBe(true)
    expect(socket.after(0)).toEqual([])
    paintedFrame()
    expect(wheel()).toBe(false)
    expect(socket.after(0)).toEqual([{ type: 'wheel', x: 640, y: 400, deltaX: 0, deltaY: 120, modifiers: 0 }])
  })

  it('sends a wheel turn and pointer moves to the tab whose frame is painted', () => {
    const socket = holdTab()
    socket.deliver({ type: 'frame', tabId: 't1', data: '/9j/4AAQ', metadata: METADATA })
    paintedFrame()
    fireEvent(stage(), new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 320, clientY: 200, deltaX: -40 }))
    fireEvent(stage(), new MouseEvent('pointermove', { bubbles: true, clientX: 64, clientY: 40, button: -1, buttons: 0 }))
    expect(fireEvent(stage(), new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: 64, clientY: 40, button: 0, buttons: 0 }))).toBe(false)
    expect(socket.after(0)).toEqual([
      { type: 'wheel', tabId: 't1', x: 640, y: 400, deltaX: -40, deltaY: 0, modifiers: 0 },
      { type: 'mouse', tabId: 't1', event: 'move', x: 128, y: 80, button: 'none', buttons: 0, clickCount: 0, modifiers: 0 },
      { type: 'mouse', tabId: 't1', event: 'up', x: 128, y: 80, button: 'left', buttons: 0, clickCount: 1, modifiers: 0 },
    ])
    expect(releasePointerCapture).toHaveBeenCalledOnce()
  })

  it('counts quick repeated left presses as double and triple clicks, up to three', () => {
    const now = vi.spyOn(Date, 'now')
    try {
      const socket = holdTab()
      socket.deliver({ type: 'frame', tabId: 't1', data: '/9j/4AAQ', metadata: METADATA })
      paintedFrame()
      const press = (at: number, button = 0): void => {
        now.mockReturnValue(at)
        fireEvent(stage(), new MouseEvent('pointerdown', { bubbles: true, clientX: 320, clientY: 200, button, buttons: button === 0 ? 1 : 2 }))
      }
      press(10_000)
      press(10_100)
      press(10_200)
      press(10_300)
      // Past the 400 ms window, and a right press, each start over.
      press(10_800)
      press(10_900, 2)
      const down = (clickCount: number, button = 'left', buttons = 1) => (
        { type: 'mouse', tabId: 't1', event: 'down', x: 640, y: 400, button, buttons, clickCount, modifiers: 0 }
      )
      expect(socket.after(0)).toEqual([down(1), down(2), down(3), down(3), down(1), down(1, 'right', 2)])
      expect(setPointerCapture).toHaveBeenCalledTimes(6)
    } finally {
      now.mockRestore()
    }
  })

  it('leaves a key code the Host would reject, and a key composed by an input method, to the app', () => {
    const socket = holdTab()
    expect(fireEvent.keyDown(stage(), { key: 'a', code: 'KeyA', keyCode: 300 })).toBe(true)
    expect(fireEvent.keyDown(stage(), { key: 'n', code: 'KeyN', keyCode: 229, isComposing: true })).toBe(true)
    expect(socket.after(0)).toEqual([])
  })

  it('pastes clipboard text into the active tab and ignores an empty paste', () => {
    renderPage()
    const socket = FakeSocket.instances[0]!
    socket.open()
    socket.deliver({ type: 'state', holder: 'human' })
    const paste = (text: string): boolean => fireEvent.paste(stage(), {
      clipboardData: { getData: (format: string) => (format === 'text' ? text : '') },
    })
    expect(paste('')).toBe(true)
    expect(paste('无标签页')).toBe(false)
    socket.deliver({ type: 'state', holder: 'human', tabs: [{ id: 't1', title: 'A', url: 'https://a.example/', loading: false, active: true }] })
    expect(paste('一段文字')).toBe(false)
    expect(socket.after(0)).toEqual([
      { type: 'text', text: '无标签页' },
      { type: 'text', tabId: 't1', text: '一段文字' },
    ])
  })

  it('keeps the app\'s context menu off the viewport', () => {
    renderPage()
    expect(fireEvent.contextMenu(stage())).toBe(false)
  })

  it('shows a Host failure over the painted frame until the next frame arrives', () => {
    renderPage()
    const socket = FakeSocket.instances[0]!
    socket.open()
    socket.deliver({ type: 'frame', data: 'FIRST', metadata: METADATA })
    socket.deliver({ type: 'error', message: 'browser unavailable' })
    expect(screen.getByText('browser unavailable')).toBeDefined()
    expect(paintedFrame().src).toContain('FIRST')
    socket.deliver({ type: 'frame', data: 'NEXT', metadata: METADATA })
    expect(screen.queryByText('browser unavailable')).toBeNull()
    expect(paintedFrame().src).toContain('NEXT')
  })

  it('names a tab without a title as a new tab', () => {
    holdTab({ title: '' })
    expect(screen.getByTitle('新标签页').textContent).toBe('新标签页')
  })

  it('inserts typed text into the active tab only when Enter is pressed with text', () => {
    const socket = holdTab()
    const insert = screen.getByLabelText('输入文本后回车插入') as HTMLInputElement
    expect(fireEvent.keyDown(insert, { key: 'Enter' })).toBe(true)
    fireEvent.change(insert, { target: { value: '你好' } })
    expect(fireEvent.keyDown(insert, { key: 'a' })).toBe(true)
    expect(socket.after(0)).toEqual([])
    expect(fireEvent.keyDown(insert, { key: 'Enter' })).toBe(false)
    expect(socket.after(0)).toEqual([{ type: 'text', tabId: 't1', text: '你好' }])
    expect(insert.value).toBe('')
  })
})

describe('浏览器接管 address bar', () => {
  const addressBar = (): HTMLInputElement => screen.getByLabelText('地址栏') as HTMLInputElement

  it('opens a typed address in a new tab when no tab is open', () => {
    renderPage()
    const socket = FakeSocket.instances[0]!
    socket.open()
    socket.deliver({ type: 'state', holder: 'human' })
    const address = addressBar()
    act(() => { address.focus() })
    fireEvent.change(address, { target: { value: 'example.com' } })
    fireEvent.keyDown(address, { key: 'Enter' })
    expect(document.activeElement).not.toBe(address)
    expect(socket.after(0)).toEqual([{ type: 'tab', action: 'new', url: 'https://example.com' }])
  })

  it('sends nothing for a blank address and leaves other keys to the input', () => {
    const socket = holdTab()
    const address = addressBar()
    act(() => { address.focus() })
    fireEvent.change(address, { target: { value: '   ' } })
    expect(fireEvent.keyDown(address, { key: 'a' })).toBe(true)
    fireEvent.keyDown(address, { key: 'Enter' })
    expect(socket.after(0)).toEqual([])
  })

  it('reverts an abandoned edit to the active tab\'s URL when the bar loses focus', () => {
    const socket = holdTab()
    const address = addressBar()
    act(() => { address.focus() })
    fireEvent.change(address, { target: { value: 'typing...' } })
    act(() => { address.blur() })
    expect(address.value).toBe('https://alpha.example/')
    expect(socket.sent).toEqual([])
  })

  it('empties an abandoned edit when no page is open', () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ holder: 'agent', viewers: 0 }))
    renderPage()
    const socket = FakeSocket.instances[0]!
    socket.open()
    socket.deliver({ type: 'state', holder: 'human' })
    const address = addressBar()
    act(() => { address.focus() })
    fireEvent.change(address, { target: { value: 'typing...' } })
    act(() => { address.blur() })
    expect(address.value).toBe('')
    act(() => { address.focus() })
    fireEvent.change(address, { target: { value: 'typing again' } })
    fireEvent.keyDown(address, { key: 'Escape' })
    expect(address.value).toBe('')
    expect(socket.sent).toEqual([])
  })
})
