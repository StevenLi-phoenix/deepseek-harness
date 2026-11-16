/**
 * The screencast follows exactly one tab: frames are tagged with the tab they
 * came from, a switch stops the old cast and starts the new one, a late frame
 * from the old tab paints nothing, and a viewer that joins a still tab gets the
 * last painted frame of the active one.
 */

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { CDPSession } from 'playwright-core'
import type { FrameMetadata } from '../src/input.ts'
import { LiveView, type CastTarget, type Viewer } from '../src/live-view.ts'

const METADATA: FrameMetadata = {
  offsetTop: 0, pageScaleFactor: 1, deviceWidth: 1280, deviceHeight: 800, scrollOffsetX: 0, scrollOffsetY: 0,
}

const LOG = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Context['logger']

/** A CDP session that records commands and lets a test paint a frame. */
class FakeCdp extends EventEmitter {
  readonly sent: Array<{ method: string; params: unknown }> = []
  async send(method: string, params: unknown): Promise<unknown> {
    this.sent.push({ method, params })
    return {}
  }
  frame(sessionId: number, data: string): void {
    this.emit('Page.screencastFrame', { data, metadata: METADATA, sessionId })
  }
  asCdp(): CDPSession { return this as unknown as CDPSession }
}

class FakeViewer implements Viewer {
  readonly sent: string[] = []
  send(text: string): void { this.sent.push(text) }
  messages(): unknown[] { return this.sent.map(text => JSON.parse(text) as unknown) }
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
    const target: CastTarget = { tabId: 't1', cdp: first.asCdp() }
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
    let current: CastTarget = { tabId: 't1', cdp: first.asCdp() }
    const live = view(() => current)
    const viewer = new FakeViewer()
    await live.attach(viewer)
    first.frame(1, 'OLD')

    current = { tabId: 't2', cdp: second.asCdp() }
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
    const live = view(() => ({ tabId: 't1', cdp: cdp.asCdp() }))
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
    const live = view(() => ({ tabId: 't1', cdp: cdp.asCdp() }))
    const viewer = new FakeViewer()
    await live.attach(viewer)
    await live.detach(viewer)
    expect(live.size).toBe(0)
    expect(cdp.sent.some(entry => entry.method === 'Page.stopScreencast')).toBe(true)
  })
})
