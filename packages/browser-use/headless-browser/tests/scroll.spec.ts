/**
 * Scrolling over a scripted page: the wheel point, the distance, both edges,
 * pages shorter than the viewport, and a page that refuses to move. The model
 * keeps no page script, so this suite pins the position and page-height
 * arithmetic that stands in for `window.scrollY`; the CDP adapter itself is
 * exercised by `browser.spec.ts` against real Chromium.
 */

import { describe, expect, it } from 'vitest'
import { scrollPage, type ScrollChannel, type ScrollPosition, type ScrollViewportSize } from '../src/scroll.ts'

const SIZE: ScrollViewportSize = { width: 800, height: 600 }

/** A page whose scroll offset follows each wheel step, clamped to its edges. */
class FakeScrollPage implements ScrollChannel {
  scrollX = 0
  scrollY = 0
  pageHeight = 3_000
  viewportHeight = 600
  readonly wheels: Array<{ x: number; y: number; deltaY: number }> = []
  /** Set false to model an element that keeps the wheel to itself. */
  movable = true

  async position(): Promise<ScrollPosition> {
    return {
      scrollX: this.scrollX,
      scrollY: this.scrollY,
      pageHeight: this.pageHeight,
      viewportHeight: this.viewportHeight,
    }
  }

  async wheel(x: number, y: number, deltaY: number): Promise<void> {
    this.wheels.push({ x, y, deltaY })
    if (!this.movable) return
    const maxScroll = Math.max(0, this.pageHeight - this.viewportHeight)
    this.scrollY = Math.max(0, Math.min(this.scrollY + deltaY, maxScroll))
  }
}

describe('scrollPage', () => {
  it('scrolls by deltaY at the viewport centre and reports the resulting position', async () => {
    const page = new FakeScrollPage()
    const result = await scrollPage(page, { deltaY: 500 }, SIZE)
    expect(page.wheels).toEqual([{ x: 400, y: 300, deltaY: 500 }])
    expect(result).toEqual({
      x: 400,
      y: 300,
      scrollX: 0,
      scrollY: 500,
      pageHeight: 3_000,
      viewportHeight: 600,
      atTop: false,
      atBottom: false,
    })
  })

  it('scrolls the element under an explicit point, upward, without passing the top', async () => {
    const page = new FakeScrollPage()
    page.scrollY = 300
    const result = await scrollPage(page, { x: 30, y: 40, deltaY: -500 }, SIZE)
    expect(page.wheels).toEqual([{ x: 30, y: 40, deltaY: -500 }])
    expect(result).toMatchObject({ x: 30, y: 40, scrollY: 0, atTop: true, atBottom: false })
  })

  it('reports the current position without a wheel turn when deltaY is zero', async () => {
    const page = new FakeScrollPage()
    page.scrollY = 120
    const result = await scrollPage(page, { deltaY: 0 }, SIZE)
    expect(page.wheels).toEqual([])
    expect(result).toMatchObject({ scrollY: 120, atTop: false, atBottom: false })
  })

  it('reaches the bottom edge in wheel steps and says it is at the end', async () => {
    const page = new FakeScrollPage()
    const result = await scrollPage(page, { to: 'bottom' }, SIZE)
    expect(page.wheels.length).toBeGreaterThan(0)
    expect(page.wheels.reduce((sum, wheel) => sum + wheel.deltaY, 0)).toBe(2_400)
    expect(result).toMatchObject({ scrollY: 2_400, atBottom: true, atTop: false })
    expect(result.scrollY + result.viewportHeight).toBe(result.pageHeight)
  })

  it('reaches the top edge from the bottom', async () => {
    const page = new FakeScrollPage()
    page.scrollY = 2_400
    const result = await scrollPage(page, { to: 'top' }, SIZE)
    expect(page.wheels.length).toBeGreaterThan(0)
    expect(page.wheels.every(wheel => wheel.deltaY < 0)).toBe(true)
    expect(result).toMatchObject({ scrollY: 0, atTop: true, atBottom: false })
  })

  it('sends no wheel turn when the page is already at the requested edge', async () => {
    const page = new FakeScrollPage()
    expect(await scrollPage(page, { to: 'top' }, SIZE)).toMatchObject({ scrollY: 0, atTop: true })
    page.scrollY = 2_400
    expect(await scrollPage(page, { to: 'bottom' }, SIZE)).toMatchObject({ scrollY: 2_400, atBottom: true })
    expect(page.wheels).toEqual([])
  })

  it('treats a page shorter than the viewport as both edges at once', async () => {
    const page = new FakeScrollPage()
    page.pageHeight = 400
    const scrolled = await scrollPage(page, { deltaY: 300 }, SIZE)
    expect(scrolled).toMatchObject({ scrollY: 0, pageHeight: 400, atTop: true, atBottom: true })
    const bottom = await scrollPage(page, { to: 'bottom' }, SIZE)
    expect(bottom).toMatchObject({ scrollY: 0, atBottom: true })
  })

  it('retries one dropped wheel, then stops when the element keeps the scroll to itself', async () => {
    const page = new FakeScrollPage()
    page.movable = false
    const result = await scrollPage(page, { to: 'bottom' }, SIZE)
    expect(page.wheels).toHaveLength(2)
    expect(result).toMatchObject({ scrollY: 0, atBottom: false })
  })

  it('reports the position reached when a scroll never settles', async () => {
    let reads = 0
    const page: ScrollChannel = {
      async position() {
        reads += 1
        return { scrollX: 0, scrollY: reads, pageHeight: 3_000, viewportHeight: 600 }
      },
      async wheel() {},
    }
    const result = await scrollPage(page, { deltaY: 100 }, SIZE)
    expect(result.scrollY).toBeGreaterThan(1)
    expect(result.atBottom).toBe(false)
  }, 10_000)
})
