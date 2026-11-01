// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { QqPanel } from '../src/view.ts'
import { createQqStore, type QqState } from '../src/client/qq.ts'
import { QqLoginSection, type QqLoginProps } from '../src/client/QqLogin.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh) as QqLoginProps['t']
const NOW = Date.now()

function panel(over: { connection?: Partial<QqPanel['connection']>; login?: Partial<QqPanel['login']> } = {}): QqPanel {
  return {
    at: NOW,
    groupsRecorded: 24,
    connection: { state: 'connected', since: NOW - 3_600_000, attempt: 0, lastError: null, selfId: '2153925085', ...over.connection },
    login: { door: 'ok', state: 'online', uin: '2153925085', nickname: '小号', error: null, qr: null, ...over.login },
  }
}

const waiting = (): QqPanel => panel({
  connection: { state: 'reconnecting', attempt: 12, since: NOW - 600_000, lastError: 'socket hang up', selfId: null },
  login: { state: 'qr', uin: null, nickname: null, qr: { size: 3, rows: ['101', '010', '111'] } },
})

function mount(state: Partial<QqState>) {
  const store = createQqStore()
  store.update((draft) => { Object.assign(draft, state) })
  const refresh = vi.fn()
  const renewCode = vi.fn()
  // The shell's global standard hooks are not read by this section.
  const props = { close: () => {}, useQq: bindSnapshotSelector(store), refresh, renewCode, t } as QqLoginProps
  const element = () => <QqLoginSection {...props} />
  const view = render(element())
  return { store, refresh, renewCode, view, rerender: () => { view.rerender(element()) } }
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
})
