/**
 * The screencast follows exactly one tab: frames are tagged with the tab they
 * came from, a switch stops the old cast and starts the new one, a late frame
 * from the old tab paints nothing, and a viewer that joins a still tab gets the
 * last painted frame of the active one.
 */

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { FrameMetadata } from '../src/input.ts'
import { LiveView, type CastCdp, type CastTarget, type Viewer } from '../src/live-view.ts'

const METADATA: FrameMetadata = {
  offsetTop: 0, pageScaleFactor: 1, deviceWidth: 1280, deviceHeight: 800, scrollOffsetX: 0, scrollOffsetY: 0,
}

const LOG = {
  info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
} satisfies Pick<Context['logger'], 'debug' | 'error' | 'info' | 'warn'>

/** A CDP session that records commands and lets a test paint a frame. */
class FakeCdp extends EventEmitter implements CastCdp {
  readonly sent: Array<{ method: string; params: unknown }> = []
  /** Commands that fail, and the error each one fails with. */
  readonly failures = new Map<string, Error>()
  async send(method: string, params?: unknown): Promise<unknown> {
    this.sent.push({ method, params })
    const failure = this.failures.get(method)
    if (failure !== undefined) throw failure
    return {}
  }
  frame(sessionId: number, data: string): void {
    this.emit('Page.screencastFrame', { data, metadata: METADATA, sessionId })
  }
  started(): number {
    return this.sent.filter(entry => entry.method === 'Page.startScreencast').length
  }
}

class FakeViewer implements Viewer {
  readonly sent: string[] = []
  send(text: string): void { this.sent.push(text) }
  messages(): unknown[] { return this.sent.map((text): unknown => JSON.parse(text)) }
}

function isFrame(value: unknown): value is { type: 'frame'; tabId: string; data: string } {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'frame'
}

const view = (targets: () => CastTarget) => new LiveView(async () => targets(), {
  jpegQuality: 50, maxWidth: 1280, maxHeight: 800,
}, LOG)

