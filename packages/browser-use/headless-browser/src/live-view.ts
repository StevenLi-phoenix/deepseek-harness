/**
 * The live view: one screencast for every open take-over page. Chrome streams a
 * frame to one screencast session at a time, so the plugin starts a single
 * screencast on the shared page and fans its frames out; every frame is
 * acknowledged, because Chrome sends the next one only after the ack.
 *
 * @module @deepseek-ai/dsh-headless-browser/live-view
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CDPSession } from 'playwright-core'
import { firstLine } from './error.ts'
import { encodeFrame, type FrameMetadata } from './input.ts'

/** One take-over page connection; `send` ignores a socket that already closed. */
export interface Viewer {
  /** Deliver one text message; a closed viewer must not throw. */
  send(text: string): void
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
interface ScreencastFrame {
  readonly data: string
  readonly metadata: FrameMetadata
  readonly sessionId: number
}

/** Share one page's screencast among its viewers. */
export class LiveView {
  readonly #cdp: () => Promise<CDPSession>
  readonly #options: ViewOptions
  readonly #log: Context['logger']
  readonly #viewers = new Set<Viewer>()
  #session: CDPSession | undefined
  #starting: Promise<void> | undefined
  #casting = false
  #lastFrame: string | undefined
  #watched: CDPSession | undefined

  /**
   * @param cdp - resolves the page's CDP session, launching the browser when needed.
   * @param options - frame size and quality.
   * @param log - logger for frame-ack and shutdown failures.
   */
  constructor(cdp: () => Promise<CDPSession>, options: ViewOptions, log: Context['logger']) {
    this.#cdp = cdp
    this.#options = options
    this.#log = log
  }

  /** Number of connected take-over pages. */
  get size(): number {
    return this.#viewers.size
  }

  /**
   * Add a viewer and start the shared screencast for the first one.
   * @param viewer - the connection that receives frames and state messages.
   */
  async attach(viewer: Viewer): Promise<void> {
    this.#viewers.add(viewer)
    if (this.#casting) {
      // A page that opens later sees the current screen immediately; Chrome
      // sends frames on repaints, so a static page would otherwise stay blank.
      if (this.#lastFrame !== undefined) viewer.send(this.#lastFrame)
      return
    }
    if (this.#starting === undefined) {
      const starting = this.#start().catch((error: unknown) => {
        // A failed start leaves no session behind; the next viewer may try again.
        this.#starting = undefined
        throw error
      })
      this.#starting = starting
    }
    try {
      await this.#starting
    } catch (error: unknown) {
      this.#viewers.delete(viewer)
      throw error
    }
    // The only viewer may have closed while the screencast was starting.
    if (this.#viewers.size === 0) {
      await this.stop()
      return
    }
    if (this.#lastFrame !== undefined) viewer.send(this.#lastFrame)
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
   * Send one control-state message to every viewer.
   * @param message - JSON-serializable payload, such as the current holder.
   */
  broadcast(message: unknown): void {
    this.#send(JSON.stringify(message))
  }

  /** Stop the screencast; the browser, its page, and its profile stay open. */
  async stop(): Promise<void> {
    this.#casting = false
    this.#starting = undefined
    const session = this.#session
    this.#session = undefined
    if (session === undefined) return
    session.off('Page.screencastFrame', this.#onFrame)
    try {
      await session.send('Page.stopScreencast')
    } catch (error: unknown) {
      // The page may have closed first; a stream that is already gone needs no cleanup.
      this.#log.info('headless-browser: screencast already stopped (%s)', firstLine(error))
    }
  }

  /** Stop the screencast and forget every viewer. */
  async close(): Promise<void> {
    this.#viewers.clear()
    await this.stop()
  }

  async #start(): Promise<void> {
    const session = await this.#cdp()
    session.on('Page.screencastFrame', this.#onFrame)
    // A page that crashed or navigated away closes its session once; the cast
    // ends and its last frame would describe a page that no longer exists.
    if (this.#watched !== session) {
      this.#watched = session
      session.once('close', () => {
        this.#watched = undefined
        this.#lastFrame = undefined
        void this.stop()
      })
    }
    // The session is published before the first frame can arrive: acknowledging
    // that frame is what makes Chrome send the next one.
    this.#session = session
    try {
      await session.send('Page.startScreencast', {
        format: 'jpeg',
        quality: this.#options.jpegQuality,
        maxWidth: this.#options.maxWidth,
        maxHeight: this.#options.maxHeight,
        everyNthFrame: 1,
      })
    } catch (error: unknown) {
      session.off('Page.screencastFrame', this.#onFrame)
      this.#session = undefined
      throw error
    }
    this.#casting = true
  }

  readonly #onFrame = (frame: ScreencastFrame): void => {
    const session = this.#session
    if (session === undefined) return
    // Acknowledge before fan-out: Chrome sends the next frame only after this ack.
    void session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch((error: unknown) => {
      this.#log.warn('headless-browser: screencast ack failed: %s', firstLine(error))
    })
    this.#lastFrame = encodeFrame(frame.data, frame.metadata)
    this.#send(this.#lastFrame)
  }

  #send(text: string): void {
    for (const viewer of [...this.#viewers]) viewer.send(text)
  }
}
