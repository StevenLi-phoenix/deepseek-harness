// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createBalanceStore, type BalanceState } from '../src/client/balance.ts'
import { BalancePill, POLL_MS, WAKE_MS, type BalancePillProps } from '../src/client/BalancePill.tsx'
import { en, zh } from '../src/client/locales.ts'

const t = makeTranslate(zh) as BalancePillProps['t']
const tEn = makeTranslate(en) as BalancePillProps['t']

function mount(state: Partial<BalanceState>, translate = t) {
  const store = createBalanceStore()
  store.update((draft) => { Object.assign(draft, state) })
  const refresh = vi.fn()
  const view = render(<BalancePill useBalance={bindSnapshotSelector(store)} refresh={refresh} t={translate} />)
  return { store, refresh, view }
}

const cny = (total: string, toppedUp = total, granted = '0') => ({ currency: 'CNY' as const, total, toppedUp, granted })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 22, 17, 30))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('BalancePill', () => {
  it('renders nothing before the first answer and while signed out', () => {
    expect(mount({}).view.container.innerHTML).toBe('')
    cleanup()
    expect(mount({ phase: 'signed-out' }).view.container.innerHTML).toBe('')
  })

  it('shows each currency total and refreshes on click', () => {
    const { refresh } = mount({
      phase: 'ready', wallets: [cny('12.345', '10', '2.345'), { currency: 'USD', total: '1', toppedUp: '1', granted: '0' }],
      updatedAt: Date.now(), checkedAt: Date.now(),
    })
    const button = screen.getByRole('button', { name: 'DeepSeek 账号余额 ¥12.34 / $1.00，点击刷新' })
    expect(button.textContent).toBe('¥12.34·$1.00')
    expect(button.className).not.toMatch(/exhausted|stale/)
    refresh.mockClear()
    fireEvent.click(button)
    expect(refresh).toHaveBeenCalledWith(0)
  })

  it('explains the reading in its tooltip', () => {
    mount({ phase: 'ready', wallets: [cny('12.34', '10', '2.34')], updatedAt: Date.now(), checkedAt: Date.now() })
    fireEvent.mouseEnter(screen.getByRole('button'))
    act(() => { vi.advanceTimersByTime(0) })
    expect(document.body.textContent).toContain('充值 ¥10.00 · 赠金 ¥2.34')
    expect(document.body.textContent).toContain('17:30 更新 · 点击刷新')
  })

  it('tints an exhausted balance and shows ¥0.00 for an account without wallets', () => {
    mount({ phase: 'ready', wallets: [], updatedAt: Date.now(), checkedAt: Date.now() })
    const button = screen.getByRole('button')
    expect(button.textContent).toBe('¥0.00')
    expect(button.className).toMatch(/exhausted/)
  })

  it('dims a stale reading and says when it was taken', () => {
    const taken = Date.now() - 600_000
    mount({ phase: 'failed', wallets: [cny('5')], updatedAt: taken, checkedAt: Date.now() }, tEn)
    const button = screen.getByRole('button')
    expect(button.className).toMatch(/stale/)
    fireEvent.mouseEnter(button)
    act(() => { vi.advanceTimersByTime(0) })
    expect(document.body.textContent).toContain('Refresh failed; balance as of 17:20 · click to retry')
  })

  it('shows a placeholder when no balance was ever read', () => {
    mount({ phase: 'failed', wallets: [], updatedAt: null, checkedAt: Date.now() })
    expect(screen.getByRole('button', { name: '余额 —' }).textContent).toBe('余额 —')
  })

  it('marks a refresh in flight', () => {
    mount({ phase: 'ready', wallets: [cny('1')], updatedAt: Date.now(), checkedAt: Date.now(), refreshing: true })
    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.className).toMatch(/refreshing/)
  })

  it('refreshes on mount, on a timer while visible, and when the window returns', () => {
    const { refresh, view } = mount({ phase: 'ready', wallets: [cny('1')], updatedAt: Date.now(), checkedAt: Date.now() })
    expect(refresh).toHaveBeenCalledWith(POLL_MS)
    refresh.mockClear()
    act(() => { vi.advanceTimersByTime(POLL_MS) })
    expect(refresh).toHaveBeenCalledWith(POLL_MS)
    refresh.mockClear()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => { vi.advanceTimersByTime(POLL_MS) })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(refresh).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    window.dispatchEvent(new Event('focus'))
    expect(refresh).toHaveBeenCalledWith(WAKE_MS)
    refresh.mockClear()
    view.unmount()
    window.dispatchEvent(new Event('focus'))
    act(() => { vi.advanceTimersByTime(POLL_MS) })
    expect(refresh).not.toHaveBeenCalled()
    visibility.mockRestore()
  })
})
