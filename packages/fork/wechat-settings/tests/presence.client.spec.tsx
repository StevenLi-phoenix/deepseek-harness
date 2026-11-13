// @vitest-environment jsdom

import { act as flushReact, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { PresenceAnswer, PresenceView } from '../src/presence-view.ts'
import { agoText, dateTime, stampTime } from '../src/client/presence/format.ts'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/presence/locales.ts'
import { POLL_INTERVAL_MS, PresenceLoader, createPresenceStore, parseAnswer, startPolling, type PresenceState } from '../src/client/presence/presence.ts'
import { PresenceSection, type PresenceProps } from '../src/client/presence/PresenceSection.tsx'

const t = makeTranslate(zh) as PresenceProps['t']
const NOW = Date.parse('2026-11-03T10:00:00Z')

const VIEW: PresenceView = {
  asleep: true,
  source: 'focus',
  since: Date.parse('2026-11-03T04:10:00Z'),
  until: Date.parse('2026-11-03T18:10:00Z'),
  manual: null,
  lastFocus: { asleep: true, at: NOW - 60_000, since: NOW - 6 * 3_600_000, heartbeatAt: NOW - 60_000 },
  window: { enabled: true, start: '03:30', end: '10:30' },
  deferred: 3,
  urgentKinds: ['host.disk.full', 'bili.risk.*'],
  signalSilent: false,
  focusFreshHours: 2,
  timeZone: 'America/New_York',
}
const AWAKE: PresenceView = { ...VIEW, asleep: false, source: 'window', since: null, until: null, lastFocus: null, deferred: 0, signalSilent: true }

function mount(state: Partial<PresenceState>) {
  const store = createPresenceStore()
  store.update((draft) => { Object.assign(draft, state) })
  const refresh = vi.fn()
  const actions: unknown[] = []
  const act = (action: unknown): void => { actions.push(action) }
  const props = { close: () => {}, usePresence: bindSnapshotSelector(store), refresh, act, t } as PresenceProps
  const view = render(<PresenceSection {...props} />)
  return { store, refresh, actions, view }
}

const answer = (view: PresenceView, flushed: number | null = null): PresenceAnswer => ({ view, flushed })

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('PresenceSection state', () => {
  it('shows asleep with its source, times, and held count', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    mount({ view: VIEW, checkedAt: NOW })
    const hero = screen.getByRole('region', { name: '现在' })
    expect(hero.textContent).toContain('睡眠中')
    expect(hero.textContent).toContain('来源：睡眠专注模式（Mac mini 读取 iCloud 同步）')
    expect(hero.textContent).toContain('自 11-02 23:10')
    expect(hero.textContent).toContain('约 11-03 13:10 结束')
    expect(hero.textContent).toContain('3 条消息延后发送')
  })

  it('shows awake from the window, with nothing held', () => {
    mount({ view: AWAKE, checkedAt: NOW })
    const hero = screen.getByRole('region', { name: '现在' })
    expect(hero.textContent).toContain('醒着')
    expect(hero.textContent).toContain('来源：每日时段')
    expect(hero.textContent).toContain('没有延后的消息')
  })

  it('names a manual override with its end and hands the decision back', () => {
    const manual = { asleep: true, at: NOW, until: NOW + 3_600_000 }
    const { actions } = mount({ view: { ...VIEW, source: 'manual', manual }, checkedAt: NOW })
    const hero = screen.getByRole('region', { name: '现在' })
    expect(hero.textContent).toContain('手动设置中：睡眠中，约 11-03 06:00 结束')
    fireEvent.click(within(hero).getByRole('button', { name: '交还给自动判断' }))
    expect(actions).toEqual([{ action: 'manual.clear' }])
  })

  it('says when the status cannot be read, and polls while mounted', () => {
    const { refresh } = mount({ view: null, stale: true, checkedAt: NOW })
    expect(refresh).toHaveBeenCalled()
    expect(screen.getByText('暂时读不到勿扰状态，稍后自动重试。')).toBeTruthy()
  })
})

