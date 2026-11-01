// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SubscriptionAction, SubscriptionsView } from '../src/views.ts'
import { zh } from '../src/client/locales.ts'
import { createResourceStore, type ResourceState } from '../src/client/resource.ts'
import { SubscriptionsSection, type SubscriptionsProps } from '../src/client/Subscriptions.tsx'

const t = makeTranslate(zh) as SubscriptionsProps['t']
const NOW = new Date(2026, 10, 1, 12, 0, 0).getTime()

const VIEW: SubscriptionsView = {
  checkedAt: NOW,
  defaults: { coalesceSeconds: 60, notifyMaxPerHour: 12, sessionMaxPerHour: 4, agentPreset: 'unattended', workspacePath: '/Users/dsh-runtime/work' },
  subscriptions: [
    {
      id: 'kaorou', origin: 'config', mode: 'session', sources: ['kaorou'], kinds: ['kaorou.*'], subjects: [], paused: false,
      createdBy: null, createdAt: null, lastFiredAt: NOW - 3_600_000, fireCount: 4, pending: 0, lastStatus: 'completed',
    },
    {
      id: 'octo-tags', origin: 'agent', mode: 'notify', sources: [], kinds: ['github.tag'], subjects: ['octo/repo'], paused: false,
      createdBy: 'session-0123456789abcdef', createdAt: NOW - 86_400_000, lastFiredAt: null, fireCount: 0, pending: 2, lastStatus: null,
    },
    {
      id: 'mine', origin: 'agent', mode: 'notify', sources: ['github'], kinds: [], subjects: [], paused: true,
      createdBy: 'settings', createdAt: NOW - 1000, lastFiredAt: NOW - 60_000, fireCount: 1, pending: 0, lastStatus: 'failed',
    },
  ],
  schedules: [
    { id: 'abc', title: 'Check backups', rule: 'every', detail: '1800 s', status: 'active', nextAt: NOW + 600_000, lastFiredAt: NOW - 1_200_000 },
    { id: 'def', title: 'Morning', rule: 'daily', detail: '09:00:00 Asia/Shanghai', status: 'paused', nextAt: NOW + 3_600_000, lastFiredAt: null },
    { id: 'ghi', title: 'Once', rule: 'at', detail: '', status: 'ended', nextAt: NOW - 1000, lastFiredAt: NOW - 1000 },
  ],
}

function mount(
  state: Partial<ResourceState<SubscriptionsView>> = { data: VIEW, checkedAt: NOW },
  act_: (request: SubscriptionAction) => Promise<boolean> = () => Promise.resolve(true),
) {
  const store = createResourceStore<SubscriptionsView>()
  store.update((draft) => { Object.assign(draft, state) })
  const refresh = vi.fn()
  const actSpy = vi.fn(act_)
  const dismiss = vi.fn()
  const props = { close: () => {}, useSubscriptions: bindSnapshotSelector(store), refresh, act: actSpy, dismiss, t } as SubscriptionsProps
  const view = render(<SubscriptionsSection {...props} />)
  return { store, refresh, act: actSpy, dismiss, view }
}

