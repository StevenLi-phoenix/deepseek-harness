// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createMemoryStore, type MemoryActions, type MemoryState } from '../src/client/memory.ts'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'
import { isoFromLocal } from '../src/client/RollbackCard.tsx'
import { Card, shortSession, when } from '../src/client/parts.tsx'
import { EntriesCard } from '../src/client/EntriesCard.tsx'
import { FeedbackCard } from '../src/client/FeedbackCard.tsx'
import { PendingCard } from '../src/client/PendingCard.tsx'
import { RollbackCard } from '../src/client/RollbackCard.tsx'
import { MemorySection, type MemoryProps } from '../src/client/MemorySettings.tsx'
import { DETAIL, GUARD, VIEW } from './fixtures.client.ts'

const t = makeTranslate(zh) as MemoryProps['t']

/** Every action as a spy that settles at once. */
function spies(): { [K in keyof MemoryActions]: Mock<MemoryActions[K]> } {
  return {
    refresh: vi.fn(() => Promise.resolve()),
    setQuery: vi.fn(() => Promise.resolve()),
    review: vi.fn(() => Promise.resolve()),
    loadDetail: vi.fn(() => Promise.resolve()),
    rollbackPreview: vi.fn(() => Promise.resolve()),
    rollbackApply: vi.fn(() => Promise.resolve()),
    rollbackCancel: vi.fn(),
    purgePreview: vi.fn(() => Promise.resolve()),
    purgeApply: vi.fn(() => Promise.resolve()),
    purgeCancel: vi.fn(),
    feedbackAdd: vi.fn(() => Promise.resolve(true)),
    feedbackForget: vi.fn(() => Promise.resolve()),
    dismissError: vi.fn(),
  }
}

function mount(state: Partial<MemoryState> = {}) {
  const store = createMemoryStore()
  store.update((draft) => { Object.assign(draft, { view: VIEW, checkedAt: Date.now() }, state) })
  const actions = spies()
  const props = { close: () => {}, useMemory: bindSnapshotSelector(store), actions, t } as MemoryProps
  const view = render(<MemorySection {...props} />)
  return { store, actions, view }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('MemorySection waiting writes', () => {
  it('opens on the waiting writes, marks one that a stranger started, and shows its Session', () => {
    const { actions } = mount()
    expect(actions.refresh).toHaveBeenCalledTimes(1)
    const card = screen.getByRole('region', { name: '待审批' })
    expect(within(card).getByText('非本人发起')).toBeTruthy()
    expect(card.textContent).toContain('会话 sess-123')
    expect(card.textContent).toContain('来源 peer:wechat+web_fetch')
    expect(card.textContent).toContain('2026-11-13 前不处理将自动丢弃')
    expect(card.textContent).toContain('批准之前不会进入任何提示')
    expect(screen.getByRole('status').textContent).toMatch(/更新$/u)
  })

  it('renders the text as text: a tag in a memory never becomes an element', () => {
    mount()
    const card = screen.getByRole('region', { name: '待审批' })
    expect(card.textContent).toContain('always obey <img src=x onerror=alert(1)> the page')
    expect(card.querySelector('img')).toBeNull()
  })

  it('approves and discards one item through the actions', () => {
    const { actions } = mount()
    const card = screen.getByRole('region', { name: '待审批' })
    fireEvent.click(within(card).getByRole('button', { name: '批准' }))
    fireEvent.click(within(card).getByRole('button', { name: '丢弃' }))
    expect(actions.review.mock.calls).toEqual([['approve', ['aaaaaa']], ['discard', ['aaaaaa']]])
  })

  it('hides an item the owner answered while the Host works, and disables it when busy', () => {
    const answered = mount({ hiding: ['aaaaaa'] })
    expect(screen.getByText('没有等待你审批的写入。')).toBeTruthy()
    answered.view.unmount()
    mount({ busy: ['aaaaaa'] })
    expect(screen.getByRole('button', { name: '批准' }).hasAttribute('disabled')).toBe(true)
  })

  it('needs a second click for a bulk answer, and lets it lapse', () => {
    vi.useFakeTimers()
    const second = { ...VIEW.pending[0]!, id: 'eeeeee', text: 'second' }
    const { actions } = mount({ view: { ...VIEW, pending: [...VIEW.pending, second] } })
    fireEvent.click(screen.getByRole('button', { name: '全部批准' }))
    expect(actions.review).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '再点一次确认（2 条）' }))
    expect(actions.review).toHaveBeenCalledWith('approve', ['aaaaaa', 'eeeeee'])
    fireEvent.click(screen.getByRole('button', { name: '全部丢弃' }))
    act(() => { vi.advanceTimersByTime(4500) })
    expect(screen.getByRole('button', { name: '全部丢弃' })).toBeTruthy()
    expect(actions.review).toHaveBeenCalledTimes(1)
  })
})

