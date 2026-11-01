// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { PresenceAnswer, PresenceView } from '../src/view.ts'
import { agoText } from '../src/client/format.ts'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'
import { POLL_INTERVAL_MS, PresenceLoader, createPresenceStore, parseAnswer, startPolling, type PresenceState } from '../src/client/presence.ts'
import { PresenceSection, type PresenceProps } from '../src/client/PresenceSection.tsx'

const t = makeTranslate(zh) as PresenceProps['t']
const NOW = Date.parse('2026-11-03T10:00:00Z')

const VIEW: PresenceView = {
  asleep: true,
  source: 'focus',
  since: Date.parse('2026-11-03T04:10:00Z'),
  until: Date.parse('2026-11-03T18:10:00Z'),
  manual: null,
  lastFocus: { asleep: true, at: NOW - 6 * 3_600_000 },
  window: { enabled: true, start: '03:30', end: '10:30' },
  deferred: 3,
  urgentKinds: ['host.disk.full', 'bili.risk.*'],
  shortcut: {
    url: 'https://dsh.example/hooks/lsy',
    path: '/hooks/lsy',
    header: 'Authorization',
    tokenEnv: 'LSY_INGEST_TOKEN_PRESENCE',
    bodyOn: '{"kind":"presence.sleep.on","key":"<date>","subject":"owner","title":"Sleep Focus on"}',
    bodyOff: '{"kind":"presence.sleep.off","key":"<date>","subject":"owner","title":"Sleep Focus off"}',
  },
  timeZone: 'America/New_York',
}
const AWAKE: PresenceView = { ...VIEW, asleep: false, source: 'window', since: null, until: null, lastFocus: null, deferred: 0 }

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
  it('shows asleep with its source, times, held count, and the latest Focus signal', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    mount({ view: VIEW, checkedAt: NOW })
    const hero = screen.getByRole('region', { name: '现在' })
    expect(hero.textContent).toContain('睡眠中')
    expect(hero.textContent).toContain('来源：手机的睡眠专注')
    expect(hero.textContent).toContain('自 11-02 23:10')
    expect(hero.textContent).toContain('约 11-03 13:10 结束')
    expect(hero.textContent).toContain('3 条消息在等你醒来')
    expect(hero.textContent).toContain('最近一次 Focus 信号：6 小时前（睡眠专注开启）')
  })

  it('shows awake from the window, with nothing held and a nudge to set up the Shortcut', () => {
    mount({ view: AWAKE, checkedAt: NOW })
    const hero = screen.getByRole('region', { name: '现在' })
    expect(hero.textContent).toContain('醒着')
    expect(hero.textContent).toContain('来源：每日时段')
    expect(hero.textContent).toContain('没有被压下的消息')
    expect(hero.textContent).toContain('还没收到过 Focus 信号')
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

describe('PresenceSection Shortcut and urgent kinds', () => {
  it('lists the urgent kinds and where to change them', () => {
    mount({ view: VIEW, checkedAt: NOW })
    const card = screen.getByRole('region', { name: '紧急事件' })
    expect(within(card).getAllByRole('listitem').map(item => item.textContent)).toEqual(['host.disk.full', 'bili.risk.*'])
    expect(card.textContent).toContain('urgentKinds')
  })

  it('gives the exact URL, header, token variable name, both bodies, and seven steps, and never a token', () => {
    mount({ view: VIEW, checkedAt: NOW })
    const card = screen.getByRole('region', { name: 'iPhone 快捷指令' })
    expect(card.textContent).toContain('https://dsh.example/hooks/lsy')
    expect(card.textContent).toContain('Authorization: Bearer …')
    expect(card.textContent).toContain('LSY_INGEST_TOKEN_PRESENCE')
    expect(card.textContent).toContain('Content-Type = application/json')
    expect(card.textContent).toContain(VIEW.shortcut.bodyOn)
    expect(card.textContent).toContain(VIEW.shortcut.bodyOff)
    expect(within(card).getAllByRole('listitem')).toHaveLength(7)
    expect(card.textContent).toContain('创建个人自动化')
    expect(card.textContent).toContain('只勾「已开启」')
    expect(card.textContent).toContain('只勾「已关闭」')
    expect(card.textContent).toContain('立即运行')
    expect(card.textContent).toContain('最近一次 Focus 信号')
  })

  it('says where the address goes when the deployment does not name it', () => {
    mount({ view: { ...VIEW, shortcut: { ...VIEW.shortcut, url: null } }, checkedAt: NOW })
    expect(screen.getByRole('region', { name: 'iPhone 快捷指令' }).textContent).toContain('你的 DSH 地址 + /hooks/lsy')
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
})

describe('helpers', () => {
  it('checks the answer fields', () => {
    expect(() => parseAnswer({})).toThrow('unexpected quiet-hours answer')
    expect(() => parseAnswer({ view: { ...VIEW, window: null }, flushed: null })).toThrow('unexpected quiet-hours answer')
    const ok = answer(VIEW)
    expect(parseAnswer(ok)).toBe(ok)
    expect(agoText(NOW - 30_000, NOW, t as never)).toBe('30 秒前')
    expect(agoText(NOW - 3 * 86_400_000, NOW, t as never)).toBe('3 天前')
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
})
