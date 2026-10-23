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
  { name: 'rolling', percent: 10, resetsAt: null }, { name: 'weekly', percent: 85, resetsAt: null }, { name: 'monthly', percent: 100, resetsAt: null },
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