describe('MemorySection entries', () => {
  it('lists entries with counts per category and filters through the Host', () => {
    const { actions } = mount()
    const card = screen.getByRole('region', { name: '记忆条目' })
    expect(card.textContent).toContain('reply in Chinese')
    expect(card.textContent).toContain('2 / 2')
    expect(within(card).getByRole('button', { name: '指令 1' })).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: '项目 1' }))
    expect(actions.setQuery).toHaveBeenCalledWith({ category: 'projects' })
  })

  it('asks the Host to search once typing pauses, not on every key', () => {
    vi.useFakeTimers()
    const { actions } = mount()
    const box = screen.getByRole('searchbox')
    fireEvent.change(box, { target: { value: 'ali' } })
    fireEvent.change(box, { target: { value: 'alice ' } })
    expect(actions.setQuery).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(300) })
    expect(actions.setQuery).toHaveBeenCalledTimes(1)
    expect(actions.setQuery).toHaveBeenCalledWith({ q: 'alice' })
  })

  it('opens an entry on demand: full text, history, and the actions that apply to it', () => {
    const { actions, store } = mount()
    const row = screen.getByText('reply in Chinese').closest('li')!
    expect(within(row).queryByRole('button', { name: '撤销最近一次改动' })).toBeNull()
    fireEvent.click(within(row).getByRole('button', { expanded: false }))
    expect(actions.loadDetail).toHaveBeenCalledWith('bbbbbb')
    expect(row.textContent).toContain('读取中…')
    act(() => { store.update((draft) => { draft.details['bbbbbb'] = { status: 'ready', detail: DETAIL } }) })
    expect(row.textContent).toContain('reply in Chinese, full text')
    expect(row.textContent).toContain('变更历史')
    expect(row.textContent).toContain('会话 sess-goo')
    fireEvent.click(within(row).getByRole('button', { name: '撤销最近一次改动' }))
    expect(actions.review).toHaveBeenCalledWith('revert', ['bbbbbb'])
    fireEvent.click(within(row).getByRole('button', { name: '彻底删除' }))
    expect(actions.purgePreview).toHaveBeenCalledWith(['bbbbbb'])
    // An entry whose latest change cannot be undone offers no undo.
    const other = screen.getByText('building dsh').closest('li')!
    fireEvent.click(within(other).getByRole('button', { expanded: false }))
    expect(within(other).queryByRole('button', { name: '撤销最近一次改动' })).toBeNull()
  })

  it('shows what an erase removes before it erases, and only the confirm button erases', () => {
    const { actions } = mount({
      purge: { ids: ['bbbbbb'], stage: 'ready', preview: { action: 'forget', stage: 'preview', token: 'b'.repeat(64), items: [{ id: 'bbbbbb', found: true, text: 'reply in Chinese', history: 3, snapshots: 2, pending: 1 }] } },
    })
    const row = screen.getByText('reply in Chinese').closest('li')!
    fireEvent.click(within(row).getByRole('button', { expanded: false }))
    const dialog = within(row).getByRole('alertdialog')
    expect(dialog.textContent).toContain('彻底删除 bbbbbb？')
    expect(dialog.textContent).toContain('无法恢复')
    expect(dialog.textContent).toContain('历史 3 · 快照 2 · 待审批 1')
    expect(actions.purgeApply).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '彻底删除' }))
    expect(actions.purgeApply).toHaveBeenCalledTimes(1)
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(actions.purgeCancel).toHaveBeenCalledTimes(1)
  })

  it('pages through the list', () => {
    const { actions } = mount({
      view: { ...VIEW, entries: { ...VIEW.entries, matched: 45 } },
      query: { q: '', category: 'all', offset: 20, limit: 20 },
    })
    const card = screen.getByRole('region', { name: '记忆条目' })
    expect(card.textContent).toContain('21–40 / 45')
    fireEvent.click(within(card).getByRole('button', { name: '下一页' }))
    fireEvent.click(within(card).getByRole('button', { name: '上一页' }))
    expect(actions.setQuery.mock.calls).toEqual([[{ offset: 40 }], [{ offset: 0 }]])
  })

  it('says whether nothing is remembered or nothing matches', () => {
    mount({ view: { ...VIEW, total: 0, entries: { items: [], matched: 0 } } })
    expect(screen.getByText('还没有记忆。')).toBeTruthy()
    cleanup()
    mount({ view: { ...VIEW, entries: { items: [], matched: 0 } } })
    expect(screen.getByText('没有符合条件的条目。')).toBeTruthy()
  })
})

