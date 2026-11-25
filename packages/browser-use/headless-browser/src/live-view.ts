/**
 * The live view: one screencast at a time for every open take-over page. Chrome
 * streams a frame to one screencast session at a time, so the plugin starts a
 * single screencast on the active tab and fans its frames out; every frame is
 * acknowledged, because Chrome sends the next one only after the ack. The
 * screencast follows the active tab: switching tabs stops the old one and
 * starts the new one, and each frame names the tab it came from so a late frame
 * cannot paint over the tab the user just selected.
 *
 * @module @deepseek-ai/dsh-headless-browser/live-view
 */

import type { Context } from '@deepseek-ai/cordis'
import { firstLine } from './error.ts'
import { encodeFrame, type FrameMetadata } from './input.ts'

/** One take-over page connection; `send` ignores a socket that already closed. */
export interface Viewer {
  /** Deliver one text message; a closed viewer must not throw. */
  send(text: string): void
}

/** The part of a Playwright `CDPSession` the screencast uses; a real session satisfies it. */
export interface CastCdp {
  send(method: 'Page.startScreencast', params: ScreencastStart): Promise<unknown>
  send(method: 'Page.screencastFrameAck', params: { readonly sessionId: number }): Promise<unknown>
  send(method: 'Page.stopScreencast'): Promise<unknown>
  on(event: 'Page.screencastFrame', listener: (frame: ScreencastFrame) => void): unknown
  off(event: 'Page.screencastFrame', listener: (frame: ScreencastFrame) => void): unknown
  once(event: 'close', listener: () => void): unknown
}

/** The `Page.startScreencast` parameters this plugin sends. */
export interface ScreencastStart {
  readonly format: 'jpeg'
  readonly quality: number
  readonly maxWidth: number
  readonly maxHeight: number
  readonly everyNthFrame: number
}

/** The tab and CDP session the screencast currently follows. */
export interface CastTarget {
  readonly tabId: string
  readonly cdp: CastCdp
}

/** Frame format for every viewer. */
export interface ViewOptions {
  /** JPEG quality, 1 through 100. */
  readonly jpegQuality: number
  /** Widest frame Chrome may encode. */
  readonly maxWidth: number
  /** Tallest frame Chrome may encode. */
  readonly maxHeight: number
}

/** The part of `Page.screencastFrame` this plugin reads. */
export interface ScreencastFrame {
  readonly data: string
  readonly metadata: FrameMetadata
  readonly sessionId: number
}

/** Share the active tab's screencast among its viewers. */
export class LiveView {
  readonly #source: () => Promise<CastTarget>
  readonly #options: ViewOptions
  readonly #log: Pick<Context['logger'], 'info' | 'warn'>
  readonly #viewers = new Set<Viewer>()
  readonly #lastFrames = new Map<string, string>()
  #target: CastTarget | undefined
  #syncing: Promise<void> | undefined
  #casting = false
  #onFrame: ((frame: ScreencastFrame) => void) | undefined
  #closedSession: CastCdp | undefined

  /**
   * @param source - resolves the active tab and its CDP session, launching the browser when needed.
   * @param options - frame size and quality.
   * @param log - logger for frame-ack and shutdown failures.
   */
  constructor(source: () => Promise<CastTarget>, options: ViewOptions, log: Pick<Context['logger'], 'info' | 'warn'>) {
    this.#source = source
    this.#options = options
    this.#log = log
  }

  /** Number of connected take-over pages. */
  get size(): number {
    return this.#viewers.size
  }

  /**
   * Add a viewer, start the screencast for the active tab, and paint its last frame.
   * @param viewer - the connection that receives frames and state messages.
   */
  async attach(viewer: Viewer): Promise<void> {
    this.#viewers.add(viewer)
    try {
      await this.#sync()
    } catch (error: unknown) {
      this.#viewers.delete(viewer)
      throw error
    }
    const tabId = this.#target?.tabId
    const last = tabId === undefined ? undefined : this.#lastFrames.get(tabId)
    if (last !== undefined) viewer.send(last)
  }