describe('live view tab routing', () => {
  it('starts on the active tab and tags every frame with its tab id', async () => {
    const first = new FakeCdp()
    const target: CastTarget = { tabId: 't1', cdp: first }
    const live = view(() => target)
    const viewer = new FakeViewer()
    await live.attach(viewer)
    expect(first.sent[0]).toMatchObject({ method: 'Page.startScreencast' })

    first.frame(1, 'AAAA')
    await vi.waitFor(() => { expect(viewer.messages().some(isFrame)).toBe(true) })
    expect(viewer.messages().find(isFrame)).toMatchObject({ type: 'frame', tabId: 't1', data: 'AAAA' })
    expect(first.sent.some(entry => entry.method === 'Page.screencastFrameAck')).toBe(true)
    await live.close()
  })

  it('stops the old tab, starts the new one, and ignores a late old frame', async () => {
    const first = new FakeCdp()
    const second = new FakeCdp()
    let current: CastTarget = { tabId: 't1', cdp: first }
    const live = view(() => current)
    const viewer = new FakeViewer()
    await live.attach(viewer)
    first.frame(1, 'OLD')

    current = { tabId: 't2', cdp: second }
    await live.refresh()
    expect(first.sent.some(entry => entry.method === 'Page.stopScreencast')).toBe(true)
    expect(second.sent[0]).toMatchObject({ method: 'Page.startScreencast' })

    // Chrome may deliver one more frame before the stop lands; it must not paint.
    first.frame(2, 'LATE')
    const before = viewer.messages().length
    second.frame(3, 'NEW')
    await vi.waitFor(() => { expect(viewer.messages().length).toBeGreaterThan(before) })
    expect(viewer.messages().filter(isFrame).at(-1)).toMatchObject({ tabId: 't2', data: 'NEW' })
    expect(viewer.messages().filter(isFrame).some(message => message.data === 'LATE')).toBe(false)
    await live.close()
  })

  it('replays the active tab\'s last frame to a viewer that joins a still tab', async () => {
    const cdp = new FakeCdp()
    const live = view(() => ({ tabId: 't1', cdp }))
    const first = new FakeViewer()
    await live.attach(first)
    cdp.frame(1, 'STILL')
    await vi.waitFor(() => { expect(first.messages().some(isFrame)).toBe(true) })

    const second = new FakeViewer()
    await live.attach(second)
    expect(second.messages().find(isFrame)).toMatchObject({ tabId: 't1', data: 'STILL' })
    await live.close()
  })

  it('stops the cast when the last viewer leaves but keeps the browser open', async () => {
    const cdp = new FakeCdp()
    const live = view(() => ({ tabId: 't1', cdp }))
    const viewer = new FakeViewer()
    await live.attach(viewer)
    await live.detach(viewer)
    expect(live.size).toBe(0)
    expect(cdp.sent.some(entry => entry.method === 'Page.stopScreencast')).toBe(true)
  })

  it('restarts the cast on the active tab after the cast\'s page closes and ignores the closed page\'s frames', async () => {
    const crashed = new FakeCdp()
    const next = new FakeCdp()
    let current: CastTarget = { tabId: 't1', cdp: crashed }
    const live = view(() => current)
    const viewer = new FakeViewer()
    await live.attach(viewer)

    current = { tabId: 't2', cdp: next }
    crashed.emit('close')
    await vi.waitFor(() => { expect(next.started()).toBe(1) })
    crashed.frame(1, 'DEAD')
    next.frame(2, 'ALIVE')
    await vi.waitFor(() => { expect(viewer.messages().some(isFrame)).toBe(true) })
    expect(viewer.messages().filter(isFrame)).toEqual([expect.objectContaining({ tabId: 't2', data: 'ALIVE' })])
    // The closed session needs no stop; only the live one gets it.
    await live.close()
    expect(crashed.sent.some(entry => entry.method === 'Page.stopScreencast')).toBe(false)
    expect(next.sent.some(entry => entry.method === 'Page.stopScreencast')).toBe(true)
  })

  it('removes a viewer and rethrows when the browser cannot start', async () => {
    const live = new LiveView(async () => { throw new Error('Chromium is not installed') }, {
      jpegQuality: 50, maxWidth: 1280, maxHeight: 800,
    }, LOG)
    await expect(live.attach(new FakeViewer())).rejects.toThrow('Chromium is not installed')
    expect(live.size).toBe(0)
  })

  it('removes a viewer and stops listening when Chrome refuses to start the screencast', async () => {
    const cdp = new FakeCdp()
    cdp.failures.set('Page.startScreencast', new Error('Target closed'))
    const live = view(() => ({ tabId: 't1', cdp }))
    const viewer = new FakeViewer()
    await expect(live.attach(viewer)).rejects.toThrow('Target closed')
    expect(live.size).toBe(0)
    expect(cdp.listenerCount('Page.screencastFrame')).toBe(0)
    // A later stop has no cast left to end.
    await live.close()
    expect(cdp.sent.some(entry => entry.method === 'Page.stopScreencast')).toBe(false)
  })

  it('still paints a frame whose acknowledgement fails, and logs the failure', async () => {
    const cdp = new FakeCdp()
    cdp.failures.set('Page.screencastFrameAck', new Error('Session closed\nprotocol detail'))
    const live = view(() => ({ tabId: 't1', cdp }))
    const viewer = new FakeViewer()
    await live.attach(viewer)
    cdp.frame(1, 'FRAME')
    expect(viewer.messages().find(isFrame)).toMatchObject({ tabId: 't1', data: 'FRAME' })
    await vi.waitFor(() => {
      expect(LOG.warn).toHaveBeenCalledWith('headless-browser: screencast ack failed: %s', 'Session closed')
    })
    await live.close()
  })

  it('keeps the current cast and logs when the active tab cannot be followed', async () => {
    const cdp = new FakeCdp()
    const source = vi.fn(async (): Promise<CastTarget> => ({ tabId: 't1', cdp }))
    const live = new LiveView(source, { jpegQuality: 50, maxWidth: 1280, maxHeight: 800 }, LOG)
    const viewer = new FakeViewer()
    await live.attach(viewer)
    source.mockRejectedValueOnce(new Error('the browser is restarting'))
    await expect(live.refresh()).resolves.toBeUndefined()
    expect(LOG.warn).toHaveBeenCalledWith('headless-browser: live view could not follow the active tab: %s', 'the browser is restarting')
    cdp.frame(1, 'STILL')
    expect(viewer.messages().find(isFrame)).toMatchObject({ tabId: 't1', data: 'STILL' })
    await live.close()
  })

  it('starts no cast for a viewer that left while the browser was starting', async () => {
    const cdp = new FakeCdp()
    const launch = Promise.withResolvers<CastTarget>()
    const live = new LiveView(async () => await launch.promise, { jpegQuality: 50, maxWidth: 1280, maxHeight: 800 }, LOG)
    const viewer = new FakeViewer()
    const attaching = live.attach(viewer)
    await live.detach(viewer)
    launch.resolve({ tabId: 't1', cdp })
    await expect(attaching).resolves.toBeUndefined()
    expect(cdp.started()).toBe(0)
    expect(viewer.sent).toEqual([])
  })

  it('keeps casting while a viewer remains, sends state to every viewer, and stops following once none is left', async () => {
    const cdp = new FakeCdp()
    let sources = 0
    const live = view(() => {
      sources += 1
      return { tabId: 't1', cdp }
    })
    const first = new FakeViewer()
    const second = new FakeViewer()
    await live.attach(first)
    await live.attach(second)
    live.broadcast({ type: 'state', holder: 'agent' })
    expect(first.messages()).toEqual([{ type: 'state', holder: 'agent' }])
    expect(second.messages()).toEqual([{ type: 'state', holder: 'agent' }])

    await live.detach(first)
    expect(cdp.sent.some(entry => entry.method === 'Page.stopScreencast')).toBe(false)
    live.broadcast({ type: 'state', holder: 'human' })
    expect(first.messages()).toHaveLength(1)
    expect(second.messages()).toHaveLength(2)

    await live.detach(second)
    const asked = sources
    await live.refresh()
    expect(sources).toBe(asked)
  })

  it('treats a stop on a page that already closed as done, and a later close of that page as no event', async () => {
    const cdp = new FakeCdp()
    cdp.failures.set('Page.stopScreencast', new Error('Target closed\nprotocol detail'))
    let sources = 0
    const live = view(() => {
      sources += 1
      return { tabId: 't1', cdp }
    })
    const viewer = new FakeViewer()
    await live.attach(viewer)
    await expect(live.stop()).resolves.toBeUndefined()
    expect(LOG.info).toHaveBeenCalledWith('headless-browser: screencast already stopped (%s)', 'Target closed')
    // A close that follows the stop is not a crash of the cast, so nothing restarts.
    cdp.emit('close')
    expect(sources).toBe(1)
    expect(cdp.started()).toBe(1)
    await live.close()
  })
})