describe('PresenceSection status line', () => {
  it('says it is reading until the first answer, and draws no card', () => {
    mount({ view: null })
    expect(screen.getByText('正在读取…')).toBeTruthy()
    expect(screen.queryByRole('region', { name: '现在' })).toBeNull()
  })

  it('dates the line from the last check, or from now before any check settled', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const checked = NOW - 3_600_000
    mount({ view: VIEW, stale: true, checkedAt: checked })
    expect(screen.getByText(`未能刷新 · 显示 ${stampTime(checked)} 的数据`)).toBeTruthy()
    cleanup()
    mount({ view: VIEW, stale: true, checkedAt: null })
    expect(screen.getByText(`未能刷新 · 显示 ${stampTime(NOW)} 的数据`)).toBeTruthy()
    cleanup()
    mount({ view: VIEW, checkedAt: null })
    expect(screen.getByText(`${stampTime(NOW)} 更新`)).toBeTruthy()
  })

  it('shows a failed button', () => {
    mount({ view: VIEW, checkedAt: NOW, error: 'the window must not start and end at the same time' })
    expect(screen.getByRole('alert').textContent).toBe('操作没有完成：the window must not start and end at the same time')
  })
})

describe('PresenceSection buttons', () => {
  it('sends the buttons, and quiet-until with the chosen time', () => {
    const { actions } = mount({ view: AWAKE, checkedAt: NOW })
    const card = screen.getByRole('region', { name: '手动' })
    fireEvent.click(within(card).getByRole('button', { name: '我要睡了' }))
    fireEvent.click(within(card).getByRole('button', { name: '我醒了' }))
    fireEvent.change(within(card).getByLabelText('勿扰到'), { target: { value: '09:45' } })
    fireEvent.click(within(card).getByRole('button', { name: '设置' }))
    expect(actions).toEqual([{ action: 'sleep.now' }, { action: 'wake.now' }, { action: 'quiet.until', until: '09:45' }])
  })

  it('refuses a quiet-until time that is empty', () => {
    const { actions } = mount({ view: AWAKE, checkedAt: NOW })
    const card = screen.getByRole('region', { name: '手动' })
    fireEvent.change(within(card).getByLabelText('勿扰到'), { target: { value: '' } })
    const go = within(card).getByRole('button', { name: '设置' }) as HTMLButtonElement
    expect(go.disabled).toBe(true)
    fireEvent.click(go)
    expect(actions).toEqual([])
  })

  it('flushes with the held count, shows the result, and disables every button while one runs', () => {
    const { actions, view } = mount({ view: VIEW, checkedAt: NOW })
    fireEvent.click(screen.getByRole('button', { name: '立即发送 (3)' }))
    expect(actions).toEqual([{ action: 'flush' }])
    view.unmount()
    mount({ view: VIEW, checkedAt: NOW, busy: 'flush' })
    expect(screen.getByRole('button', { name: '正在发送…' })).toBeTruthy()
    for (const button of within(screen.getByRole('region', { name: '手动' })).getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    mount({ view: VIEW, checkedAt: NOW, flushed: 2 })
    expect(screen.getByText('已发出 2 条')).toBeTruthy()
  })
})

describe('PresenceSection window', () => {
  it('saves an edited window, and only when it changed and the ends differ', () => {
    const { actions } = mount({ view: AWAKE, checkedAt: NOW })
    const card = screen.getByRole('region', { name: '每日时段' })
    const save = within(card).getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(within(card).getByLabelText('开始'), { target: { value: '23:00' } })
    fireEvent.change(within(card).getByLabelText('结束'), { target: { value: '07:00' } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    expect(actions).toEqual([{ action: 'window.set', enabled: true, start: '23:00', end: '07:00' }])
    fireEvent.change(within(card).getByLabelText('结束'), { target: { value: '23:00' } })
    expect(card.textContent).toContain('开始和结束不能是同一时刻')
    expect(save.disabled).toBe(true)
  })

  it('turns the window off and keeps the times from being edited then', () => {
    const { actions } = mount({ view: AWAKE, checkedAt: NOW })
    const card = screen.getByRole('region', { name: '每日时段' })
    fireEvent.click(within(card).getByRole('checkbox', { name: '启用' }))
    expect(within(card).getByLabelText<HTMLInputElement>('开始').disabled).toBe(true)
    fireEvent.click(within(card).getByRole('button', { name: '保存' }))
    expect(actions).toEqual([{ action: 'window.set', enabled: false, start: '03:30', end: '10:30' }])
  })

  it('follows the stored window when it changes and the draft is untouched', () => {
    const { store } = mount({ view: AWAKE, checkedAt: NOW })
    store.update((draft) => { draft.view = { ...AWAKE, window: { enabled: true, start: '02:00', end: '09:00' } } })
    return vi.waitFor(() => { expect(screen.getByLabelText<HTMLInputElement>('开始').value).toBe('02:00') })
  })
})

describe('PresenceSection window draft', () => {
  it('keeps an edited draft when the stored window moves underneath it', () => {
    const { store, actions } = mount({ view: AWAKE, checkedAt: NOW })
    const card = screen.getByRole('region', { name: '每日时段' })
    fireEvent.change(within(card).getByLabelText('开始'), { target: { value: '23:00' } })
    flushReact(() => { store.update((draft) => { draft.view = { ...AWAKE, window: { enabled: true, start: '02:00', end: '09:00' } } }) })
    expect(within(card).getByLabelText<HTMLInputElement>('开始').value).toBe('23:00')
    expect(within(card).getByLabelText<HTMLInputElement>('结束').value).toBe('10:30')
    fireEvent.click(within(card).getByRole('button', { name: '保存' }))
    expect(actions).toEqual([{ action: 'window.set', enabled: true, start: '23:00', end: '10:30' }])
  })
})

describe('PresenceSection signal and urgent kinds', () => {
  it('lists the urgent kinds and where to change them', () => {
    mount({ view: VIEW, checkedAt: NOW })
    const card = screen.getByRole('region', { name: '紧急事件' })
    expect(within(card).getAllByRole('listitem').map(item => item.textContent)).toEqual(['host.disk.full', 'bili.risk.*'])
    expect(card.textContent).toContain('urgentKinds')
  })

  it('names the source, the latest signal with its heartbeat and when the state began, and says nothing is wrong while signals come', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    mount({ view: VIEW, checkedAt: NOW })
    const card = screen.getByRole('region', { name: '睡眠信号' })
    expect(card.textContent).toContain('Mac mini 读取 iCloud 同步的睡眠专注模式 (focus-watch)')
    expect(card.textContent).toContain('最近一次 Focus 信号：1 分钟前（睡眠专注开启）')
    expect(card.textContent).toContain('最近一次心跳：1 分钟前')
    expect(card.textContent).toContain('当前状态自 11-02 23:00')
    expect(within(card).queryByRole('status')).toBeNull()
    expect(screen.queryByText(/快捷指令|iPhone|Tailscale/)).toBeNull()
  })

  it('says the heartbeat has not come yet, and that no signal has ever come', () => {
    mount({ view: { ...VIEW, lastFocus: { asleep: false, at: NOW, since: NOW, heartbeatAt: null } }, checkedAt: NOW })
    expect(screen.getByRole('region', { name: '睡眠信号' }).textContent).toContain('还没有收到过心跳')
    cleanup()
    mount({ view: AWAKE, checkedAt: NOW })
    expect(screen.getByRole('region', { name: '睡眠信号' }).textContent).toContain('还没收到过 Focus 信号：mini 上的 focus-watch 装好后会自动开始发。')
  })

  it('tells the owner how to check the watcher when no signal has come for over an hour', () => {
    mount({ view: { ...VIEW, signalSilent: true }, checkedAt: NOW })
    const hint = within(screen.getByRole('region', { name: '睡眠信号' })).getByRole('status')
    expect(hint.textContent).toBe('focus-watch 没在发信号：在 mini 上运行 `~/.local/libexec/focus-watch/focus-watch status` 查看')
  })

  it('names the hold time of a signal in the window card', () => {
    mount({ view: { ...VIEW, focusFreshHours: 2 }, checkedAt: NOW })
    expect(screen.getByRole('region', { name: '每日时段' }).textContent).toContain('只在最近 2 小时没有收到 Focus 信号时才用它，时间按 America/New_York。')
  })
})

describe('PresenceLoader', () => {
  it('shares one read, keeps the last view through failures, and marks a button busy at once', async () => {
    const store = createPresenceStore()
    const read = vi.fn<() => Promise<PresenceAnswer>>(() => Promise.resolve(answer(VIEW)))
    const post = vi.fn((_action: unknown) => Promise.resolve(answer({ ...VIEW, asleep: false }, 2)))
    const loader = new PresenceLoader(store, read, post, () => 42)
    await Promise.all([loader.refresh(), loader.refresh()])
    expect(read).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toMatchObject({ view: VIEW, checkedAt: 42, stale: false })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    read.mockRejectedValueOnce(new Error('offline'))
    await loader.refresh()
    expect(store.getSnapshot()).toMatchObject({ view: VIEW, stale: true })
    const pending = loader.act({ action: 'flush' })
    expect(store.getSnapshot()).toMatchObject({ busy: 'flush', error: null, flushed: null })
    await pending
    expect(post).toHaveBeenCalledWith({ action: 'flush' })
    expect(store.getSnapshot()).toMatchObject({ busy: null, flushed: 2, stale: false, view: { asleep: false } })
    await loader.act({ action: 'wake.now' })
    expect(store.getSnapshot().flushed).toBe(2)
  })

  it('shows a refused button and frees the page', async () => {
    const store = createPresenceStore()
    const loader = new PresenceLoader(store, () => Promise.resolve(answer(VIEW)), () => Promise.reject(new Error('the window must not start and end at the same time')))
    await loader.act({ action: 'window.set', enabled: true, start: '04:00', end: '04:00' })
    expect(store.getSnapshot()).toMatchObject({ busy: null, error: 'the window must not start and end at the same time' })
  })

  it('shows a rejection that is not an Error as its text', async () => {
    const store = createPresenceStore()
    const loader = new PresenceLoader(store, () => Promise.resolve(answer(VIEW)), async () => { throw 'gateway said no' })
    await loader.act({ action: 'sleep.now' })
    expect(store.getSnapshot()).toMatchObject({ busy: null, error: 'gateway said no' })
  })

  it('warns once when the view goes stale, and again only after it recovered', async () => {
    const store = createPresenceStore()
    const read = vi.fn<() => Promise<PresenceAnswer>>(() => Promise.resolve(answer(VIEW)))
    const loader = new PresenceLoader(store, read, () => Promise.resolve(answer(VIEW)), () => 42)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    read.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'))
    await loader.refresh()
    await loader.refresh()
    expect(store.getSnapshot().stale).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[presence] status read failed')
    await loader.refresh()
    expect(store.getSnapshot().stale).toBe(false)
    read.mockRejectedValueOnce(new Error('offline'))
    await loader.refresh()
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('helpers', () => {
  it('checks the answer fields', () => {
    expect(() => parseAnswer({})).toThrow('unexpected quiet-hours answer')
    expect(() => parseAnswer(null)).toThrow('unexpected quiet-hours answer')
    expect(() => parseAnswer('not an object')).toThrow('unexpected quiet-hours answer')
    expect(() => parseAnswer({ view: { ...VIEW, window: null }, flushed: null })).toThrow('unexpected quiet-hours answer')
    const ok = answer(VIEW)
    expect(parseAnswer(ok)).toBe(ok)
    expect(agoText(NOW - 30_000, NOW, t as never)).toBe('30 秒前')
    expect(agoText(NOW - 3 * 86_400_000, NOW, t as never)).toBe('3 天前')
  })

  it('says how long ago in the largest whole unit', () => {
    expect(agoText(NOW - 2000, NOW, t as never)).toBe('刚刚')
    expect(agoText(NOW + 60_000, NOW, t as never)).toBe('刚刚')
    expect(agoText(NOW - 5 * 60_000, NOW, t as never)).toBe('5 分钟前')
    expect(agoText(NOW - 5 * 3_600_000, NOW, t as never)).toBe('5 小时前')
    expect(agoText(NOW - 47 * 3_600_000, NOW, t as never)).toBe('47 小时前')
    expect(agoText(NOW - 48 * 3_600_000, NOW, t as never)).toBe('2 天前')
  })

  it('dates an instant in the zone it is given, and in the local zone without one', () => {
    expect(dateTime(NOW, 'America/New_York')).toBe('11-03 05:00')
    const local = new Date(NOW)
    const pad = (value: number): string => String(value).padStart(2, '0')
    expect(dateTime(NOW)).toBe(`${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}`)
  })

  it('leaves a part blank when the formatter does not give it', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockReturnValue([{ type: 'month', value: '11' }])
    expect(dateTime(NOW, 'America/New_York')).toBe('11- :')
  })

  it('keeps every dictionary on the same keys and placeholders', () => {
    const keys = Object.keys(zh).sort()
    const holes = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/gu)].map(match => match[1]!).sort()
    const source: Record<string, string> = zh
    for (const dictionary of [en, ja, es, fr, de, ru, pt] as Array<Record<string, string>>) {
      expect(Object.keys(dictionary).sort()).toEqual(keys)
      for (const [key, text] of Object.entries(dictionary)) expect(holes(text), key).toEqual(holes(source[key] ?? ''))
    }
  })

  it('polls now and every period while visible, and pauses while hidden', () => {
    vi.useFakeTimers()
    const listeners = new Set<() => void>()
    const page = {
      visibilityState: 'visible' as DocumentVisibilityState,
      addEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.add(listener) },
      removeEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.delete(listener) },
    }
    const refresh = vi.fn()
    const stop = startPolling(refresh, POLL_INTERVAL_MS, page)
    vi.advanceTimersByTime(POLL_INTERVAL_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
    page.visibilityState = 'hidden'
    for (const listener of listeners) listener()
    vi.advanceTimersByTime(POLL_INTERVAL_MS * 3)
    expect(refresh).toHaveBeenCalledTimes(2)
    page.visibilityState = 'visible'
    for (const listener of listeners) listener()
    expect(refresh).toHaveBeenCalledTimes(3)
    stop()
    expect(listeners.size).toBe(0)
  })

  it('stays paused on a page that starts hidden, and keeps one timer through repeated events', () => {
    vi.useFakeTimers()
    const listeners = new Set<() => void>()
    const page = {
      visibilityState: 'hidden' as DocumentVisibilityState,
      addEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.add(listener) },
      removeEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.delete(listener) },
    }
    const refresh = vi.fn()
    const stop = startPolling(refresh, POLL_INTERVAL_MS, page)
    for (const listener of listeners) listener()
    vi.advanceTimersByTime(POLL_INTERVAL_MS)
    expect(refresh).not.toHaveBeenCalled()
    page.visibilityState = 'visible'
    for (const listener of listeners) listener()
    for (const listener of listeners) listener()
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(POLL_INTERVAL_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
    stop()
    vi.advanceTimersByTime(POLL_INTERVAL_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