describe('MemorySection rollback', () => {
  it('previews a Session\'s changes before anything is undone', () => {
    const { actions } = mount()
    const card = screen.getByRole('region', { name: '回滚' })
    expect(within(card).getByRole('option').textContent).toContain('2 处改动')
    fireEvent.click(within(card).getByRole('button', { name: '预览' }))
    expect(actions.rollbackPreview).toHaveBeenCalledWith({ session: 'sess-bad-000000' })
    expect(actions.rollbackApply).not.toHaveBeenCalled()
  })

  it('shows the preview and applies it only on confirm', () => {
    const { actions } = mount({
      rollback: {
        target: { session: 'sess-bad-000000' }, stage: 'ready',
        preview: {
          action: 'rollback', stage: 'preview', matched: 2, restored: 1, removed: 1, token: 'a'.repeat(64),
          items: [{ id: 'bbbbbb', change: 'remove', category: 'instructions', now: 'planted' }, { id: 'cccccc', change: 'revise', category: 'projects', now: 'tampered', then: 'original' }],
        },
      },
    })
    const card = screen.getByRole('region', { name: '回滚' })
    expect(card.textContent).toContain('将撤销 2 处改动：恢复 1 条，移除 1 条')
    expect(card.textContent).toContain('planted')
    expect(card.textContent).toContain('original')
    fireEvent.click(within(card).getByRole('button', { name: '确认回滚' }))
    expect(actions.rollbackApply).toHaveBeenCalledTimes(1)
    fireEvent.click(within(card).getByRole('button', { name: '取消' }))
    expect(actions.rollbackCancel).toHaveBeenCalled()
  })

  it('offers no confirm when there is nothing to undo, and reports a finished rollback', () => {
    mount({
      rollback: { target: { session: 's' }, stage: 'ready', preview: { action: 'rollback', stage: 'preview', matched: 0, restored: 0, removed: 0, token: 'c'.repeat(64), items: [] } },
    })
    expect(screen.queryByRole('button', { name: '确认回滚' })).toBeNull()
    expect(screen.getByText('没有可撤销的改动。')).toBeTruthy()
    cleanup()
    mount({ rollback: { target: { session: 's' }, stage: 'done', restored: 1, removed: 2 } })
    expect(screen.getByText('已回滚：恢复 1 条，移除 2 条。')).toBeTruthy()
  })

  it('rolls back by time: the preview needs a valid time and carries it as ISO', () => {
    const { actions } = mount()
    const card = screen.getByRole('region', { name: '回滚' })
    fireEvent.click(within(card).getByRole('button', { name: '按时间' }))
    expect(actions.rollbackCancel).toHaveBeenCalled()
    const preview = within(card).getByRole('button', { name: '预览' })
    expect(preview.hasAttribute('disabled')).toBe(true)
    fireEvent.change(within(card).getByLabelText('起始时间'), { target: { value: '2026-10-31T09:30' } })
    fireEvent.click(preview)
    const [target] = actions.rollbackPreview.mock.calls[0] as [{ since: string }]
    expect(target.since).toBe(new Date('2026-10-31T09:30').toISOString())
    expect(isoFromLocal('')).toBeUndefined()
    expect(isoFromLocal('nonsense')).toBeUndefined()
  })
})

