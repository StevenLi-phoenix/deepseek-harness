// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { BiliView } from '../src/view.ts'
import { BiliLoader, createBiliStore, parseView, type BiliState } from '../src/client/bili.ts'
import { BiliAccountSection, type BiliAccountProps } from '../src/client/BiliAccount.tsx'
import { agoText, countdown, qrPath, usageLevel } from '../src/client/format.ts'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh) as BiliAccountProps['t']
const NOW = Date.parse('2026-10-23T18:00:00Z')

const VIEW: BiliView = {
  account: { state: 'active', mid: 3_000_001, uname: '看客', level: 2, loggedInAt: NOW - 86_400_000, refreshedAt: NOW - 7_200_000 },
  login: { state: 'idle' },
  pause: null,
  readsResumeAt: null,
  usage: { day: '2026-10-23', actions: [
    { action: 'like', used: 30, cap: 30 }, { action: 'comment', used: 1, cap: 3 }, { action: 'favorite', used: 16, cap: 20 },
  ] },
  interests: { text: '猫和天文', updatedAt: null },
  clock: {
    timeZone: 'America/New_York',
    today: [{ window: '12:00–14:00', at: Date.parse('2026-10-23T17:00:00Z'), state: 'done' }, { window: '19:30–23:30', at: null, state: 'skipped' }],
    nextWakeAt: null,
    lastWake: { at: NOW - 3_600_000, reason: 'clock' },
  },
  recent: [
    { at: NOW - 600_000, action: 'comment', target: 'BV1aa4y1X7aa', state: 'accepted', visibility: 'hidden' },
    { at: NOW - 1_200_000, action: 'like', target: 'BV1bb4y1X7bb', state: 'uncertain', detail: 'the outcome is unknown' },
  ],
  ownerMid: 200000001,
}

