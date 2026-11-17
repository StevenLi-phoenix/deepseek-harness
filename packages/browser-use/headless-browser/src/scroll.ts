/**
 * Vertical scrolling over one tab's CDP session. The model moves the page the
 * way a wheel does, or drives it to an edge, and receives the position and page
 * height that say whether the end was reached. Position comes from
 * `Page.getLayoutMetrics` and movement from `Input.dispatchMouseEvent`, so no
 * page script is evaluated and no `javascript:` address is involved.
 *
 * @module @deepseek-ai/dsh-headless-browser/scroll
 */

import { setTimeout as delay } from 'node:timers/promises'
import type { CDPSession } from 'playwright-core'

/** Largest vertical distance one scroll request may name, in CSS pixels. */
export const MAX_SCROLL_DELTA = 100_000
/** Largest wheel step the edge loop sends at once, in CSS pixels. */
const MAX_WHEEL_STEP = 4_000
/** Most wheel steps one request to an edge may take. */
const MAX_EDGE_STEPS = 32
/** Time a wheel event needs to reach the compositor before the first position read, in milliseconds. */
const SETTLE_GRACE_MS = 300
/** Delay between two position reads after the grace period, in milliseconds. */
const SETTLE_INTERVAL_MS = 50
/** Most position reads before a still-moving scroll reports its current position. */
const MAX_SETTLE_READS = 16
/** Delay before one wheel event is retried, in milliseconds. */
const RETRY_DELAY_MS = 80
/** Distance within which a position counts as an edge, in CSS pixels. */
const EDGE_TOLERANCE = 1

/** Viewport size, used to aim the wheel when the request names no point. */
export interface ScrollViewportSize {
  readonly width: number
  readonly height: number
}

/** One vertical scroll request. */
export interface ScrollRequest {
  /** Point whose element receives the wheel; the viewport centre when omitted. */
  readonly x?: number
  readonly y?: number
  /** Pixels to scroll: positive moves down. Exclusive with `to`. */
  readonly deltaY?: number
  /** Edge to reach. Exclusive with `deltaY`. */
  readonly to?: 'top' | 'bottom'
}

/** Where a scroll request left the page. */
export interface ScrollResult {
  /** Horizontal point the wheel was sent to, in CSS pixels. */
  readonly x: number
  /** Vertical point the wheel was sent to, in CSS pixels. */
  readonly y: number
  /** Horizontal scroll offset after the request, in CSS pixels. */
  readonly scrollX: number
  /** Vertical scroll offset after the request, in CSS pixels. */
  readonly scrollY: number
  /** Height of the page's scrollable content, in CSS pixels. */
  readonly pageHeight: number
  /** Height of the viewport, in CSS pixels. */
  readonly viewportHeight: number
  /** Whether the page is at its top edge. */
  readonly atTop: boolean
  /** Whether the page is at its bottom edge. */
  readonly atBottom: boolean
}

/** The page state a scroll reads between wheel steps. */
export interface ScrollPosition {
  readonly scrollX: number
  readonly scrollY: number
  readonly pageHeight: number
  readonly viewportHeight: number
}

/** What one scroll needs from the browser: where the page is, and one wheel turn. */
export interface ScrollChannel {
  /** Read the current scroll offset, page height, and viewport height. */
  position(): Promise<ScrollPosition>
  /** Send one vertical wheel turn at a point, in CSS pixels. */
  wheel(x: number, y: number, deltaY: number): Promise<void>
}

/**
 * Build the scroll channel over a tab's CDP session.
 * @param cdp - the tab's CDP session.
 * @returns the position reader and wheel sender used by {@link scrollPage}.
 */
export function cdpScrollChannel(cdp: CDPSession): ScrollChannel {
  return {
    async position(): Promise<ScrollPosition> {
      const metrics = await cdp.send('Page.getLayoutMetrics')
      return {
        scrollX: metrics.cssVisualViewport.pageX,
        scrollY: metrics.cssVisualViewport.pageY,
        pageHeight: metrics.cssContentSize.height,
        viewportHeight: metrics.cssVisualViewport.clientHeight,
      }
    },
    async wheel(x: number, y: number, deltaY: number): Promise<void> {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX: 0,
        deltaY,
        button: 'none',
        modifiers: 0,
      })
    },
  }
}

