// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { OverviewView } from '../src/views.ts'
import { EDGES, NODES } from '../src/client/flow-graph.ts'
import { FlowSection, type FlowProps } from '../src/client/Flow.tsx'
import { zh } from '../src/client/locales.ts'
import { createResourceStore, type ResourceState } from '../src/client/resource.ts'

const t = makeTranslate(zh) as FlowProps['t']
const CHECKED = new Date(2026, 10, 2, 9, 30, 15).getTime()

const VIEW: OverviewView = {
  checkedAt: CHECKED,
  cards: [
    { id: 'dsh', tone: 'ok', state: 'up', facts: { version: '0.2.2', sha: '0a1b2c3d4e', uptime: 3600 } },
    { id: 'bus', tone: 'warn', state: 'limited', facts: { subscriptions: 3, paused: 0, pending: 1, events: 9, batches: 4, limited: 2 } },
    { id: 'bili', tone: 'down', state: 'down', facts: { plugin: true } },
    { id: 'qq', tone: 'off', state: 'absent', facts: {} },
  ],
}

function mount(overview: Partial<ResourceState<OverviewView>>, registered: string[] = []) {
  const overviewStore = createResourceStore<OverviewView>()
  overviewStore.update((draft) => { Object.assign(draft, overview) })
  const refresh = vi.fn()
  const select = vi.fn()
  const props = {
    close: () => {}, select, useOverview: bindSnapshotSelector(overviewStore),
    refresh, canManage: (section: string) => registered.includes(section), t,
  } as FlowProps
  const view = render(<FlowSection {...props} />)
  return { refresh, select, view }
}

