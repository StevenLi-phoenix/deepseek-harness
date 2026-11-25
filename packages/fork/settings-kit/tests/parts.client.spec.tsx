// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Card, PendingSection, startPolling, StatusHeader } from '../src/client.ts'

afterEach(cleanup)

describe('startPolling in a browser', () => {
  it('watches the document by default', () => {
    const refresh = vi.fn()
    const added = vi.spyOn(document, 'addEventListener')
    const removed = vi.spyOn(document, 'removeEventListener')
    const stop = startPolling(refresh, 60_000)
    expect(added).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    expect(refresh).toHaveBeenCalledTimes(document.visibilityState === 'hidden' ? 0 : 1)
    stop()
    expect(removed).toHaveBeenCalledWith('visibilitychange', added.mock.calls[0]?.[1])
    vi.restoreAllMocks()
  })
})

const css = {
  header: 'h', status: 's', dot: 'd', card: 'c', cardHeader: 'ch', cardTitle: 'ct', meta: 'm', section: 'sec', wide: 'w',
}

describe('StatusHeader', () => {
  it('shows the dot in the line\'s tone, the text, and what follows it, with the section\'s classes', () => {
    const { container } = render(<StatusHeader css={css} line={{ tone: 'stale', text: 'stale since 10:00' }}><span>uptime</span></StatusHeader>)
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('stale since 10:00')
    expect(status.className).toBe('s')
    expect(container.querySelector('.d')?.getAttribute('data-tone')).toBe('stale')
    expect(container.querySelector('.h')?.textContent).toBe('stale since 10:00uptime')
  })
})

describe('Card', () => {
  it('is labelled by its title and shows the note beside it', () => {
    render(<Card css={css} title="CPU" meta="8 cores"><span>12%</span></Card>)
    const card = screen.getByRole('region', { name: 'CPU' })
    expect(card.className).toBe('c')
    expect(card.textContent).toBe('CPU8 cores12%')
  })

  it('takes classes that replace the card class, and no note when none is given', () => {
    render(<Card css={css} title="Disks" className="c w"><span>ok</span></Card>)
    const card = screen.getByRole('region', { name: 'Disks' })
    expect(card.className).toBe('c w')
    expect(card.querySelector('.m')).toBeNull()
  })
})

describe('PendingSection', () => {
  const t = (key: string): string => key

  it('says it is loading until a read fails, then that it failed, above its children', () => {
    const { rerender } = render(<PendingSection css={css} label="Mail" stale={false} t={t}><span>all settings</span></PendingSection>)
    const section = screen.getByRole('region', { name: 'Mail' })
    expect(section.className).toBe('sec')
    expect(screen.getByRole('status').textContent).toBe('status.loading')
    rerender(<PendingSection css={css} label="Mail" stale t={t} />)
    expect(screen.getByRole('status').textContent).toBe('status.failed')
  })
})