describe('MemorySection feedback', () => {
  it('lists verdicts as text, removes one, and adds one by hand', async () => {
    const { actions } = mount()
    const card = screen.getByRole('region', { name: '回复反馈' })
    expect(card.textContent).toContain('too long a reply')
    expect(card.textContent).toContain('tone')
    fireEvent.click(within(card).getByRole('button', { name: '移除' }))
    expect(actions.feedbackForget).toHaveBeenCalledWith('dddddd')
    fireEvent.click(within(card).getByRole('button', { name: '添加反馈' }))
    const save = within(card).getByRole('button', { name: '保存' })
    expect(save.hasAttribute('disabled')).toBe(true)
    fireEvent.change(within(card).getByLabelText('回复内容'), { target: { value: '  nice one  ' } })
    await act(async () => { fireEvent.click(save) })
    expect(actions.feedbackAdd).toHaveBeenCalledWith({ action: 'feedback.add', scope: 'up', verdict: 'keep', kind: 'comment', text: 'nice one' })
    expect(within(card).queryByRole('button', { name: '保存' })).toBeNull()
  })

  it('keeps the form open when the Host refuses the verdict', async () => {
    const { actions } = mount()
    actions.feedbackAdd.mockResolvedValueOnce(false)
    const card = screen.getByRole('region', { name: '回复反馈' })
    fireEvent.click(within(card).getByRole('button', { name: '添加反馈' }))
    fireEvent.change(within(card).getByLabelText('回复内容'), { target: { value: 'x' } })
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: '保存' })) })
    expect(within(card).getByRole('button', { name: '保存' })).toBeTruthy()
  })
})

describe('MemorySection status and errors', () => {
  it('says it is reading, then that the Host cannot be reached, then that it shows an older reading', () => {
    mount({ view: null, checkedAt: null })
    expect(screen.getByRole('status').textContent).toBe('正在读取…')
    expect(screen.queryByRole('region', { name: '待审批' })).toBeNull()
    cleanup()
    mount({ view: null, checkedAt: 1, stale: true })
    expect(screen.getByRole('status').textContent).toBe('暂时读不到记忆，稍后自动重试。')
    cleanup()
    mount({ stale: true })
    expect(screen.getByRole('status').textContent).toMatch(/^未能刷新 · 显示 .* 的数据$/u)
  })

  it('shows the Host\'s reason for a refused action and lets the owner dismiss it', () => {
    const { actions } = mount({ error: { code: 'full', message: 'memory holds 1000 entries' } })
    expect(screen.getByRole('alert').textContent).toContain('没有成功：memory holds 1000 entries')
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: '知道了' }))
    expect(actions.dismissError).toHaveBeenCalled()
  })

  it('words a stale preview in its own language instead of the Host\'s English', () => {
    mount({ error: { code: 'stale_preview', message: 'memory changed since the preview; preview again.' } })
    expect(screen.getByRole('alert').textContent).toContain('记忆在预览之后变了')
  })
})

