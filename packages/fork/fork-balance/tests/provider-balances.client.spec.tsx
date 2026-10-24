// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createBalanceStore, type BalanceState, type ProviderReading } from '../src/client/balance.ts'
import { OPEN_MAX_AGE_MS, ProviderBalances, type ProviderBalancesProps } from '../src/client/ProviderBalances.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh) as ProviderBalancesProps['t']

function mount(state: Partial<BalanceState>) {
  const store = createBalanceStore()
  store.update((draft) => { Object.assign(draft, state) })
  const refresh = vi.fn()
  const view = render(<ProviderBalances useBalance={bindSnapshotSelector(store)} refresh={refresh} t={t} />)
  return { store, refresh, view }
}

const OPENROUTER: ProviderReading = { source: 'openrouter', label: 'OpenRouter', status: 'ready', kind: 'credit', currency: 'USD', remaining: 7.5, limit: 10, used: 2.5 }
const OPENCODE: ProviderReading = { source: 'opencode-go', label: 'OpenCode Go', status: 'ready', kind: 'quota', windows: [
  { name: 'rolling', percent: 10, resetsAt: null },
  { name: 'weekly', percent: 85, resetsAt: new Date(2026, 9, 25, 20, 0).toISOString() },
  { name: 'monthly', percent: 100, resetsAt: new Date(2026, 10, 15, 13, 32).toISOString() },
] }

afterEach(() => { cleanup() })

describe('ProviderBalances', () => {
  it('renders nothing while no provider key is configured, and reads on opening', () => {
    const { view, refresh } = mount({})
    expect(view.container.innerHTML).toBe('')
    expect(refresh).toHaveBeenCalledWith(OPEN_MAX_AGE_MS)
  })

  it('lists each provider with its value, explanation, and quota bars', () => {
    mount({ checkedAt: new Date(2026, 9, 22, 20, 5).getTime(), providers: [OPENROUTER, OPENCODE] })
    const card = screen.getByRole('region', { name: '其他供应商余额' })
    expect(card.textContent).toContain('OpenRouter限额 $10.00 · 已用 $2.50$7.50')
    expect(screen.getByRole('status').textContent).toBe('20:05 更新')
    const meters = screen.getAllByRole('meter')
    expect(meters.map(meter => [meter.getAttribute('aria-label'), meter.getAttribute('aria-valuenow')])).toEqual([['5 小时', '10'], ['每周', '85'], ['每月', '100']])
    expect(meters[1]!.firstElementChild!.className).toMatch(/high/)
    expect(meters[2]!.firstElementChild!.className).toMatch(/full/)
    expect(document.querySelector('[data-balance-source="opencode-go"]')!.textContent).toContain('已用 100%')
    const resets = [...document.querySelectorAll('[data-window-reset]')].map(cell => cell.textContent)
    expect(resets).toEqual(['', '10-25 20:00', '11-15 13:32'])
    expect(meters[2]!.getAttribute('aria-valuetext')).toBe('100%，11-15 13:32 重置，时间已过 23%')
  })

  it('marks how much of each window\'s time has passed on its bar, and warns when the pace runs out before the reset', () => {
    const now = new Date(2026, 10, 25, 13, 32).getTime()
    mount({ checkedAt: now, providers: [{ ...OPENCODE, windows: [
      { name: 'rolling', percent: 0, resetsAt: null },
      { name: 'weekly', percent: 60, resetsAt: new Date(now + 84 * 3_600_000).toISOString() },
      { name: 'monthly', percent: 25, resetsAt: new Date(2026, 11, 15, 13, 32).toISOString() },
    ] }] })
    const meters = screen.getAllByRole('meter')
    // No reset known: no time marker and no pace line.
    expect(meters[0]!.querySelector('[data-window-now]')).toBeNull()
    expect((meters[1]!.querySelector('[data-window-now]') as HTMLElement).style.left).toBe('50%')
    const paces = [...document.querySelectorAll('[data-window-pace]')]
    expect(paces.map(cell => cell.textContent)).toEqual(['', '时间已过 50% · 照这个速度，11-27 21:32 用完', '时间已过 33% · 照这个速度，到期约用 75%'])
    // 60 % used is under the warning line, but the pace runs out before the reset.
    expect(meters[1]!.firstElementChild!.className).toMatch(/high/)
    expect(paces[1]!.className).toMatch(/paceWarn/)
    expect(meters[2]!.firstElementChild!.className).not.toMatch(/high/)
    expect(paces[2]!.className).not.toMatch(/paceWarn/)
    expect(meters[2]!.getAttribute('aria-valuetext')).toBe('25%，12-15 13:32 重置，时间已过 33% · 照这个速度，到期约用 75%')
  })

  it('refreshes on demand and holds the button while a read is in flight', () => {
    const { refresh, view, store } = mount({ checkedAt: 0, providers: [OPENROUTER] })
    refresh.mockClear()
    fireEvent.click(screen.getByRole('button', { name: '刷新其他供应商余额' }))
    expect(refresh).toHaveBeenCalledWith(0)
    store.update((draft) => { draft.refreshing = true })
    view.rerender(<ProviderBalances useBalance={bindSnapshotSelector(store)} refresh={refresh} t={t} />)
    expect(screen.getByRole('button', { name: '刷新其他供应商余额' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('status').textContent).toBe('正在刷新…')
  })
})
