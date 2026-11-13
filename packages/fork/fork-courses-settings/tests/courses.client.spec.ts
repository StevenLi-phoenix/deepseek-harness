import { describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { CoursesLoader, clock, createCoursesStore, parseView, pollLine, ruleLines, syncLines, upcomingText, type Translate } from '../src/client/courses.ts'
import { en, zh } from '../src/client/locales.ts'
import { startPolling } from '../src/client/polling.ts'
import type { CoursesView } from '../src/view.ts'

const t = makeTranslate(zh) as Translate
const ZONE = 'America/New_York'
const AT = Date.parse('2026-11-02T22:00:00-05:00')

const VIEW: CoursesView = {
  enabled: true, timeZone: ZONE, beforeHours: [72, 24, 6, 2], lateBeforeHours: [24, 6, 2], urgentWithinHours: 2,
  quietHours: { followPresence: true, enabled: true, start: '01:00', end: '09:00' }, quietNow: false,
  lastPoll: null, nextPollAt: null, polling: false, sync: null,
  outage: { failures: 0, since: null, alerted: false }, upcoming: [], notes: [],
}

describe('course deadline section text', () => {
  it('writes times in the view\'s zone', () => {
    expect(clock(AT, ZONE)).toBe('11/2 22:00')
  })

  it('says what the last check did', () => {
    expect(pollLine(null, ZONE, t)).toBe('还没有检查过')
    expect(pollLine({ at: AT, trigger: 'timer', durationMs: 1, ok: true, error: null, openTasks: 8, reminders: 2, outcome: 'held' }, ZONE, t)).toBe('上次检查 11/2 22:00：8 项未完成，2 条提醒等静默时段结束再发')
    expect(pollLine({ at: AT, trigger: 'manual', durationMs: 1, ok: false, error: 'HTTP 500', openTasks: null, reminders: null, outcome: null }, ZONE, t)).toBe('上次检查 11/2 22:00 失败：HTTP 500')
  })

  it('describes a broken sync with the last sync, the reason, and that the owner was told', () => {
    expect(syncLines({ status: 'failing', latestRunAt: AT, lastSyncedAt: AT - 86_400_000, failedSinceSynced: 14, reason: 'Browser is not available', alerting: true }, ZONE, t)).toEqual({
      tone: 'warn',
      lines: ['失败：最近一次成功 11/1 22:00，之后失败 14 次', '最近一次的原因：Browser is not available', '已经告诉主人；一直失败的话每天最多再提醒一次，恢复时会说'],
    })
    expect(syncLines({ status: 'ok', latestRunAt: AT, lastSyncedAt: AT, failedSinceSynced: 0, reason: null, alerting: false }, ZONE, t).tone).toBe('ok')
    expect(syncLines(null, ZONE, t)).toEqual({ tone: 'idle', lines: ['还没读到同步状态'] })
  })

  it('lists the rules and the upcoming rows', () => {
    expect(ruleLines(VIEW, t)).toEqual(['截止前 72 / 24 / 6 / 2 小时各提醒一次', '错过准时截止立即提醒，迟交截止前 24 / 6 / 2 小时再提醒', '主人睡觉时（勿扰页）先不发', '每天 01:00–09:00 先不发', '离截止不到 2 小时的提醒不等静默时段', '时间按 America/New_York'])
    expect(upcomingText({ id: 'x', course: 'C', title: 'T', phase: 'late', deadline: AT, nextAt: null }, ZONE, t)).toEqual({ when: '已过准时截止，迟交截止 11/2 22:00', next: '这个截止的提醒都发过了' })
  })

  it('words every outcome of a successful check, with zero counts when the poll gives none', () => {
    const poll = (outcome: string | null, extra: object = {}) => pollLine({ at: AT, trigger: 'timer', durationMs: 1, ok: true, error: null, openTasks: null, reminders: null, outcome: outcome as never, ...extra }, ZONE, t)
    expect(poll('sent', { reminders: 2, openTasks: 5 })).toBe('上次检查 11/2 22:00：5 项未完成，发出 2 条提醒')
    expect(poll('failed', { reminders: 1 })).toContain(t('result.failed', { count: 1 }))
    expect(poll('disabled')).toContain(t('result.disabled'))
    expect(poll(null)).toContain(t('result.none'))
    expect(poll('held')).toContain('0 条提醒')
    expect(poll(null)).toContain('0 项未完成')
  })

  it('writes a failed check with an empty error when none was recorded', () => {
    expect(pollLine({ at: AT, trigger: 'timer', durationMs: 1, ok: false, error: null, openTasks: null, reminders: null, outcome: null }, ZONE, t)).toBe('上次检查 11/2 22:00 失败：')
  })

  it('describes a sync that never ran clean, with a status the page has no copy for, and no reason', () => {
    const unknown = syncLines({ status: 'weird', latestRunAt: null, lastSyncedAt: null, failedSinceSynced: 1, reason: null, alerting: false }, ZONE, t)
    expect(unknown.tone).toBe('warn')
    expect(unknown.lines).toEqual([t('sync.broken', { status: 'weird', synced: t('sync.never'), count: 1 })])
    expect(syncLines({ status: 'degraded', latestRunAt: null, lastSyncedAt: null, failedSinceSynced: 0, reason: null, alerting: false }, ZONE, t).lines[0]).toContain(t('sync.status.degraded'))
    expect(syncLines({ status: 'ok', latestRunAt: null, lastSyncedAt: null, failedSinceSynced: 0, reason: null, alerting: false }, ZONE, t).lines).toEqual([t('sync.ok', { time: '—' })])
  })

  it('lists no quiet-hours rule when neither is on and turns the urgent rule off at 0 hours', () => {
    const lines = ruleLines({ ...VIEW, quietHours: { followPresence: false, enabled: false, start: '01:00', end: '09:00' }, urgentWithinHours: 0 }, t)
    expect(lines).toEqual([t('rules.before', { hours: '72 / 24 / 6 / 2' }), t('rules.late', { hours: '24 / 6 / 2' }), t('rules.urgentOff'), t('rules.zone', { zone: ZONE })])
  })

  it('words an on-time row with its next reminder', () => {
    expect(upcomingText({ id: 'x', course: 'C', title: 'T', phase: 'due', deadline: AT, nextAt: AT + 3_600_000 }, ZONE, t))
      .toEqual({ when: t('upcoming.due', { time: '11/2 22:00' }), next: t('upcoming.next', { time: '11/2 23:00' }) })
  })

  it('refuses answers whose outer fields are the wrong type', () => {
    expect(() => parseView(null)).toThrow('unexpected course deadline answer')
    const ok = { enabled: true, upcoming: [], notes: [], timeZone: 'UTC' }
    expect(parseView(ok)).toBe(ok)
    for (const bad of [{ ...ok, enabled: 'yes' }, { ...ok, upcoming: {} }, { ...ok, notes: null }, { ...ok, timeZone: 5 }]) {
      expect(() => parseView(bad)).toThrow('unexpected course deadline answer')
    }
  })

  it('has the same keys in every dictionary', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

describe('loader', () => {
  it('keeps the last answer through a failed read and replaces it with a check\'s answer', async () => {
    const store = createCoursesStore()
    let fail = false
    const read = vi.fn(async () => { if (fail) throw new Error('down'); return VIEW })
    const check = vi.fn(async () => ({ ...VIEW, polling: true }))
    const loader = new CoursesLoader(store, read, check)
    await Promise.all([loader.refresh(), loader.refresh()])
    expect(read).toHaveBeenCalledTimes(1)
    fail = true
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await loader.refresh()
    expect(store.getSnapshot()).toMatchObject({ view: VIEW, stale: true })
    await loader.checkNow()
    expect(store.getSnapshot()).toMatchObject({ view: { polling: true }, stale: false, checking: false })
    expect(() => parseView({})).toThrow('unexpected course deadline answer')
  })

  it('does not warn again while the reading stays stale, and a second check while one runs does nothing', async () => {
    const store = createCoursesStore()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    warn.mockClear()
    const gate = Promise.withResolvers<CoursesView>()
    const check = vi.fn(() => gate.promise)
    const loader = new CoursesLoader(store, async () => { throw new Error('down') }, check)
    await loader.refresh()
    await loader.refresh()
    expect(warn).toHaveBeenCalledTimes(1)
    const first = loader.checkNow()
    await loader.checkNow()
    expect(check).toHaveBeenCalledTimes(1)
    gate.resolve(VIEW)
    await first
    expect(store.getSnapshot()).toMatchObject({ view: VIEW, stale: false, checking: false })
    warn.mockRestore()
  })

  it('does not start a second timer when a visible page fires visibilitychange, and polls without a page', () => {
    vi.useFakeTimers()
    try {
      const listeners: Array<() => void> = []
      const page = { visibilityState: 'visible' as DocumentVisibilityState, addEventListener: (_: 'visibilitychange', listener: () => void) => { listeners.push(listener) }, removeEventListener: vi.fn() }
      const refresh = vi.fn()
      const stop = startPolling(refresh, 1000, page)
      listeners[0]?.()
      expect(refresh).toHaveBeenCalledTimes(1)
      page.visibilityState = 'hidden'
      listeners[0]?.()
      listeners[0]?.()
      page.visibilityState = 'visible'
      listeners[0]?.()
      expect(refresh).toHaveBeenCalledTimes(2)
      stop()
      expect(page.removeEventListener).toHaveBeenCalledTimes(1)
      const bare = vi.fn()
      const stopBare = startPolling(bare, 1000, null)
      vi.advanceTimersByTime(1000)
      expect(bare).toHaveBeenCalledTimes(2)
      stopBare()
      vi.advanceTimersByTime(3000)
      expect(bare).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('polls straight away and on the interval when the runtime has no document', () => {
    vi.useFakeTimers()
    try {
      const refresh = vi.fn()
      const stop = startPolling(refresh, 1000)
      vi.advanceTimersByTime(2000)
      expect(refresh).toHaveBeenCalledTimes(3)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('polls while visible and stops when hidden', () => {
    vi.useFakeTimers()
    const listeners: Array<() => void> = []
    const page = { visibilityState: 'visible' as DocumentVisibilityState, addEventListener: (_: 'visibilitychange', listener: () => void) => { listeners.push(listener) }, removeEventListener: vi.fn() }
    const refresh = vi.fn()
    const stop = startPolling(refresh, 1000, page)
    vi.advanceTimersByTime(2000)
    expect(refresh).toHaveBeenCalledTimes(3)
    page.visibilityState = 'hidden'
    listeners[0]?.()
    vi.advanceTimersByTime(5000)
    expect(refresh).toHaveBeenCalledTimes(3)
    stop()
    vi.useRealTimers()
  })
})