/**
 * Scroll one page by a vertical distance or to an edge, then report where the
 * page ended up and whether it can move further in that direction.
 * @param channel - the tab's position reader and wheel sender.
 * @param request - distance or edge, and the point whose element scrolls.
 * @param size - viewport size used as the wheel point when the request omits one.
 * @returns the resolved point, the scroll position, and the page and viewport heights.
 */
export async function scrollPage(
  channel: ScrollChannel,
  request: ScrollRequest,
  size: ScrollViewportSize,
): Promise<ScrollResult> {
  const x = Math.round(request.x ?? size.width / 2)
  const y = Math.round(request.y ?? size.height / 2)
  let position = await channel.position()
  if (request.to !== undefined) {
    position = await scrollToEdge(channel, x, y, request.to, position)
  } else if (request.deltaY !== undefined && request.deltaY !== 0) {
    position = await wheelAndSettle(channel, x, y, request.deltaY, position)
  }
  return {
    x,
    y,
    scrollX: Math.round(position.scrollX),
    scrollY: Math.round(position.scrollY),
    pageHeight: Math.round(position.pageHeight),
    viewportHeight: Math.round(position.viewportHeight),
    atTop: position.scrollY <= EDGE_TOLERANCE,
    atBottom: position.scrollY >= maxScrollOf(position) - EDGE_TOLERANCE,
  }
}

async function scrollToEdge(
  channel: ScrollChannel,
  x: number,
  y: number,
  edge: 'top' | 'bottom',
  start: ScrollPosition,
): Promise<ScrollPosition> {
  let position = start
  for (let step = 0; step < MAX_EDGE_STEPS; step++) {
    if (atEdge(position, edge)) return position
    const remaining = edge === 'top' ? position.scrollY : maxScrollOf(position) - position.scrollY
    const delta = Math.min(Math.ceil(remaining), MAX_WHEEL_STEP) * (edge === 'top' ? -1 : 1)
    const next = await wheelAndSettle(channel, x, y, delta, position)
    // A wheel over a fixed or overscroll-contained element moves nothing; stop
    // instead of sending the same step MAX_EDGE_STEPS times.
    if (samePosition(next, position)) return next
    position = next
  }
  /* v8 ignore next -- a page that never reaches an edge after the step cap keeps its last position. */
  return position
}

/**
 * Turn the wheel once and wait for the page to settle. Chromium sometimes drops
 * a wheel event dispatched immediately after an earlier one, so a turn that
 * moved nothing is retried once before a stuck page is reported as stuck.
 */
async function wheelAndSettle(
  channel: ScrollChannel,
  x: number,
  y: number,
  deltaY: number,
  previous: ScrollPosition,
): Promise<ScrollPosition> {
  await channel.wheel(x, y, deltaY)
  const moved = await settle(channel)
  if (!samePosition(moved, previous)) return moved
  await delay(RETRY_DELAY_MS)
  await channel.wheel(x, y, deltaY)
  return await settle(channel)
}

async function settle(channel: ScrollChannel): Promise<ScrollPosition> {
  // Chromium applies a CDP wheel event about 150 ms later, so the grace period
  // comes before the first read; two equal reads then mark a stopped scroll.
  await delay(SETTLE_GRACE_MS)
  let position = await channel.position()
  for (let read = 0; read < MAX_SETTLE_READS; read++) {
    await delay(SETTLE_INTERVAL_MS)
    const next = await channel.position()
    if (samePosition(next, position)) return next
    position = next
  }
  return position
}

function atEdge(position: ScrollPosition, edge: 'top' | 'bottom'): boolean {
  return edge === 'top'
    ? position.scrollY <= EDGE_TOLERANCE
    : position.scrollY >= maxScrollOf(position) - EDGE_TOLERANCE
}

function maxScrollOf(position: ScrollPosition): number {
  return Math.max(0, position.pageHeight - position.viewportHeight)
}

function samePosition(left: ScrollPosition, right: ScrollPosition): boolean {
  return left.scrollX === right.scrollX && left.scrollY === right.scrollY
}
