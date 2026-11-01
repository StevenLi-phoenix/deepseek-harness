// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { OverviewView } from '../src/views.ts'
import type { BalanceSummary } from '../src/client/balance.ts'
import { zh } from '../src/client/locales.ts'
import { OverviewSection, type OverviewProps } from '../src/client/Overview.tsx'
import { createResourceStore, type ResourceState } from '../src/client/resource.ts'

const t = makeTranslate(zh) as OverviewProps['t']
const CHECKED = new Date(2026, 10, 1, 9, 30, 15).getTime()

const VIEW: OverviewView = {
  checkedAt: CHECKED,
  cards: [
    { id: 'dsh', tone: 'ok', state: 'up', facts: { version: '0.2.2', sha: '0a1b2c3d4e', uptime: 3600 } },
    { id: 'bus', tone: 'warn', state: 'limited', facts: { subscriptions: 3, paused: 0, pending: 1, events: 9, batches: 4, limited: 2 } },
    { id: 'bili', tone: 'down', state: 'down', facts: { plugin: true } },
    { id: 'qq', tone: 'off', state: 'absent', facts: {} },
    { id: 'cc', tone: 'ok', state: 'up', facts: { sessions: 1, max: 3, login: 'token' } },
  ],
}

function mount(
  overview: Partial<ResourceState<OverviewView>>,
  balance: Partial<ResourceState<BalanceSummary>> = {},
  registered: string[] = [],
) {
  const overviewStore = createResourceStore<OverviewView>()
  overviewStore.update((draft) => { Object.assign(draft, overview) })
  const balanceStore = createResourceStore<BalanceSummary>()
  balanceStore.update((draft) => { Object.assign(draft, balance) })
  const refresh = vi.fn()
  const manage = vi.fn()
  const props = {
    close: () => {}, select: manage, useOverview: bindSnapshotSelector(overviewStore), useBalance: bindSnapshotSelector(balanceStore),
    refresh, canManage: (section: string) => registered.includes(section), t,
  } as OverviewProps
  const view = render(<OverviewSection {...props} />)
  return { refresh, manage, overviewStore, view }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('OverviewSection', () => {
  it('reads on opening and every 10 s while open, and stops when closed', () => {
    vi.useFakeTimers()
    const { refresh, view } = mount({})
    expect(screen.getByRole('status').textContent).toBe('正在读取…')
    expect(refresh).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(refresh).toHaveBeenCalledTimes(2)
    view.unmount()
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('shows one card per service with its tone, status line, and facts, and the model route card from the balance route', () => {
    mount({ data: VIEW, checkedAt: 1 }, { data: { ready: 2, failed: 0, highest: 40.6 }, checkedAt: 1 })
    expect(screen.getByRole('status').textContent).toBe('09:30:15 更新')
    const regions = [...document.querySelectorAll('[data-service]')].map(region => [region.getAttribute('data-service'), region.getAttribute('data-tone')])
    expect(regions).toEqual([['dsh', 'ok'], ['bus', 'warn'], ['bili', 'down'], ['qq', 'off'], ['cc', 'ok'], ['llm', 'ok']])
    const dsh = screen.getByRole('region', { name: '事件服务' })
    expect(dsh.textContent).toContain('运行中')
    expect(dsh.textContent).toContain('版本 0.2.2 · 构建 0a1b2c3d4e · 已运行 60 分钟'.replace('60 分钟', '1 小时 0 分'))
    expect(screen.getByRole('region', { name: 'B站服务' }).textContent).toContain('bili-svc 没有响应')
    expect(screen.getByRole('region', { name: '事件总线' }).textContent).toContain('被限流 2 次')
    expect(screen.getByRole('region', { name: 'QQ 观察器' }).textContent).toContain('未安装')
    expect(screen.getByRole('region', { name: 'Claude Code 桥' }).textContent).toContain('1 / 3 个会话 · 仅推理 token')
    expect(screen.getByRole('region', { name: '模型路由与额度' }).textContent).toContain('最高已用 41%')
  })

  it('offers Manage only where the target section is registered, and switches to it', () => {
    const { manage } = mount({ data: VIEW, checkedAt: 1 }, { data: { ready: 1, failed: 0, highest: null }, checkedAt: 1 }, ['fork-sysmon', 'bili', 'account'])
    const buttons = screen.getAllByRole('button', { name: '管理' })
    expect(buttons).toHaveLength(3)
    expect(within(screen.getByRole('region', { name: '事件总线' })).queryByRole('button')).toBeNull()
    fireEvent.click(within(screen.getByRole('region', { name: 'B站服务' })).getByRole('button', { name: '管理' }))
    expect(manage).toHaveBeenCalledWith('bili')
    fireEvent.click(within(screen.getByRole('region', { name: '模型路由与额度' })).getByRole('button', { name: '管理' }))
    expect(manage).toHaveBeenLastCalledWith('account')
  })

  it('keeps the last reading with a quiet stale line, and says so when the first read fails', () => {
    const { view } = mount({ data: VIEW, checkedAt: 2, stale: true })
    expect(screen.getByRole('status').textContent).toBe('未能刷新 · 显示 09:30:15 的数据')
    expect(view.container.querySelector('[data-stale]')).not.toBeNull()
    cleanup()
    mount({ checkedAt: 1, stale: true })
    expect(screen.getByRole('status').textContent).toBe('暂时读不到，稍后自动重试。')
    expect(document.querySelectorAll('[data-service]')).toHaveLength(0)
  })

  it('shows the model route as red when the balance route itself failed', () => {
    mount({ data: VIEW, checkedAt: 1 }, { stale: true, checkedAt: 1 })
    expect(screen.getByRole('region', { name: '模型路由与额度' }).getAttribute('data-tone')).toBe('down')
  })
})