const field = (label: string): HTMLInputElement => screen.getByLabelText<HTMLInputElement>(label)
const row = (id: string): HTMLElement => document.querySelector(`[data-subscription="${id}"]`)!
const schedule = (id: string): HTMLElement => document.querySelector(`[data-schedule="${id}"]`)!

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('SubscriptionsSection lists', () => {
  it('polls while open', () => {
    vi.useFakeTimers()
    const { refresh, view } = mount({})
    expect(refresh).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(refresh).toHaveBeenCalledTimes(2)
    view.unmount()
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('shows each subscription\'s source, filter, mode, creator, last fired, and fire count, and marks configuration rows read-only', () => {
    mount()
    const config = row('kaorou')
    expect(config.textContent).toContain('会话')
    expect(config.textContent).toContain('来自配置')
    expect(config.textContent).toContain('来源 kaorou · 类型 kaorou.* · 对象 全部')
    expect(config.textContent).toContain('触发 4 次 · 上次 1 小时前')
    expect(within(config).queryByRole('button')).toBeNull()

    const mineByAgent = row('octo-tags')
    expect(mineByAgent.textContent).toContain('由会话 session-0123 创建')
    expect(mineByAgent.textContent).toContain('来源 全部 · 类型 github.tag · 对象 octo/repo')
    expect(mineByAgent.textContent).toContain('触发 0 次 · 尚未触发 · 排队 2')

    const paused = row('mine')
    expect(paused.textContent).toContain('创建于设置页')
    expect(paused.textContent).toContain('已暂停')
    expect(paused.textContent).toContain('上一批投递失败')
    expect(within(paused).getByRole('button', { name: '恢复' })).toBeTruthy()
  })

  it('lists reminders with their rule, status, next time, and last time', () => {
    mount()
    expect(schedule('abc').textContent).toContain('Check backups')
    expect(schedule('abc').textContent).toContain('每隔 1800 s')
    expect(schedule('abc').textContent).toContain('进行中')
    expect(schedule('abc').textContent).toContain('下次 10 分钟后')
    expect(schedule('abc').textContent).toContain('上次 20 分钟前')
    expect(within(schedule('def')).getByRole('button', { name: '恢复' })).toBeTruthy()
    expect(schedule('ghi').textContent).toContain('已结束')
    expect(within(schedule('ghi')).queryByRole('button', { name: '暂停' })).toBeNull()
    expect(within(schedule('ghi')).queryByRole('button', { name: '恢复' })).toBeNull()
  })

  it('explains missing services and empty lists, and where monitors live', () => {
    mount({ data: { ...VIEW, subscriptions: null, schedules: null }, checkedAt: NOW })
    expect(screen.getByText('事件总线没有加载。')).toBeTruthy()
    expect(screen.getByText('定时服务没有加载。')).toBeTruthy()
    expect(screen.getByText(/它们属于各个对话自己/u)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '新建订阅' })).toBeNull()
    cleanup()
    mount({ data: { ...VIEW, subscriptions: [], schedules: [] }, checkedAt: NOW })
    expect(screen.getByText('还没有订阅。')).toBeTruthy()
    expect(screen.getByText('没有定时提醒。')).toBeTruthy()
  })

  it('keeps the last reading with a quiet stale line', () => {
    const { view } = mount({ data: VIEW, checkedAt: NOW, stale: true })
    expect(screen.getByRole('status').textContent).toBe('未能刷新 · 显示 12:00:00 的数据')
    expect(view.container.querySelector('[data-stale]')).not.toBeNull()
  })
})

describe('SubscriptionsSection actions', () => {
  it('pauses and resumes with one click', () => {
    const { act: send } = mount()
    fireEvent.click(within(row('octo-tags')).getByRole('button', { name: '暂停' }))
    expect(send).toHaveBeenLastCalledWith({ action: 'pause', target: 'subscription', id: 'octo-tags' })
    fireEvent.click(within(row('mine')).getByRole('button', { name: '恢复' }))
    expect(send).toHaveBeenLastCalledWith({ action: 'resume', target: 'subscription', id: 'mine' })
    fireEvent.click(within(schedule('abc')).getByRole('button', { name: '暂停' }))
    expect(send).toHaveBeenLastCalledWith({ action: 'pause', target: 'schedule', id: 'abc' })
  })

  it('asks before deleting, and cancel sends nothing', () => {
    const { act: send } = mount()
    fireEvent.click(within(row('octo-tags')).getByRole('button', { name: '删除' }))
    expect(send).not.toHaveBeenCalled()
    expect(within(row('octo-tags')).getByRole('alertdialog').textContent).toContain('删除“octo-tags”？待处理的事件会一并丢弃。')
    fireEvent.click(within(row('octo-tags')).getByRole('button', { name: '取消' }))
    expect(send).not.toHaveBeenCalled()
    fireEvent.click(within(row('octo-tags')).getByRole('button', { name: '删除' }))
    fireEvent.click(within(row('octo-tags')).getByRole('button', { name: '确认删除' }))
    expect(send).toHaveBeenCalledWith({ action: 'delete', target: 'subscription', id: 'octo-tags' })
    fireEvent.click(within(schedule('def')).getByRole('button', { name: '删除' }))
    fireEvent.click(within(schedule('def')).getByRole('button', { name: '确认删除' }))
    expect(send).toHaveBeenLastCalledWith({ action: 'delete', target: 'schedule', id: 'def' })
  })

  it('dims a row while its action is in flight and disables its buttons', () => {
    mount({ data: VIEW, checkedAt: NOW, busy: { 'pause:subscription:octo-tags': true } })
    expect(row('octo-tags').hasAttribute('data-busy')).toBe(true)
    expect(within(row('octo-tags')).getByRole<HTMLButtonElement>('button', { name: '暂停' }).disabled).toBe(true)
    expect(row('mine').hasAttribute('data-busy')).toBe(false)
  })

  it('shows a refusal with its reason and lets the owner dismiss it', () => {
    const { dismiss } = mount({ data: VIEW, checkedAt: NOW, notice: { kind: 'error', code: 'config_owned', detail: undefined } })
    expect(screen.getByRole('alert').textContent).toContain('它来自配置，只能在部署配置里改。')
    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    expect(dismiss).toHaveBeenCalled()
  })
})

