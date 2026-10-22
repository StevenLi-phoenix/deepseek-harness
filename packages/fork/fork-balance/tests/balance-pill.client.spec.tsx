// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createBalanceStore, type BalanceState, type ProviderReading } from '../src/client/balance.ts'
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
const OPENROUTER: ProviderReading = { source: 'openrouter', label: 'OpenRouter', status: 'ready', kind: 'credit', currency: 'USD', remaining: 7.5, limit: 10, used: 2.5 }
const OPENCODE: ProviderReading = {
  source: 'opencode-go', label: 'OpenCode Go', status: 'ready', kind: 'quota',
  windows: [{ name: 'fiveHour', percent: 12, resetsAt: null }, { name: 'weekly', percent: 34.4, resetsAt: '2026-10-26T12:00:00' }],
}

/** Text of the tooltip bubble after hovering the pill. */
function hoverText(): string {
  fireEvent.mouseEnter(screen.getByRole('button'))
  act(() => { vi.advanceTimersByTime(0) })
  return document.body.textContent ?? ''
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 22, 17, 30))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('BalancePill', () => {
  it('renders nothing before the first answer and while there is nothing to show', () => {
    expect(mount({}).view.container.innerHTML).toBe('')
    cleanup()
    expect(mount({ phase: 'signed-out' }).view.container.innerHTML).toBe('')
  })

  it('shows one labelled segment per provider and refreshes on click', () => {
    const { refresh } = mount({
      phase: 'ready', wallets: [cny('12.345', '10', '2.345')], updatedAt: Date.now(), checkedAt: Date.now(), providers: [OPENROUTER, OPENCODE],
    })
    const button = screen.getByRole('button', { name: '余额：DeepSeek ¥12.34, OpenRouter $7.50, OpenCode Go 34%。点击刷新' })
    expect(button.textContent).toBe('DeepSeek ¥12.34·OpenRouter $7.50·OpenCode Go 34%')
    refresh.mockClear()
    fireEvent.click(button)
    expect(refresh).toHaveBeenCalledWith(0)
  })

  it('explains each segment in its tooltip', () => {
    mount({ phase: 'ready', wallets: [cny('12.34', '10', '2.34')], updatedAt: Date.now(), checkedAt: Date.now(), providers: [OPENROUTER, OPENCODE] })
    const text = hoverText()
    expect(text).toContain('DeepSeek 账号：充值 ¥10.00 · 赠金 ¥2.34')
    expect(text).toContain('OpenRouter：剩余 $7.50（限额 $10.00，已用 $2.50）')
    expect(text).toContain('OpenCode Go：5 小时 12% · 每周 34%')
    expect(text).toContain('每周额度 10-26 12:00 重置')
    expect(text).toContain('17:30 更新 · 点击刷新')
  })

  it('shows provider keys while the account is signed out', () => {
    mount({ phase: 'signed-out', checkedAt: Date.now(), providers: [OPENROUTER] })
    expect(screen.getByRole('button').textContent).toBe('OpenRouter $7.50')
  })

  it('tints exhausted segments only and dims unreadable ones', () => {
    mount({
      phase: 'ready', wallets: [], updatedAt: Date.now(), checkedAt: Date.now(),
      providers: [{ ...OPENROUTER, remaining: 0 }, { source: 'deepseek', label: 'DeepSeek API', status: 'failed', reason: 'HTTP 401' }],
    })
    const segment = (key: string) => document.querySelector(`[data-balance-source="${key}"]`)!
    expect(segment('account').textContent).toBe('DeepSeek ¥0.00')
    expect(segment('account').className).toMatch(/exhausted/)
    expect(segment('openrouter').className).toMatch(/exhausted/)
    expect(segment('deepseek').textContent).toBe('·DeepSeek API —')
    expect(segment('deepseek').className).toMatch(/stale/)
    expect(hoverText()).toContain('DeepSeek API：读取失败（HTTP 401）')
  })

  it('dims a stale account reading and says when it was taken', () => {
    mount({ phase: 'failed', wallets: [cny('5')], updatedAt: Date.now() - 600_000, checkedAt: Date.now() }, tEn)
    expect(document.querySelector('[data-balance-source="account"]')!.className).toMatch(/stale/)
    expect(hoverText()).toContain('DeepSeek account refresh failed; balance above as of 17:20')
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
