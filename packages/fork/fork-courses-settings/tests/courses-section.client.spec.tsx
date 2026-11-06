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

  it('says the read failed when nothing was ever loaded', () => {
    mount({ stale: true })
    expect(screen.getByRole('status').textContent).toBe(t('status.failed'))
  })

  it('keeps the old cards under a notice when a later read failed', () => {
    mount({ view: VIEW, stale: true })
    expect(screen.getByText(t('status.failed'))).toBeTruthy()
    expect(screen.getByRole('region', { name: t('title') }).hasAttribute('data-stale')).toBe(true)
  })

  it('shows an off, quiet-free section with empty lists, no next check, and a failed last check marked as a warning', () => {
    mount({
      view: {
        ...VIEW, enabled: false, quietNow: false, nextPollAt: null, upcoming: [], notes: [], sync: null,
        lastPoll: { at: AT, trigger: 'timer', durationMs: 5, ok: false, error: 'HTTP 500', openTasks: null, reminders: null, outcome: null },
      },
    })
    expect(screen.getByRole('status').textContent).toBe(t('state.off'))
    expect(screen.getByText(t('upcoming.empty'))).toBeTruthy()
    expect(screen.getByText(t('notes.empty'))).toBeTruthy()
    expect(screen.queryByText(/下次检查/u)).toBeNull()
    expect(screen.getByText(t('sync.unknown'))).toBeTruthy()
    expect(screen.getByText('上次检查 11/2 22:00 失败：HTTP 500').closest('section')?.getAttribute('data-tone')).toBe('warn')
  })

  it('shows an outage with its start, or a dash when the start is unknown, and marks a late row and a failed note without an error', () => {
    mount({
      view: {
        ...VIEW, lastPoll: null, outage: { failures: 3, since: null, alerted: true },
        upcoming: [{ id: 'l', course: '', title: 'Essay', phase: 'late', deadline: AT, nextAt: null }],
        notes: [{ at: AT, title: 'Quiet one', body: 'b', outcome: 'sent', error: null }, { at: AT + 1, title: 'Lost', body: 'c', outcome: 'failed', error: null }],
      },
    })
    expect(screen.getByText(t('outage', { count: 3, time: '—' }))).toBeTruthy()
    const row = screen.getByText('Essay').closest('li')!
    expect(row.getAttribute('data-phase')).toBe('late')
    expect(screen.getByText('Essay').textContent).toBe('Essay')
    expect(screen.getByText(t('notes.failed', { error: '' }))).toBeTruthy()
    expect(screen.queryByText(t('notes.failed', { error: 'no channel' }))).toBeNull()
  })

  it('shows an outage with the time it started', () => {
    mount({ view: { ...VIEW, outage: { failures: 2, since: AT, alerted: false } } })
    expect(screen.getByText(t('outage', { count: 2, time: '11/2 22:00' }))).toBeTruthy()
  })

  it('shows the sync reason and the alert line of a failing sync in warning text', () => {
    mount({ view: { ...VIEW, sync: { status: 'failing', latestRunAt: AT, lastCleanAt: null, failedRuns: 4, reason: 'Browser down', alerting: true } } })
    expect(screen.getByText(t('sync.reason', { reason: 'Browser down' }))).toBeTruthy()
    expect(screen.getByText(t('sync.alerting'))).toBeTruthy()
  })

  it('shows a working button for a poll the Host runs by itself', () => {
    mount({ view: { ...VIEW, polling: true } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: t('poll.running') }).disabled).toBe(true)
  })
})