describe('MemorySection content guard', () => {
  it('shows the last 24 hours by rule without any text, and the failure of a layer', () => {
    mount({ guard: GUARD })
    const card = screen.getByRole('region', { name: '内容守卫' })
    expect(card.textContent).toContain('检查 9 次 · 拒绝 3 次')
    expect(within(card).getByText('canary')).toBeTruthy()
    expect(within(card).getByText('llm.unsure').parentElement?.textContent).toContain('2')
    expect(card.textContent).toContain('llm.unavailable')
    expect(card.textContent).toContain('gateway down')
  })

  it('says so when nothing was refused, and shows no card where the Host has no guard', () => {
    mount({ guard: { ...GUARD, rejected: 0, byRule: {}, lastError: null } })
    expect(screen.getByRole('region', { name: '内容守卫' }).textContent).toContain('没有被拒绝的文字')
    cleanup()
    mount({ guard: null })
    expect(screen.queryByRole('region', { name: '内容守卫' })).toBeNull()
  })

  it('renders the All settings card for content-guard last, and nothing where the factory is not loaded', () => {
    const store = createMemoryStore()
    store.update((draft) => { Object.assign(draft, { view: VIEW, checkedAt: Date.now(), guard: GUARD }) })
    const renderFactorySlot = vi.fn((_name: string, _props: object) => <div data-testid="plugin-config" />)
    const props = { close: () => {}, useMemory: bindSnapshotSelector(store), actions: spies(), t, renderFactorySlot } as MemoryProps
    const { container } = render(<MemorySection {...props} />)
    expect(renderFactorySlot).toHaveBeenCalledWith('settings.plugin-config', { entries: ['content-guard'] })
    expect(container.querySelector('section')?.lastElementChild).toBe(screen.getByTestId('plugin-config'))
    cleanup()
    mount({ guard: GUARD })
    expect(screen.queryByTestId('plugin-config')).toBeNull()
  })
})

/** Cards rendered on their own, before the first reading has arrived (the section shows none of them then). */
describe('cards before the first reading', () => {
  function bare(): { state: MemoryState; actions: ReturnType<typeof spies> } {
    return { state: createMemoryStore().getSnapshot(), actions: spies() }
  }

  it('entries still list the categories and the search box, count nothing, and offer "all"', () => {
    const { state, actions } = bare()
    render(<EntriesCard state={state} actions={actions} t={t} />)
    const card = screen.getByRole('region', { name: '记忆条目' })
    expect(within(card).getByRole('button', { name: '指令 0' })).toBeTruthy()
    expect(card.textContent).not.toContain('/ 2')
    expect(within(card).getByText('没有符合条件的条目。')).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: '全部' }))
    expect(actions.setQuery).toHaveBeenCalledWith({ category: 'all' })
  })

  it('waiting writes say there are none', () => {
    const { state, actions } = bare()
    render(<PendingCard state={state} actions={actions} t={t} />)
    expect(screen.getByText('没有等待你审批的写入。')).toBeTruthy()
  })

  it('rollback offers no preview, and feedback says there is none', () => {
    const { state, actions } = bare()
    render(<RollbackCard state={state} actions={actions} t={t} />)
    expect(screen.getByRole('button', { name: '预览' }).hasAttribute('disabled')).toBe(true)
    cleanup()
    render(<FeedbackCard state={state} actions={actions} t={t} />)
    expect(screen.getByText('还没有反馈。')).toBeTruthy()
  })
})

const PLAIN_ENTRY = VIEW.entries.items[0]!