function mount(state: Partial<BiliState>) {
  const store = createBiliStore()
  store.update((draft) => { Object.assign(draft, state) })
  const refresh = vi.fn()
  const actions: unknown[] = []
  const act = (action: unknown): void => { actions.push(action) }
  const props = { close: () => {}, useBili: bindSnapshotSelector(store), refresh, act, t } as BiliAccountProps
  const view = render(<BiliAccountSection {...props} />)
  return { store, refresh, actions, view }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('BiliAccountSection', () => {
  it('shows the account, budget bars, body clock, interests, and recent writes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    mount({ view: VIEW, checkedAt: NOW })
    const hero = screen.getByRole('region', { name: '账号' })
    expect(hero.textContent).toContain('看客')
    expect(hero.textContent).toContain('Lv2')
    expect(hero.textContent).toContain('在线')
    expect(hero.textContent).toContain('UID 3000001')
    expect(hero.textContent).toContain('Cookie 2 小时前刷新')
    expect(screen.getByRole('button', { name: '重新登录' })).toBeTruthy()
    const meters = screen.getAllByRole('meter')
    expect(meters.map(meter => [meter.getAttribute('aria-label'), meter.getAttribute('aria-valuenow'), meter.firstElementChild!.getAttribute('data-level')]))
      .toEqual([['点赞', '30', 'full'], ['评论', '1', 'normal'], ['收藏', '16', 'warn']])
    const clock = screen.getByRole('region', { name: '作息' })
    expect(clock.textContent).toContain('13:00')
    expect(clock.textContent).toContain('今天跳过')
    expect(clock.textContent).toContain('今天没有更多醒来的安排')
    expect(clock.textContent).toContain('上次醒来：1 小时前（作息）')
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('猫和天文')
    const recent = screen.getByRole('region', { name: '最近的写操作' })
    expect(recent.textContent).toContain('可能被隐藏')
    expect(recent.textContent).toContain('结果不明')
    expect(recent.textContent).toContain('the outcome is unknown')
  })

  it('renders the QR code with steps, polls faster while it waits, and starts a login', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const waiting: BiliView = { ...VIEW, account: { state: 'signed-out' }, login: { state: 'waiting', qr: { modules: ['111', '101', '111'], expiresAt: NOW + 150_000 } } }
    const { refresh } = mount({ view: waiting, checkedAt: NOW })
    const qr = screen.getByRole('img', { name: '登录二维码' })
    expect(qr.getAttribute('viewBox')).toBe('0 0 3 3')
    expect(qr.querySelector('path')!.getAttribute('d')).toBe(qrPath(['111', '101', '111']))
    expect(screen.getByText('用 App 扫一扫这个二维码')).toBeTruthy()
    expect(screen.getByText('等待扫码…')).toBeTruthy()
    expect(screen.getByText('2:30 后过期')).toBeTruthy()
    expect(refresh).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(2000) })
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(screen.getByText('2:28 后过期')).toBeTruthy()
    cleanup()
    const signedOut = mount({ view: { ...VIEW, account: { state: 'signed-out' } }, checkedAt: NOW })
    fireEvent.click(screen.getByRole('button', { name: '扫码登录' }))
    expect(signedOut.actions).toEqual([{ action: 'login' }])
  })

  it('shows a pause with its reason and the owner\'s Resume', () => {
    const paused: BiliView = { ...VIEW, pause: { scope: 'all', reason: 'HTTP 412', since: NOW }, readsResumeAt: NOW + 1_800_000 }
    const { actions } = mount({ view: paused, checkedAt: NOW })
    const banner = screen.getByRole('alert')
    expect(banner.getAttribute('data-scope')).toBe('all')
    expect(banner.textContent).toContain('所有写操作已暂停')
    expect(banner.textContent).toContain('HTTP 412')
    expect(banner.textContent).toContain('dsh 自己无法解除暂停')
    fireEvent.click(screen.getByRole('button', { name: '恢复' }))
    expect(actions).toEqual([{ action: 'resume' }])
  })

  it('saves edited interests and asks for a renewed login', () => {
    const { actions } = mount({ view: { ...VIEW, account: { ...VIEW.account, state: 'login-needed', reason: 'expired' } }, checkedAt: NOW })
    expect(screen.getByText('需要重新登录')).toBeTruthy()
    expect(screen.getByText('原因：expired')).toBeTruthy()
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '猫、天文、老电影' } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    fireEvent.click(screen.getByRole('button', { name: '扫码续上登录' }))
    expect(actions).toEqual([{ action: 'interests', text: '猫、天文、老电影' }, { action: 'login' }])
  })

  it('says when the status cannot be read', () => {
    mount({ checkedAt: NOW, stale: true })
    expect(screen.getByRole('status').textContent).toBe('暂时读不到账号状态，稍后自动重试。')
  })
})

describe('BiliLoader', () => {
  it('shares one read, keeps the last view through failures, and posts actions', async () => {
    const store = createBiliStore()
    const read = vi.fn<() => Promise<BiliView>>(() => Promise.resolve(VIEW))
    const post = vi.fn((_action: unknown) => Promise.resolve({ ...VIEW, interests: { text: 'x', updatedAt: 1 } }))
    const loader = new BiliLoader(store, read, post, () => 42)
    await Promise.all([loader.refresh(), loader.refresh()])
    expect(read).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toMatchObject({ view: VIEW, checkedAt: 42, stale: false })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    read.mockRejectedValueOnce(new Error('offline'))
    await loader.refresh()
    expect(store.getSnapshot()).toMatchObject({ view: VIEW, stale: true })
    await loader.act({ action: 'interests', text: 'x' })
    expect(store.getSnapshot()).toMatchObject({ view: { interests: { text: 'x' } }, stale: false, busy: null, error: null })
    post.mockRejectedValueOnce(new Error('text must be a string'))
    await loader.act({ action: 'resume' })
    expect(store.getSnapshot().error).toBe('text must be a string')
    vi.restoreAllMocks()
  })

  it('checks the answer shape and formats times', () => {
    expect(() => parseView({})).toThrow('unexpected Bilibili account answer')
    expect(parseView(VIEW)).toBe(VIEW)
    expect(countdown(NOW + 61_000, NOW)).toBe('1:01')
    expect(agoText(NOW - 30_000, NOW, t as never)).toBe('刚刚')
    expect(agoText(NOW - 3 * 86_400_000, NOW, t as never)).toBe('3 天前')
    expect(usageLevel(0, 0)).toBe('full')
  })
})