const node = (id: string): Element => document.querySelector(`[data-node="${id}"]`)!
const edge = (key: string): Element => document.querySelector(`[data-edge="${key}"]`)!

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('FlowSection', () => {
  it('reads on opening and every 10 s while open, and stops when closed', () => {
    vi.useFakeTimers()
    const { refresh, view } = mount({})
    expect(refresh).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(refresh).toHaveBeenCalledTimes(2)
    view.unmount()
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('draws every node and arrow before any reading arrives, with the loading line', () => {
    mount({})
    expect(screen.getByRole('status').textContent).toBe('正在读取…')
    expect(document.querySelectorAll('[data-node]')).toHaveLength(NODES.length)
    expect(document.querySelectorAll('[data-edge]')).toHaveLength(EDGES.length)
    expect(node('notifySession').getAttribute('data-tone')).toBe('off')
  })

  it('takes each node\'s tone from its service card, and leaves a node with no probe plain', () => {
    mount({ data: VIEW, checkedAt: 1 })
    expect(screen.getByRole('status').textContent).toBe('09:30:15 更新')
    expect(node('notifySession').getAttribute('data-tone')).toBe('warn')
    expect(node('bili').getAttribute('data-tone')).toBe('down')
    expect(node('gate').getAttribute('data-tone')).toBe('down')
    expect(node('main').getAttribute('data-tone')).toBe('ok')
    expect(node('qq').getAttribute('data-tone')).toBe('off')
    expect(node('github').getAttribute('data-tone')).toBe('none')
    expect(node('repairQ').getAttribute('data-tone')).toBe('none')
  })

  it('draws a question as a hexagon and writes each answer on its arrow', () => {
    mount({})
    expect(node('repairQ').querySelector('polygon')).not.toBeNull()
    expect(node('main').querySelector('polygon')).toBeNull()
    const labels = [...document.querySelectorAll('[data-label]')]
    expect(labels).toHaveLength(EDGES.filter(edge => edge.branch !== undefined).length)
    expect(document.querySelector('[data-label="repairQ>repair"]')?.textContent).toBe('是')
    expect(document.querySelector('[data-label="repairQ>notifySession"]')?.textContent).toBe('否')
    expect(document.querySelector('[data-label="autocutQ>autocut"]')?.textContent).toBe('是')
  })

  it('breaks a long title over two lines at a space and keeps the whole name for assistive tech', () => {
    mount({})
    const lines = [...node('githubSessions').querySelectorAll('text')].map(text => text.textContent)
    expect(lines).toEqual(['Github Sessions', 'Group By repo'])
    expect(node('githubSessions').getAttribute('aria-label')).toBe('Github Sessions Group By repo')
  })

  it('lights up the paths through a node when it is chosen and clears them when it is chosen again', () => {
    mount({ data: VIEW, checkedAt: 1 })
    fireEvent.click(node('repairQ'))
    expect(node('repairQ').getAttribute('aria-pressed')).toBe('true')
    expect(node('github').getAttribute('data-dim')).toBeNull()
    expect(node('wechatOut').getAttribute('data-dim')).toBeNull()
    expect(node('wechatIn').getAttribute('data-dim')).toBe('')
    expect(edge('github>githubSessions').getAttribute('data-dim')).toBeNull()
    expect(edge('wechatIn>main').getAttribute('data-dim')).toBe('')
    expect(document.querySelector('[data-label="repairQ>repair"]')?.getAttribute('data-dim')).toBeNull()
    fireEvent.click(node('wechatIn'))
    expect(document.querySelector('[data-label="repairQ>repair"]')?.getAttribute('data-dim')).toBe('')
    fireEvent.click(node('wechatIn'))
    expect(node('github').getAttribute('data-dim')).toBeNull()
    expect(edge('wechatIn>main').getAttribute('data-dim')).toBeNull()
  })

  it('works from the keyboard: Enter chooses, Escape clears', () => {
    mount({ data: VIEW, checkedAt: 1 })
    fireEvent.keyDown(node('main'), { key: 'Enter' })
    expect(node('main').getAttribute('aria-pressed')).toBe('true')
    fireEvent.keyDown(node('main'), { key: 'Escape' })
    expect(node('main').getAttribute('aria-pressed')).toBe('false')
  })

  it('describes the chosen node: its state, what feeds it and where it goes, and offers Manage where the section exists', () => {
    const { select } = mount({ data: VIEW, checkedAt: 1 }, ['lsy-subscriptions'])
    expect(screen.getByTestId('flow-detail').textContent).toContain('点一个节点')
    fireEvent.click(node('notifySession'))
    const detail = screen.getByTestId('flow-detail')
    expect(detail.textContent).toContain('通知消息 session')
    expect(detail.textContent).toContain('被限流')
    expect(detail.textContent).toContain('来自：勿扰信号、主机事件、自动修复、自动修复、autocut')
    expect(detail.textContent).toContain('去向：微信主智能体')
    fireEvent.click(within(detail).getByRole('button', { name: '管理' }))
    expect(select).toHaveBeenCalledWith('lsy-subscriptions')
  })

  it('describes a node the dictionary knows with its job, and one it does not with its title alone', () => {
    mount({ data: VIEW, checkedAt: 1 })
    fireEvent.click(node('main'))
    expect(screen.getByTestId('flow-detail').textContent).toContain('唯一的聊天会话')
    fireEvent.click(node('repairQ'))
    expect(screen.getByTestId('flow-detail').textContent).toContain('自动修复')
    expect(screen.getByTestId('flow-detail').textContent).not.toContain('唯一的聊天会话')
  })

  it('offers no Manage button for a node whose section is not registered', () => {
    mount({ data: VIEW, checkedAt: 1 }, [])
    fireEvent.click(node('notifySession'))
    expect(within(screen.getByTestId('flow-detail')).queryByRole('button')).toBeNull()
  })

  it('keeps the last picture with a quiet stale line', () => {
    mount({ data: VIEW, checkedAt: 2, stale: true })
    expect(screen.getByRole('status').textContent).toBe('未能刷新 · 显示 09:30:15 的数据')
    expect(node('notifySession').getAttribute('data-tone')).toBe('warn')
  })
})
