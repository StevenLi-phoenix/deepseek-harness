// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { QqPanel } from '../src/view.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { GroupsSection } from '../src/client/groups.ts'
import { createQqStore, type QqState } from '../src/client/qq.ts'
import { QqLoginSection, type QqLoginProps } from '../src/client/QqLogin.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh) as QqLoginProps['t']
const NOW = Date.now()

function panel(over: { connection?: Partial<QqPanel['connection']>; login?: Partial<QqPanel['login']> } = {}): QqPanel {
  return {
    at: NOW,
    groupsRecorded: 24,
    groups: [
      { groupId: '111111', name: '技术群', memberCount: 80, recorded: true, seen: 0 },
      { groupId: '222222', name: '闲聊群', memberCount: 300, recorded: false, seen: 7 },
      { groupId: '333333', name: '安静群', memberCount: 12, recorded: false, seen: 0 },
    ],
    connection: { state: 'connected', since: NOW - 3_600_000, attempt: 0, lastError: null, selfId: '2153925085', ...over.connection },
    login: { door: 'ok', state: 'online', uin: '2153925085', nickname: '小号', error: null, qr: null, ...over.login },
  }
}

const waiting = (): QqPanel => panel({
  connection: { state: 'reconnecting', attempt: 12, since: NOW - 600_000, lastError: 'socket hang up', selfId: null },
  login: { state: 'qr', uin: null, nickname: null, qr: { size: 3, rows: ['101', '010', '111'] } },
})

const READY: ConfigFormSnapshot<GroupsSection> = { status: 'ready', value: { groups: ['111111'] }, base: undefined, user: undefined, revision: 3, writable: true }

