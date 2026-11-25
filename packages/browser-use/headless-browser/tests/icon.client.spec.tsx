// @vitest-environment jsdom

/**
 * The 浏览器接管 row's icon: a browser window with a pointer inside it, drawn
 * at the edge the sidebar asks for and hidden from assistive technology,
 * because the row's label names the page.
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { BrowserTakeoverIcon } from '../src/client/BrowserTakeoverIcon.tsx'

afterEach(() => {
  cleanup()
})

describe('浏览器接管 sidebar icon', () => {
  it('draws at the size the sidebar asks for, in the row\'s text color, outside the accessibility tree', () => {
    // The icon reads only the sidebar's size; the slot's shared hooks are not part of what it draws.
    const props = (size: number, active: boolean): PropsRuntime<'sidebar.panellist'> => ({ size, active }) as PropsRuntime<'sidebar.panellist'>
    const view = render(<BrowserTakeoverIcon {...props(16, false)} />)
    const icon = view.container.querySelector('svg')!
    expect([icon.getAttribute('width'), icon.getAttribute('height')]).toEqual(['16', '16'])
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(icon.querySelectorAll('[stroke="currentColor"]')).toHaveLength(3)
    view.rerender(<BrowserTakeoverIcon {...props(20, true)} />)
    expect([icon.getAttribute('width'), icon.getAttribute('height')]).toEqual(['20', '20'])
  })
})