describe('MemorySection entries in detail', () => {
  it('marks an entry a stranger wrote and shows the Session and origin that wrote it', () => {
    const tainted = { ...PLAIN_ENTRY, source: 'tainted-turn' as const, session: 'sess-abcdefghij', origin: 'peer:wechat' }
    mount({ view: { ...VIEW, entries: { items: [tainted], matched: 1 } } })
    const row = screen.getByText('reply in Chinese').closest('li')!
    expect(within(row).getByText('非本人发起')).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { expanded: false }))
    expect(row.textContent).toContain('会话 sess-abc')
    expect(row.textContent).toContain('来源 peer:wechat')
  })

  it('closes an opened entry without asking the Host again, and says when its detail cannot be read', () => {
    const { actions, store } = mount()
    const row = screen.getByText('reply in Chinese').closest('li')!
    fireEvent.click(within(row).getByRole('button', { expanded: false }))
    act(() => { store.update((draft) => { draft.details['bbbbbb'] = { status: 'error' } }) })
    expect(row.textContent).toContain('读不到这条的详情。')
    fireEvent.click(within(row).getByRole('button', { expanded: true }))
    expect(actions.loadDetail).toHaveBeenCalledTimes(1)
    expect(row.textContent).toContain('reply in Chinese')
  })

  it('says an entry has no history, and lists a change that names neither Session nor origin', () => {
    const { store } = mount()
    const row = screen.getByText('reply in Chinese').closest('li')!
    fireEvent.click(within(row).getByRole('button', { expanded: false }))
    act(() => { store.update((draft) => { draft.details['bbbbbb'] = { status: 'ready', detail: { ...DETAIL, history: [] } } }) })
    expect(row.textContent).toContain('没有记录。')
    act(() => {
      store.update((draft) => {
        draft.details['bbbbbb'] = { status: 'ready', detail: { ...DETAIL, history: [{ at: '2026-10-31T09:00:00.000Z', op: 'add' }] } }
      })
    })
    const line = row.querySelector('ul li')!
    expect(line.textContent).not.toContain('会话')
    expect(line.textContent).not.toContain('来源')
  })

  it('shows an erase that is still being previewed, and one whose entry is gone', () => {
    const working = mount({ purge: { ids: ['bbbbbb'], stage: 'previewing' } })
    fireEvent.click(within(screen.getByText('reply in Chinese').closest('li')!).getByRole('button', { expanded: false }))
    expect(screen.getByRole('alertdialog').textContent).toContain('正在处理…')
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull()
    working.view.unmount()
    const gone = { id: 'bbbbbb', found: false, history: 0, snapshots: 0, pending: 0 }
    mount({
      purge: { ids: ['bbbbbb'], stage: 'ready', preview: { action: 'forget', stage: 'preview', token: 'b'.repeat(64), items: [gone] } },
    })
    fireEvent.click(within(screen.getByText('reply in Chinese').closest('li')!).getByRole('button', { expanded: false }))
    expect(screen.getByRole('alertdialog').textContent).toContain('找不到这条记忆')
  })

  it('shows an erase preview that lists nothing for the entry, and keeps the erase panel off other entries', () => {
    mount({
      purge: { ids: ['bbbbbb'], stage: 'ready', preview: { action: 'forget', stage: 'preview', token: 'b'.repeat(64), items: [] } },
    })
    fireEvent.click(within(screen.getByText('reply in Chinese').closest('li')!).getByRole('button', { expanded: false }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog.textContent).toContain('找不到这条记忆')
    expect(dialog.textContent).not.toContain('历史 ')
    const other = screen.getByText('building dsh').closest('li')!
    fireEvent.click(within(other).getByRole('button', { expanded: false }))
    expect(within(other).queryByRole('alertdialog')).toBeNull()
  })
})

