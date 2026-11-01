import { describe, expect, it } from 'vitest'
import {
  currentStep, failureReason, lateWindowEnd, parseHealth, parseTasks, planReminders, planSyncNotice, renderReminders,
  renderSyncFailing, renderSyncRecovered, reminderKey, span, stamp, upcoming, type SyncHealth, type TaskSummary,
} from '../src/index.ts'

const ZONE = 'America/New_York'
const H = 3_600_000
/** 2026-11-02 12:00 EST. */
const NOW = Date.parse('2026-11-02T12:00:00-05:00')
const RULES = { beforeHours: [72, 24, 6, 2], lateBeforeHours: [24, 6, 2] }

function task(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: 'fall-x-hw1', version: 3, title: 'Homework 1', courseId: 'fall-x', course: 'Example Course', parentId: null, parentTitle: null,
    partsDone: null, partsTotal: null, dueAt: NOW + 5 * H, lateAt: null, closesAt: null, certainty: 'confirmed', progress: 'not_started',
    percent: null, submission: 'not_submitted', submissionVerified: true, remainingWork: null, checkedAt: NOW - 24 * H, links: [],
    ...overrides,
  }
}

const OK: SyncHealth = { status: 'ok', latestRunAt: NOW - H, lastCleanAt: NOW - H, failedRuns: 0, latestRunId: 'run-1' }

describe('reminder steps', () => {
  it('picks the smallest checkpoint already crossed, keyed by phase, task, deadline, and checkpoint', () => {
    const step = currentStep(task({ dueAt: NOW + 5 * H }), NOW, RULES)
    expect(step).toEqual({ key: reminderKey('due', 'fall-x-hw1', NOW + 5 * H, 6), phase: 'due', checkpoint: 6, deadline: NOW + 5 * H })
    expect(step?.key).toBe(`due|fall-x-hw1|${new Date(NOW + 5 * H).toISOString()}|6`)
    expect(currentStep(task({ dueAt: NOW + 100 * H }), NOW, RULES)).toBeUndefined()
    expect(currentStep(task({ dueAt: NOW + 72 * H }), NOW, RULES)?.checkpoint).toBe(72)
  })

  it('skips submitted, completed, and undated tasks', () => {
    expect(currentStep(task({ submission: 'submitted' }), NOW, RULES)).toBeUndefined()
    expect(currentStep(task({ progress: 'completed' }), NOW, RULES)).toBeUndefined()
    expect(currentStep(task({ dueAt: null }), NOW, RULES)).toBeUndefined()
  })

  it('reports a missed deadline at once while the late window is open, then at the late checkpoints before its end', () => {
    const missed = task({ dueAt: NOW - 13 * H, lateAt: NOW + 34 * H })
    expect(currentStep(missed, NOW, RULES)).toMatchObject({ phase: 'late', checkpoint: 'open', deadline: NOW + 34 * H })
    expect(currentStep(missed, NOW + 11 * H, RULES)).toMatchObject({ phase: 'late', checkpoint: 24 })
    expect(currentStep(missed, NOW + 33 * H, RULES)).toMatchObject({ phase: 'late', checkpoint: 2 })
    expect(currentStep(missed, NOW + 35 * H, RULES)).toBeUndefined()
  })

  it('uses the earlier of late_at and closes_at that is still ahead as the end of the late window', () => {
    expect(lateWindowEnd(task({ lateAt: NOW + 2 * H, closesAt: NOW + 9 * H }), NOW)).toBe(NOW + 2 * H)
    expect(lateWindowEnd(task({ lateAt: NOW - 2 * H, closesAt: NOW + 9 * H }), NOW)).toBe(NOW + 9 * H)
    expect(lateWindowEnd(task({ lateAt: NOW - 2 * H }), NOW)).toBeNull()
  })

  it('plans only keys that were not sent, late ones first', () => {
    const tasks = [task({ id: 'a', dueAt: NOW + 20 * H }), task({ id: 'b', dueAt: NOW - H, lateAt: NOW + 30 * H }), task({ id: 'c', dueAt: NOW + 3 * H })]
    const sent = new Set([reminderKey('due', 'c', NOW + 3 * H, 6)])
    expect(planReminders(tasks, NOW, RULES, key => sent.has(key)).map(reminder => reminder.task.id)).toEqual(['b', 'a'])
  })

  it('starts over when the deadline moves', () => {
    const before = currentStep(task({ dueAt: NOW + 5 * H }), NOW, RULES)
    const moved = currentStep(task({ dueAt: NOW + 5.5 * H }), NOW, RULES)
    expect(before?.key).not.toBe(moved?.key)
  })
})

