// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createCoursesStore, type CoursesState } from '../src/client/courses.ts'
import { CoursesSection, type CoursesProps } from '../src/client/CoursesSection.tsx'
import { zh } from '../src/client/locales.ts'
import type { CoursesView } from '../src/view.ts'

const t = makeTranslate(zh) as CoursesProps['t']
const AT = Date.parse('2026-11-02T22:00:00-05:00')

const VIEW: CoursesView = {
  enabled: true, timeZone: 'America/New_York', beforeHours: [24, 2], lateBeforeHours: [6], urgentWithinHours: 2,
  quietHours: { followPresence: true, enabled: false, start: '01:00', end: '09:00' }, quietNow: true,
  lastPoll: { at: AT, trigger: 'timer', durationMs: 5, ok: true, error: null, openTasks: 3, reminders: 1, outcome: 'sent' },
  nextPollAt: AT + 900_000, polling: false,
  sync: { status: 'failing', latestRunAt: AT, lastCleanAt: AT - 3_600_000, failedRuns: 2, reason: null, alerting: false },
  outage: { failures: 0, since: null, alerted: false },
  upcoming: [{ id: 'a', course: 'Example Course', title: 'Lab 2', phase: 'due', deadline: AT + 7_200_000, nextAt: AT + 3_600_000 }],
  notes: [{ at: AT, title: '⏰ 课程 DDL 提醒：1 项快到截止', body: '• Example Course · Lab 2', outcome: 'failed', error: 'no channel' }],
}

function mount(state: Partial<CoursesState>, renderFactorySlot?: CoursesProps['renderFactorySlot']) {
  const store = createCoursesStore()
  store.update((draft) => { Object.assign(draft, state) })
  const refresh = vi.fn()
  const checkNow = vi.fn()
  const props = { close: () => {}, useCourses: bindSnapshotSelector(store), refresh, checkNow, t, renderFactorySlot } as CoursesProps
  render(<CoursesSection {...props} />)
  return { refresh, checkNow }
}

afterEach(() => { cleanup() })

describe('CoursesSection', () => {
  it('shows loading, then the cards, and ends with the All settings card of fork-courses', () => {
    const factory = vi.fn((_name: string, _props: object) => <div data-testid="plugin-config" />)
    const { refresh } = mount({}, factory as never)
    expect(screen.getByRole('status').textContent).toBe('正在读取…')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledWith('settings.plugin-config', { entries: ['fork-courses'] })
    cleanup()
    const { checkNow } = mount({ view: VIEW }, factory as never)
    expect(screen.getByRole('status').textContent).toBe('提醒开着现在是静默时段')
    expect(screen.getByText('上次检查 11/2 22:00：3 项未完成，发出 1 条提醒')).toBeTruthy()
    expect(screen.getByText('失败：最近一次成功 11/2 21:00，之后失败 2 次')).toBeTruthy()
    expect(screen.getByText('Example Course · Lab 2')).toBeTruthy()
    expect(screen.getByText('下次提醒 11/2 23:00')).toBeTruthy()
    expect(screen.getByText('没发出去：no channel')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '立即检查' }))
    expect(checkNow).toHaveBeenCalledTimes(1)
  })

  it('disables the button while a check runs', () => {
    mount({ view: VIEW, checking: true })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '正在检查…' }).disabled).toBe(true)
  })
})