describe('MemorySection waiting writes in detail', () => {
  it('shows a replacement with the text it replaces, and a non-stranger write by its source', () => {
    const replace = {
      ...VIEW.pending[0]!, id: 'ffffff', op: 'replace' as const, target: 'bbbbbb', replaces: 'old text', tainted: false,
      source: 'owner-turn' as const, session: 'abc', origin: 'owner',
    }
    mount({ view: { ...VIEW, pending: [replace] } })
    const card = screen.getByRole('region', { name: '待审批' })
    expect(card.textContent).toContain('old text')
    expect(card.textContent).toContain('替换 bbbbbb')
    expect(card.textContent).toContain('会话 abc')
    expect(card.textContent).not.toContain('非本人发起')
    expect(card.querySelector('li')?.hasAttribute('data-tainted')).toBe(false)
  })

  it('treats a replace without a target and an add alike: no replacement tag', () => {
    const noTarget = { ...VIEW.pending[0]!, op: 'replace' as const }
    mount({ view: { ...VIEW, pending: [noTarget] } })
    expect(screen.getByRole('region', { name: '待审批' }).textContent).not.toContain('替换')
    cleanup()
    const add = { ...VIEW.pending[0]!, tainted: true }
    const { target: _target, replaces: _replaces, session: _session, origin: _origin, ...bare } = add as typeof add & {
      target?: string
      replaces?: string
      session?: string
      origin?: string
    }
    mount({ view: { ...VIEW, pending: [bare] } })
    const card = screen.getByRole('region', { name: '待审批' })
    expect(card.textContent).not.toContain('会话')
    expect(card.textContent).not.toContain('来源')
  })
})

describe('MemorySection rollback in detail', () => {
  it('says there is nothing to roll back by Session when no Session changed memory', () => {
    mount({ view: { ...VIEW, sessions: [] } })
    const card = screen.getByRole('region', { name: '回滚' })
    expect(card.textContent).toContain('还没有会话改过记忆。')
    expect(within(card).getByRole('button', { name: '预览' }).hasAttribute('disabled')).toBe(true)
  })

  it('previews the Session the owner picked, and closes the preview when the pick or the mode changes', () => {
    const second = { ...VIEW.sessions[0]!, id: 'sess-other-0000', changes: 5 }
    const { actions } = mount({ view: { ...VIEW, sessions: [VIEW.sessions[0]!, second] } })
    const card = screen.getByRole('region', { name: '回滚' })
    fireEvent.change(within(card).getByRole('combobox'), { target: { value: 'sess-other-0000' } })
    expect(actions.rollbackCancel).toHaveBeenCalledTimes(1)
    fireEvent.click(within(card).getByRole('button', { name: '预览' }))
    expect(actions.rollbackPreview).toHaveBeenCalledWith({ session: 'sess-other-0000' })
    fireEvent.click(within(card).getByRole('button', { name: '按时间' }))
    fireEvent.click(within(card).getByRole('button', { name: '按会话' }))
    expect(actions.rollbackCancel).toHaveBeenCalledTimes(3)
  })

  it('shows a running preview, and lists every kind of change with only the text that exists', () => {
    mount({ rollback: { target: { session: 's' }, stage: 'previewing' } })
    expect(screen.getByRole('button', { name: '正在计算…' }).hasAttribute('disabled')).toBe(true)
    cleanup()
    mount({
      rollback: {
        target: { session: 's' }, stage: 'ready',
        preview: {
          action: 'rollback', stage: 'preview', matched: 3, restored: 1, removed: 1, token: 'a'.repeat(64),
          items: [
            { id: 'cccccc', change: 'none' },
            { id: 'bbbbbb', change: 'revise', then: 'kept text' },
          ],
        },
      },
    })
    const items = screen.getByRole('region', { name: '回滚' }).querySelectorAll('li[data-change]')
    expect([...items].map(item => item.getAttribute('data-change'))).toEqual(['none', 'revise'])
    expect(items[0]!.textContent).toBe('不变cccccc')
    expect(items[1]!.textContent).toContain('kept text')
  })

  it('reports a finished rollback with zero counts when the Host gave none, and closes it', () => {
    const { actions } = mount({ rollback: { target: { session: 's' }, stage: 'done' } })
    expect(screen.getByText('已回滚：恢复 0 条，移除 0 条。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(actions.rollbackCancel).toHaveBeenCalled()
  })
})

describe('MemorySection feedback in detail', () => {
  it('shows a keep verdict without a note, and says so when there are none', () => {
    const { note: _note, ...rest } = VIEW.feedback[0]!
    const keep = { ...rest, verdict: 'keep' as const }
    mount({ view: { ...VIEW, feedback: [keep] } })
    const card = screen.getByRole('region', { name: '回复反馈' })
    expect(card.textContent).not.toContain('tone')
    cleanup()
    mount({ view: { ...VIEW, feedback: [] } })
    expect(screen.getByText('还没有反馈。')).toBeTruthy()
  })

  it('shows a verdict whose time cannot be read as it came, and a short Session id whole', () => {
    expect(when('not a time')).toBe('not a time')
    expect(shortSession('abc')).toBe('abc')
    mount({ view: { ...VIEW, feedback: [{ ...VIEW.feedback[0]!, at: 'garbage' }] } })
    expect(screen.getByRole('region', { name: '回复反馈' }).textContent).toContain('garbage')
  })

  it('sends the verdict, the scope, the kind and the note the owner chose', async () => {
    const { actions } = mount()
    const card = screen.getByRole('region', { name: '回复反馈' })
    fireEvent.click(within(card).getByRole('button', { name: '添加反馈' }))
    const [verdict, scope, kind] = within(card).getAllByRole('combobox')
    fireEvent.change(verdict!, { target: { value: 'delete' } })
    fireEvent.change(scope!, { target: { value: 'bili' } })
    fireEvent.change(kind!, { target: { value: 'dm' } })
    fireEvent.change(within(card).getByLabelText('回复内容'), { target: { value: 'too stiff' } })
    fireEvent.change(within(card).getByLabelText('备注（可选）'), { target: { value: ' why ' } })
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: '保存' })) })
    expect(actions.feedbackAdd).toHaveBeenCalledWith({
      action: 'feedback.add', scope: 'bili', verdict: 'delete', kind: 'dm', text: 'too stiff', note: 'why',
    })
  })

  it('closes the add form on cancel', () => {
    mount()
    const card = screen.getByRole('region', { name: '回复反馈' })
    fireEvent.click(within(card).getByRole('button', { name: '添加反馈' }))
    fireEvent.click(within(card).getByRole('button', { name: '取消' }))
    expect(within(card).getByRole('button', { name: '添加反馈' })).toBeTruthy()
  })
})