describe('reminder message', () => {
  it('lists late windows first, folds open parts into their parent, and says how to answer', () => {
    const parent = task({ id: 'hw3', title: 'Homework 3', dueAt: NOW - 13 * H, lateAt: NOW + 34 * H })
    const part = (id: string, title: string): TaskSummary => task({ id, title, parentId: 'hw3', parentTitle: 'Homework 3', dueAt: NOW - 13 * H, lateAt: NOW + 34 * H })
    const lab = task({ id: 'lab5', title: 'Lab 2', course: 'Other Course', dueAt: NOW + 5 * H, progress: 'partial', percent: 40 })
    const planned = planReminders([parent, part('hw3-w', 'Written'), part('hw3-p', 'Programming'), lab], NOW, RULES, () => false)
    const note = renderReminders(planned, { now: NOW, timeZone: ZONE, urgentWithinHours: 2, health: OK })
    expect(note.title).toBe('⚠️ 课程 DDL：1 项已过准时截止，迟交窗口还开着；另有 1 项快到截止')
    expect(note.body).toBe([
      '⚠️ 准时截止已过，迟交还来得及：',
      `• Example Course · Homework 3（还没交的部分：Written、Programming） — 准时截止 ${stamp(NOW - 13 * H, ZONE)} 已过，迟交截止 ${stamp(NOW + 34 * H, ZONE)}，还剩 34 小时`,
      '',
      '⏰ 快到截止：',
      `• Other Course · Lab 2 — ${stamp(NOW + 5 * H, ZONE)} 截止，还剩 5 小时，进度：做了一部分 40%`,
      '',
      '交了或做完了直接告诉我，我来更新记录。',
    ].join('\n'))
    expect(note.kinds).toEqual(['courses.deadline.late', 'courses.deadline.due'])
    expect(note.urgent).toBe(false)
  })

  it('names the parent of a part reminded alone, marks tentative dates, and is urgent near the deadline', () => {
    const part = task({ id: 'p', title: 'Written', parentId: 'gone', parentTitle: 'Homework 9', dueAt: NOW + 1.5 * H, certainty: 'tentative' })
    const planned = planReminders([part], NOW, RULES, () => false)
    const note = renderReminders(planned, { now: NOW, timeZone: ZONE, urgentWithinHours: 2, health: null })
    expect(note.body).toContain(`• Example Course · Homework 9 · Written — ${stamp(NOW + 1.5 * H, ZONE)} 截止（日期待确认），还剩 1 小时`)
    expect(note.urgent).toBe(true)
    expect(renderReminders(planned, { now: NOW, timeZone: ZONE, urgentWithinHours: 0, health: null }).urgent).toBe(false)
  })

  it('says how old the records may be when the sync is not healthy', () => {
    const health: SyncHealth = { status: 'failing', latestRunAt: NOW - H, lastCleanAt: Date.parse('2026-10-28T18:16:00-04:00'), failedRuns: 14, latestRunId: 'run-9' }
    const planned = planReminders([task()], NOW, RULES, () => false)
    const note = renderReminders(planned, { now: NOW, timeZone: ZONE, urgentWithinHours: 2, health })
    expect(note.body).toContain('（课程记录可能过时：最近一次成功同步在 10/28 周三 18:16，之后 14 次同步失败；新作业和提交状态可能没更新。）')
  })
})

describe('time labels', () => {
  it('writes New York wall time and the time left', () => {
    expect(stamp(Date.parse('2026-11-02T22:00:00-05:00'), ZONE)).toBe('11/2 周一 22:00')
    expect(span(30 * 60_000)).toBe('不到 1 小时')
    expect(span(47 * H + 59 * 60_000)).toBe('47 小时')
    expect(span(50 * H)).toBe('2 天 2 小时')
    expect(span(72 * H)).toBe('3 天')
    expect(span(-1)).toBe('已过')
  })
})

describe('upcoming list', () => {
  it('shows each open deadline with the next checkpoint, soonest first', () => {
    const rows = upcoming([task({ id: 'far', dueAt: NOW + 100 * H }), task({ id: 'late', dueAt: NOW - H, lateAt: NOW + 3 * H }), task({ id: 'done', submission: 'submitted' })], NOW, RULES, 10)
    expect(rows.map(row => [row.task.id, row.phase, row.deadline, row.nextAt])).toEqual([
      ['late', 'late', NOW + 3 * H, NOW + H],
      ['far', 'due', NOW + 100 * H, NOW + 28 * H],
    ])
  })
})

