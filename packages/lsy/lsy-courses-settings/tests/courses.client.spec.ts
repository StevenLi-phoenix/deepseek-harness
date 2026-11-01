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

  it('describes a broken sync with the last clean run, the reason, and that the owner was told', () => {
    expect(syncLines({ status: 'failing', latestRunAt: AT, lastCleanAt: AT - 86_400_000, failedRuns: 14, reason: 'Browser is not available', alerting: true }, ZONE, t)).toEqual({
      tone: 'warn',
      lines: ['失败：最近一次成功 11/1 22:00，之后失败 14 次', '最近一次的原因：Browser is not available', '已经告诉主人；一直失败的话每天最多再提醒一次，恢复时会说'],
    })
    expect(syncLines({ status: 'ok', latestRunAt: AT, lastCleanAt: AT, failedRuns: 0, reason: null, alerting: false }, ZONE, t).tone).toBe('ok')
    expect(syncLines(null, ZONE, t)).toEqual({ tone: 'idle', lines: ['还没读到同步状态'] })
  })

  it('lists the rules and the upcoming rows', () => {
    expect(ruleLines(VIEW, t)).toEqual(['截止前 72 / 24 / 6 / 2 小时各提醒一次', '错过准时截止立即提醒，迟交截止前 24 / 6 / 2 小时再提醒', '主人睡觉时（勿扰页）先不发', '每天 01:00–09:00 先不发', '离截止不到 2 小时的提醒不等静默时段', '时间按 America/New_York'])
    expect(upcomingText({ id: 'x', course: 'C', title: 'T', phase: 'late', deadline: AT, nextAt: null }, ZONE, t)).toEqual({ when: '已过准时截止，迟交截止 11/2 22:00', next: '这个截止的提醒都发过了' })
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
