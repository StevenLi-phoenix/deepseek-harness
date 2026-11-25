// @vitest-environment jsdom

/**
 * The 浏览器接管 row's icon: a browser window with a pointer inside it, drawn
 * at the edge the sidebar asks for and hidden from assistive technology,
 * because the row's label names the page.
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserTakeoverIcon } from '../src/client/BrowserTakeoverIcon.tsx'

afterEach(() => {
  cleanup()
})

describe('浏览器接管 sidebar icon', () => {
  it('draws at the size the sidebar asks for, in the row\'s text color, outside the accessibility tree', () => {
    const view = render(<BrowserTakeoverIcon size={16} active={false} />)
    const icon = view.container.querySelector('svg')!
    expect([icon.getAttribute('width'), icon.getAttribute('height')]).toEqual(['16', '16'])
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(icon.querySelectorAll('[stroke="currentColor"]')).toHaveLength(3)
    view.rerender(<BrowserTakeoverIcon size={20} active />)
    expect([icon.getAttribute('width'), icon.getAttribute('height')]).toEqual(['20', '20'])
  })
})