describe('sync alert', () => {
  const rules = { statuses: ['failing', 'missing'], staleHours: 24, repeatHours: 24 }
  const failing: SyncHealth = { status: 'failing', latestRunAt: NOW - H, lastCleanAt: NOW - 30 * H, failedRuns: 4, latestRunId: 'run-4' }
  const idle = { active: false, alertedAt: null, cleanAt: null }

  it('alerts once the sync has been broken for staleHours, then at most every repeatHours', () => {
    expect(planSyncNotice({ ...failing, lastCleanAt: NOW - 10 * H }, NOW, idle, rules)).toBeNull()
    expect(planSyncNotice(failing, NOW, idle, rules)).toBe('failing')
    const alerted = { active: true, alertedAt: NOW, cleanAt: failing.lastCleanAt }
    expect(planSyncNotice(failing, NOW + 23 * H, alerted, rules)).toBeNull()
    expect(planSyncNotice(failing, NOW + 24 * H, alerted, rules)).toBe('failing')
  })

  it('tells the recovery once, on a clean run or a status that no longer counts as broken', () => {
    const alerted = { active: true, alertedAt: NOW, cleanAt: failing.lastCleanAt }
    expect(planSyncNotice({ ...failing, status: 'ok', lastCleanAt: NOW + H }, NOW + 2 * H, alerted, rules)).toBe('recovered')
    expect(planSyncNotice({ ...failing, lastCleanAt: NOW + H }, NOW + 2 * H, alerted, rules)).toBe('recovered')
    expect(planSyncNotice({ ...failing, status: 'ok' }, NOW, idle, rules)).toBeNull()
    expect(planSyncNotice({ ...failing, status: 'degraded' }, NOW, idle, rules)).toBeNull()
  })

  it('names the last clean sync, the failures since, and the reason', () => {
    const note = renderSyncFailing(failing, 'Built-in browser unavailable', NOW, ZONE)
    expect(note.title).toBe('⚠️ 课程同步已经 30 小时没成功了')
    expect(note.body).toBe([
      `最近一次成功同步：${stamp(NOW - 30 * H, ZONE)}。`,
      `之后失败 4 次，最近一次在 ${stamp(NOW - H, ZONE)}。`,
      '原因：Built-in browser unavailable',
      'DDL 提醒照旧按现有记录发，但新作业和提交状态可能没更新。',
    ].join('\n'))
    expect(renderSyncRecovered({ ...failing, lastCleanAt: NOW }, ZONE)).toEqual({ title: '✅ 课程同步恢复了', body: `${stamp(NOW, ZONE)} 同步成功，课程记录又能更新了。`, kinds: ['courses.sync.recovered'], urgent: false })
  })
})

describe('wire parsing', () => {
  it('reads task summaries, skipping other kinds, with times as epoch milliseconds', () => {
    const [row] = parseTasks([
      { kind: 'memo', id: 'm' },
      {
        kind: 'task', id: 't', version: 2, title: 'Lab', course_name: 'Example Course — CS-UY 0000 A', due_at: '2026-11-02T23:59:00-05:00',
        late_at: null, deadline_certainty: 'confirmed', progress_status: 'partial', submission_status: 'not_submitted', submission_verified: true,
        last_checked_at: null, updated_at: '2026-11-01T10:00:00Z', source_links: [{ label: 'Page', url: 'https://example.edu/x', kind: 'source' }], extra: 1,
      },
    ])
    expect(row).toMatchObject({ id: 't', course: 'Example Course', dueAt: Date.parse('2026-11-02T23:59:00-05:00'), lateAt: null, checkedAt: Date.parse('2026-11-01T10:00:00Z'), links: [{ label: 'Page', url: 'https://example.edu/x' }] })
    expect(() => parseTasks([{ kind: 'task', id: 't', title: 'no version' }])).toThrow()
  })

  it('reads the sync health and the newest run id', () => {
    expect(parseHealth({ health: { status: 'failing', latest_run_at: '2026-11-01T14:01:58Z', last_clean_run_at: '2026-10-28T22:16:34.979Z', failed_runs_since_clean: 14 }, items: [{ id: 'run-x' }] }))
      .toEqual({ status: 'failing', latestRunAt: Date.parse('2026-11-01T14:01:58Z'), lastCleanAt: Date.parse('2026-10-28T22:16:34.979Z'), failedRuns: 14, latestRunId: 'run-x' })
    expect(parseHealth(undefined).status).toBe('missing')
  })

  it('takes a failed entry\'s detail before a not-checked one, without the course prefix, cut to 160 characters', () => {
    const record = { data: { coverage: [
      { area: 'announcements', status: 'not_checked', detail: 'fall-x: Browser is not available.' },
      { area: 'content', status: 'failed', detail: `fall-y: ${'x'.repeat(300)}` },
    ] } }
    const reason = failureReason(record)
    expect(reason?.startsWith('xxx')).toBe(true)
    expect(Array.from(reason ?? '').length).toBe(160)
    expect(failureReason({ data: { coverage: [{ status: 'not_checked', detail: 'fall-x: Browser is not available.' }] } })).toBe('Browser is not available.')
    expect(failureReason({ data: { coverage: [{ status: 'checked' }] } })).toBeNull()
    expect(failureReason(null)).toBeNull()
  })
})