describe('create form', () => {
  const open = () => fireEvent.click(screen.getByRole('button', { name: '新建订阅' }))
  const type = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

  it('checks the fields before sending and names what is wrong', () => {
    const { act: send } = mount()
    open()
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    expect(send).not.toHaveBeenCalled()
    expect(screen.getAllByRole('alert').map(alert => alert.textContent)).toEqual([
      '名称要用小写字母、数字或连字符，最长 63 个字符。',
      '来源、类型、对象至少填一个，否则会匹配所有事件。',
    ])
  })

  it('sends a notify subscription and closes the form once the Host accepts it', async () => {
    const { act: send } = mount()
    open()
    type(/名称/u, 'octo-releases')
    type(/类型，如/u, 'github.release')
    type(/对象，如/u, 'octo/repo')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '创建' })) })
    expect(send).toHaveBeenCalledWith({
      action: 'create', subscription: { id: 'octo-releases', sources: [], kinds: ['github.release'], subjects: ['octo/repo'], mode: 'notify' },
    })
    expect(screen.queryByRole('button', { name: '创建' })).toBeNull()
  })

  it('needs instructions for a session subscription, tells which preset and workspace it runs in, and keeps the form open on a refusal', async () => {
    const { act: send } = mount(undefined, () => Promise.resolve(false))
    open()
    type(/名称/u, 'triage')
    type(/来源（/u, 'kaorou')
    fireEvent.change(screen.getByLabelText('命中后'), { target: { value: 'session' } })
    expect(screen.getByText('会话以“unattended”预设在 /Users/dsh-runtime/work 里运行。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    expect(screen.getByRole('alert').textContent).toBe('会话模式需要任务说明（最多 4000 字）。')
    type(/任务说明/u, 'Summarize the failure.')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '创建' })) })
    expect(send).toHaveBeenCalledWith({
      action: 'create', subscription: { id: 'triage', sources: ['kaorou'], kinds: [], subjects: [], mode: 'session', instructions: 'Summarize the failure.' },
    })
    expect(screen.getByRole('button', { name: '创建' })).toBeTruthy()
  })

  it('shows the defaults as placeholders and closes on cancel', () => {
    mount()
    open()
    expect(field('合并窗口（秒）').placeholder).toBe('60')
    expect(field('每小时最多批数').placeholder).toBe('12')
    fireEvent.change(screen.getByLabelText('命中后'), { target: { value: 'session' } })
    expect(field('每小时最多批数').placeholder).toBe('4')
    fireEvent.click(screen.getAllByRole('button', { name: '取消' })[0]!)
    expect(screen.queryByLabelText('合并窗口（秒）')).toBeNull()
  })
})