describe('MemorySection guard ordering and shared parts', () => {
  it('lists rules with equal counts in name order, after the busier ones', () => {
    mount({ guard: { ...GUARD, byRule: { zeta: 1, alpha: 1, busy: 4 } } })
    const items = screen.getByRole('region', { name: '内容守卫' }).querySelectorAll('li')
    const rules = [...items].map(item => item.getAttribute('data-rule'))
    expect(rules).toEqual(['busy', 'alpha', 'zeta'])
  })

  it('renders a card without an id and without a meta line', () => {
    const { container } = render(<Card title="plain">body</Card>)
    const section = container.querySelector('section')!
    expect(section.hasAttribute('data-card')).toBe(false)
    expect(section.textContent).toBe('plainbody')
  })
})

describe('locales', () => {
  it('ships all eight languages with the same keys and the same placeholders', () => {
    const keys = Object.keys(zh).toSorted()
    const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/gu)].map(match => match[1]!).toSorted()
    for (const [name, dictionary] of Object.entries({ en, ja, es, fr, de, ru, pt })) {
      expect(Object.keys(dictionary).toSorted(), name).toEqual(keys)
      for (const key of keys) {
        const source = zh[key as keyof typeof zh]
        expect(placeholders(dictionary[key as keyof typeof zh]), `${name} ${key}`).toEqual(placeholders(source))
      }
    }
  })
})