function mount(state: Partial<QqState>, form: Partial<ConfigFormSnapshot<GroupsSection>> = {}) {
  const store = createQqStore()
  store.update((draft) => { Object.assign(draft, state) })
  const formStore = createSnapshotStore<ConfigFormSnapshot<GroupsSection>>({ ...READY, ...form })
  const refresh = vi.fn()
  const renewCode = vi.fn()
  const addGroup = vi.fn(() => Promise.resolve(true))
  const removeGroup = vi.fn(() => Promise.resolve(true))
  // The shell's global standard hooks are not read by this section.
  const props = {
    close: () => {},
    useQq: bindSnapshotSelector(store),
    useGroupsForm: bindSnapshotSelector(formStore),
    refresh, renewCode, addGroup, removeGroup, t,
  } as QqLoginProps
  const element = () => <QqLoginSection {...props} />
  const view = render(element())
  return { store, formStore, refresh, renewCode, addGroup, removeGroup, view, rerender: () => { view.rerender(element()) } }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('QqLoginSection', () => {
  it('reads on opening, every 3 s while open, and stops when closed', () => {
    vi.useFakeTimers()
    const { refresh, view, store, rerender } = mount({})
    expect(screen.getByRole('status').textContent).toBe('正在读取…')
    expect(refresh).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(3_000) })
    expect(refresh).toHaveBeenCalledTimes(2)
    // A store update re-renders without restarting the poller.
    act(() => { store.update((draft) => { draft.panel = panel() }) })
    rerender()
    expect(refresh).toHaveBeenCalledTimes(2)
    view.unmount()
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('reads once a minute while connected and every 3 seconds as soon as it is not', () => {
    vi.useFakeTimers()
    const { refresh, store, rerender } = mount({ panel: panel(), checkedAt: NOW })
    expect(refresh).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(59_999) })
    expect(refresh).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(1) })
    expect(refresh).toHaveBeenCalledTimes(2)
    // The link drops: the reading that follows decides, and from then on the period is short.
    act(() => { store.update((draft) => { draft.panel = waiting() }) })
    rerender()
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(refresh).toHaveBeenCalledTimes(3)
    act(() => { vi.advanceTimersByTime(3_000) })
    expect(refresh).toHaveBeenCalledTimes(4)
  })

  it('shows one calm verdict and the details when QQ is connected, and no code', () => {
    mount({ panel: panel(), checkedAt: NOW })
    expect(screen.getByRole('heading', { name: 'QQ 已连接' })).toBeTruthy()
    expect(screen.getByText(/账号 小号 \(2153925085\)|账号 2153925085/)).toBeTruthy()
    expect(screen.queryByRole('img', { name: 'QQ 登录二维码' })).toBeNull()
    expect(screen.queryByRole('button', { name: '刷新二维码' })).toBeNull()
    expect(screen.getByText('24 个')).toBeTruthy()
  })

  it('draws the code with a quiet zone when a scan is needed, and offers a fresh one', () => {
    const { renewCode } = mount({ panel: waiting(), checkedAt: NOW })
    expect(screen.getByRole('heading', { name: '需要扫码登录' })).toBeTruthy()
    const qr = screen.getByRole('img', { name: 'QQ 登录二维码' })
    expect(qr.getAttribute('viewBox')).toBe('0 0 7 7')
    expect(qr.querySelector('path')?.getAttribute('d')).toBe('M2 2h1v1h-1zM4 2h1v1h-1zM3 3h1v1h-1zM2 4h3v1h-3z')
    fireEvent.click(screen.getByRole('button', { name: '刷新二维码' }))
    expect(renewCode).toHaveBeenCalledTimes(1)
    // Why it is down, in plain words, below the code.
    expect(screen.getByText('socket hang up')).toBeTruthy()
    expect(screen.getByText(/截屏/)).toBeTruthy()
  })

  it('swaps the code when NapCat rotates it, without remounting the section', () => {
    const { store, rerender } = mount({ panel: waiting(), checkedAt: NOW })
    const before = screen.getByRole('img', { name: 'QQ 登录二维码' }).querySelector('path')?.getAttribute('d')
    act(() => { store.update((draft) => { if (draft.panel !== null) draft.panel = { ...draft.panel, login: { ...draft.panel.login, qr: { size: 3, rows: ['111', '000', '111'] } } } }) })
    rerender()
    expect(screen.getByRole('img', { name: 'QQ 登录二维码' }).querySelector('path')?.getAttribute('d')).not.toBe(before)
  })

  it('disables the button while a fresh code is pending and says when it was declined', () => {
    const { store, rerender } = mount({ panel: waiting(), checkedAt: NOW, codeRequested: true })
    const button = screen.getByRole<HTMLButtonElement>('button', { name: '正在刷新…' })
    expect(button.disabled).toBe(true)
    act(() => { store.update((draft) => { draft.codeRequested = false; draft.codeDeclined = true }) })
    rerender()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '刷新二维码' }).disabled).toBe(false)
    expect(screen.getByText(/这次没有刷新/)).toBeTruthy()
  })

  it('turns to "connected" on the next answer after the scan', () => {
    const { store, rerender } = mount({ panel: waiting(), checkedAt: NOW })
    act(() => { store.update((draft) => { draft.panel = panel() }) })
    rerender()
    expect(screen.getByRole('heading', { name: 'QQ 已连接' })).toBeTruthy()
    expect(screen.queryByRole('img', { name: 'QQ 登录二维码' })).toBeNull()
  })

  it('tells how to bring the door back instead of drawing nothing when it is down', () => {
    mount({
      panel: panel({ connection: { state: 'reconnecting', attempt: 3, selfId: null }, login: { door: 'unreachable', state: null, uin: null, nickname: null } }),
      checkedAt: NOW,
    })
    expect(screen.getByRole('heading', { name: 'QQ 连不上，扫码入口也没有运行' })).toBeTruthy()
    expect(screen.getByText(/napcat\.sh start/)).toBeTruthy()
    expect(screen.queryByRole('img', { name: 'QQ 登录二维码' })).toBeNull()
  })

  it('keeps the last reading and says so when a refresh fails', () => {
    mount({ panel: panel(), checkedAt: NOW, stale: true })
    expect(screen.getByRole('status').textContent).toMatch(/未能刷新/)
    expect(screen.getByRole('heading', { name: 'QQ 已连接' })).toBeTruthy()
  })

  it('lists the recorded groups by name and offers the other groups, busiest first, each with one tap to add', () => {
    const { addGroup } = mount({ panel: panel(), checkedAt: NOW })
    const recorded = screen.getByRole('list', { name: '记录的群' })
    expect(recorded.textContent).toContain('技术群')
    expect(recorded.textContent).toContain('111111')
    const candidates = screen.getByRole('list', { name: '账号所在的其他群' })
    expect([...candidates.querySelectorAll('li')].map(item => item.textContent)).toEqual([
      expect.stringContaining('闲聊群'),
      expect.stringContaining('安静群'),
    ])
    expect(candidates.textContent).toContain('已丢弃 7 条消息')
    fireEvent.click(candidates.querySelectorAll('button')[0]!)
    expect(addGroup).toHaveBeenCalledWith('222222')
  })

  it('removes a group only after a second tap', () => {
    const { removeGroup } = mount({ panel: panel(), checkedAt: NOW })
    const row = screen.getByRole('list', { name: '记录的群' })
    fireEvent.click(row.querySelector('button')!)
    expect(removeGroup).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认移除' }))
    expect(removeGroup).toHaveBeenCalledWith('111111')
  })

  it('cancels a pending removal', () => {
    const { removeGroup } = mount({ panel: panel(), checkedAt: NOW })
    fireEvent.click(screen.getByRole('list', { name: '记录的群' }).querySelector('button')!)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('button', { name: '确认移除' })).toBeNull()
    expect(removeGroup).not.toHaveBeenCalled()
  })

  it('adds a typed group number, and refuses what is not one without calling the Host', () => {
    const { addGroup } = mount({ panel: panel(), checkedAt: NOW })
    const input = screen.getByPlaceholderText('群号（数字）')
    fireEvent.change(input, { target: { value: 'abc' } })
    fireEvent.submit(input.closest('form')!)
    expect(screen.getByRole('alert').textContent).toBe('群号是 3 到 20 位数字。')
    expect(addGroup).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: ' 444555666 ' } })
    fireEvent.submit(input.closest('form')!)
    expect(addGroup).toHaveBeenCalledWith('444555666')
  })

  it('says so when the Host refused the write, and keeps the buttons usable', async () => {
    const { addGroup } = mount({ panel: panel(), checkedAt: NOW })
    addGroup.mockResolvedValueOnce(false)
    await act(async () => { fireEvent.click(screen.getByRole('list', { name: '账号所在的其他群' }).querySelector('button')!) })
    expect(screen.getByRole('alert').textContent).toMatch(/没有保存/)
    expect(screen.getAllByRole<HTMLButtonElement>('button', { name: '添加' })[0]!.disabled).toBe(false)
  })

  it('shows the list as read-only when a higher layer owns it, and explains when the Host does not serve it', () => {
    mount({ panel: panel(), checkedAt: NOW }, { writable: false })
    expect(screen.getByText(/更高优先级的层/)).toBeTruthy()
    for (const button of screen.getAllByRole<HTMLButtonElement>('button', { name: '移除' })) expect(button.disabled).toBe(true)
    cleanup()
    mount({ panel: panel(), checkedAt: NOW }, { status: 'unavailable', value: undefined })
    expect(screen.getByText(/没有开放在页面上编辑群名单/)).toBeTruthy()
    expect(screen.queryByPlaceholderText('群号（数字）')).toBeNull()
  })

  it('falls back to the number for a group the account has not named, and shows an empty list plainly', () => {
    mount({ panel: panel(), checkedAt: NOW }, { value: { groups: ['999999'] } })
    expect(screen.getByRole('list', { name: '记录的群' }).textContent).toContain('999999')
    cleanup()
    mount({ panel: panel(), checkedAt: NOW }, { value: { groups: [] } })
    expect(screen.getByText('名单是空的：现在什么都不记录。')).toBeTruthy()
  })
})
