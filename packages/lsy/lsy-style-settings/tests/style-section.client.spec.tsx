// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createStyleStore, type StyleState } from '../src/client/style.ts'
import { StyleSection, type StyleSectionProps } from '../src/client/StyleSection.tsx'
import { zh } from '../src/client/locales.ts'
import type { StylePanel } from '../src/view.ts'

const t = makeTranslate(zh) as StyleSectionProps['t']
const NOW = Date.now()

const panel = (over: Partial<StylePanel> = {}): StylePanel => ({
  enabled: true, review: 'optional', limits: { maxActive: 60, maxOwner: 20, maxChars: 60 }, running: false, nextRunAt: NOW + 3_600_000,
  samples: [
    { id: 'o1', source: 'owner-bili', status: 'active', addedAt: 'x', prompt: '下期什么时候', reply: '刚剪完' },
    { id: 'o2', source: 'owner-manual', status: 'active', addedAt: 'x', reply: '会的. 绝对会的' },
    { id: 'q1', source: 'qq-group', status: 'active', addedAt: 'x', prompt: '周末去哪', reply: '宅着' },
    { id: 'b1', source: 'bili-viewer', status: 'active', addedAt: 'x', prompt: '这期好看', reply: '同感' },
  ],
  lastRun: {
    at: NOW - 3_600_000, ms: 120, trigger: 'schedule', seen: 62, accepted: 26, added: 15, retired: 3,
    qq: { status: 'ok', groups: 21, messages: 385 }, bili: { status: 'no-token', comments: 0, threads: 0 },
    filtered: { mention: 13, media: 11 }, bySource: { 'qq-group': 15 },
  },
  trend: [{ day: '2026-10-31', answers: 10, withTics: 4, mainAnswers: 8, meanChars: 46 }],
  ...over,
})

function mount(state: Partial<StyleState>) {
  const store = createStyleStore()
  store.update((draft) => { Object.assign(draft, state) })
  const refresh = vi.fn()
  const edit = vi.fn((_: unknown) => Promise.resolve(true))
  const collect = vi.fn()
  const props = { close: () => {}, useStyle: bindSnapshotSelector(store), refresh, edit, collect, t } as StyleSectionProps
  const view = render(<StyleSection {...props} />)
  return { store, refresh, edit, collect, view }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('StyleSection', () => {
  it('reads on opening and polls while open', () => {
    vi.useFakeTimers()
    const { refresh, view } = mount({})
    expect(screen.getByRole('status').textContent).toBe('正在读取…')
    expect(refresh).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(5000) })
    expect(refresh).toHaveBeenCalledTimes(2)
    view.unmount()
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('shows the verdict, the samples by source, the last run with reasons, and the trend', () => {
    mount({ panel: panel(), checkedAt: NOW })
    expect(screen.getByRole('heading', { name: '4 条真人对话在给主 agent 校准语气' })).toBeTruthy()
    expect(screen.getByText('你自己的话（2）')).toBeTruthy()
    expect(screen.getByText('QQ 群（1）')).toBeTruthy()
    expect(screen.getByText('B站评论区（1）')).toBeTruthy()
    expect(screen.getByText('猫灯')).toBeTruthy()
    expect(screen.getByText(/看了 62 段对话，通过 26，新增 15/u)).toBeTruthy()
    expect(screen.getByText('21 个群，385 条消息')).toBeTruthy()
    expect(screen.getByText('缺少 bili-svc 的读取令牌')).toBeTruthy()
    expect(screen.getByText('@ 了人 13')).toBeTruthy()
    expect(screen.getByText(/4\/10 带套话/u)).toBeTruthy()
    expect(screen.getByText(/平均 46 字/u)).toBeTruthy()
  })

  it('deletes a sample with one tap and starts a run', () => {
    const { edit, collect } = mount({ panel: panel(), checkedAt: NOW })
    fireEvent.click(screen.getByRole('button', { name: '删掉：周末去哪 → 宅着' }))
    expect(edit).toHaveBeenCalledWith({ op: 'remove', id: 'q1' })
    fireEvent.click(screen.getByRole('button', { name: '立即收集' }))
    expect(collect).toHaveBeenCalledTimes(1)
  })

  it('offers keep and delete for pending samples under review required', () => {
    const { edit } = mount({ panel: panel({ review: 'required', samples: [{ id: 'p1', source: 'qq-group', status: 'pending', addedAt: 'x', prompt: '在吗', reply: '在' }] }), checkedAt: NOW })
    expect(screen.getByText('待审核（1）')).toBeTruthy()
    expect(screen.getByText('新片段要你点「留」才生效')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '留下：在吗 → 在' }))
    expect(edit).toHaveBeenCalledWith({ op: 'keep', id: 'p1' })
  })

  it('adds a line of the owner\'s own and clears the fields once the Host took it', async () => {
    const { edit } = mount({ panel: panel(), checkedAt: NOW })
    const reply = screen.getByRole('textbox', { name: '你会怎么回' }) as HTMLInputElement
    expect(screen.getByRole('button', { name: '加入' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(reply, { target: { value: '会的' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '加入' })) })
    expect(edit).toHaveBeenCalledWith({ op: 'add', reply: '会的' })
    expect(reply.value).toBe('')
    expect(reply.maxLength).toBe(60)
  })

  it('says when the block is off, and when an edit failed', () => {
    mount({ panel: panel({ enabled: false }), checkedAt: NOW, error: 'not_found' })
    expect(screen.getByRole('heading', { name: '已关闭：主 agent 看不到这些片段' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('这条已经不在了。')
    expect(screen.getByRole('button', { name: '立即收集' }).hasAttribute('disabled')).toBe(true)
  })
})