  /**
   * Remove a viewer and stop the screencast when the last one leaves.
   * @param viewer - the connection that closed.
   */
  async detach(viewer: Viewer): Promise<void> {
    this.#viewers.delete(viewer)
    if (this.#viewers.size > 0) return
    await this.stop()
  }

  /**
   * Follow the active tab now; a no-op while the same tab remains active.
   * Called when the tab strip changes the active tab.
   */
  async refresh(): Promise<void> {
    if (this.#viewers.size === 0) return
    try {
      await this.#sync()
    } catch (error: unknown) {
      this.#log.warn('headless-browser: live view could not follow the active tab: %s', firstLine(error))
    }
  }

  /**
   * Send one control-state message to every viewer.
   * @param message - JSON-serializable payload, such as the tab list and holder.
   */
  broadcast(message: unknown): void {
    this.#send(JSON.stringify(message))
  }

  /** Stop the screencast; the browser, its tabs, and its profile stay open. */
  async stop(): Promise<void> {
    this.#casting = false
    const target = this.#target
    this.#target = undefined
    const handler = this.#onFrame
    this.#onFrame = undefined
    this.#closedSession = undefined
    if (target === undefined) return
    if (handler !== undefined) target.cdp.off('Page.screencastFrame', handler)
    try {
      await target.cdp.send('Page.stopScreencast')
    } catch (error: unknown) {
      // The page may have closed first; a stream that is already gone needs no cleanup.
      this.#log.info('headless-browser: screencast already stopped (%s)', firstLine(error))
    }
  }

  /** Stop the screencast and forget every viewer. */
  async close(): Promise<void> {
    this.#viewers.clear()
    this.#lastFrames.clear()
    await this.stop()
  }

  async #sync(): Promise<void> {
    this.#syncing ??= this.#runSync().finally(() => { this.#syncing = undefined })
    await this.#syncing
  }

  async #runSync(): Promise<void> {
    if (this.#viewers.size === 0) return
    const target = await this.#source()
    if (this.#casting && this.#target?.tabId === target.tabId && this.#target.cdp === target.cdp) return
    await this.stop()
    if (this.#viewers.size === 0) return
    await this.#start(target)
  }

  async #start(target: CastTarget): Promise<void> {
    const onFrame = (frame: ScreencastFrame): void => {
      // The target may have changed between Chrome queueing a frame and this
      // callback; a frame from a tab that is no longer active paints nothing.
      if (this.#target?.tabId !== target.tabId) return
      // Acknowledge before fan-out: Chrome sends the next frame only after this ack.
      void target.cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch((error: unknown) => {
        this.#log.warn('headless-browser: screencast ack failed: %s', firstLine(error))
      })
      const text = encodeFrame(target.tabId, frame.data, frame.metadata)
      this.#lastFrames.set(target.tabId, text)
      this.#send(text)
    }
    this.#target = target
    this.#onFrame = onFrame
    this.#closedSession = target.cdp
    target.cdp.on('Page.screencastFrame', onFrame)
    // A crashed page closes its session once; the cast ends and its last frame
    // would describe a page that no longer exists.
    target.cdp.once('close', () => {
      if (this.#closedSession !== target.cdp) return
      this.#closedSession = undefined
      this.#casting = false
      this.#target = undefined
      this.#onFrame = undefined
      void this.refresh()
    })
    try {
      await target.cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: this.#options.jpegQuality,
        maxWidth: this.#options.maxWidth,
        maxHeight: this.#options.maxHeight,
        everyNthFrame: 1,
      })
    } catch (error: unknown) {
      target.cdp.off('Page.screencastFrame', onFrame)
      this.#target = undefined
      this.#onFrame = undefined
      this.#closedSession = undefined
      throw error
    }
    this.#casting = true
  }

  #send(text: string): void {
    for (const viewer of [...this.#viewers]) viewer.send(text)
  }
}
