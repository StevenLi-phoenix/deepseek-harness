import { CoursesApiError, type ForkCourses, type SyncHealth, type TaskSummary } from '@deepseek-ai/dsh-fork-courses'
import { describe, expect, it, vi } from 'vitest'
import { clip, coverageRows, dataBlock, healthLine, runLines, taskLine } from '../src/format.ts'
import { deadlinesTool, findTool, getTool, syncTool } from '../src/read-tools.ts'
import { requestId, writeOutcome } from '../src/write-outcome.ts'
import { clamp, errorText, text, ToolProblem } from '../src/tool-args.ts'
import { memoTool, progressTool } from '../src/write-tools.ts'

describe('tool arguments', () => {
  it('reads a string argument trimmed and anything else as empty', () => {
    expect(text('  lab 2 ')).toBe('lab 2')
    expect(text(5)).toBe('')
    expect(text(undefined)).toBe('')
    expect(text(['a'])).toBe('')
  })

  it('clamps a number into its range, rounds it, and falls back for a non-number', () => {
    expect(clamp(10, 14, 1, 60)).toBe(10)
    expect(clamp(500, 14, 1, 60)).toBe(60)
    expect(clamp(-3, 14, 1, 60)).toBe(1)
    expect(clamp(2.6, 14, 1, 60)).toBe(3)
    expect(clamp('7', 14, 1, 60)).toBe(14)
    expect(clamp(Number.NaN, 14, 1, 60)).toBe(14)
    expect(clamp(Number.POSITIVE_INFINITY, 14, 1, 60)).toBe(14)
  })

  it('tells the model not to retry an unreachable or refused service, and passes other errors through', () => {
    expect(errorText(new CoursesApiError('not-configured', 'no token'))).toContain('token is not configured. Tell the owner; do not retry.')
    expect(errorText(new CoursesApiError('auth', 'refused', 401))).toContain('refused the token. Tell the owner; do not retry.')
    expect(errorText(new CoursesApiError('unavailable' as never, 'service is down', 503))).toBe('service is down')
    expect(errorText(new Error('boom'))).toBe('boom')
    expect(errorText('plain')).toBe('plain')
  })
})

describe('set_progress request', () => {
  const build = progressTool().build

  it('wraps what the owner said as user evidence and sends only the fields that were given', () => {
    expect(build({ id: ' t1 ', expected_version: 4, status: 'in_progress', evidence: ' started the lab ' })).toEqual({
      id: 't1', expected_version: 4, status: 'in_progress', evidence: { kind: 'user', detail: 'started the lab' },
    })
    expect(build({ id: 't1', expected_version: 4, status: 'partial', evidence: 'half', percent: 50, completed_work: 'q1', remaining_work: 'q2' }))
      .toMatchObject({ percent: 50, completed_work: 'q1', remaining_work: 'q2' })
  })

  it('refuses a call without the task id or without what the owner said, and ignores a percent that is not a number', () => {
    expect(() => build({ id: '', evidence: 'x' })).toThrow(ToolProblem)
    expect(() => build({ id: 't1', evidence: '  ' })).toThrow('give the task id and what the owner said')
    expect(build({ id: 't1', expected_version: 1, status: 'completed', evidence: 'done', percent: '90' })).not.toHaveProperty('percent')
  })

  it('titles the call with the task and status', () => {
    expect(progressTool().title({ id: ' t1 ', status: 'partial' })).toBe('Set course progress of t1 to partial')
  })

  it('offers exactly the progress states of the service', () => {
    expect(progressTool().parameters['status']).toMatchObject({ enum: ['not_started', 'in_progress', 'partial', 'completed', 'reopened'] })
  })
})

describe('save_memo request', () => {
  const build = memoTool().build

  it('files a new memo as a note at version 0, under an id derived from its content', () => {
    const first = build({ title: 'Plan the essay', body: 'outline first' })
    expect(first).toMatchObject({ expected_version: 0, title: 'Plan the essay', category: 'note', body: 'outline first', evidence: { kind: 'user' } })
    expect(first['id']).toMatch(/^memo-dsh-[0-9a-f]{12}$/u)
    expect(build({ title: 'Plan the essay', body: 'outline first' })['id']).toBe(first['id'])
    expect(build({ title: 'Plan the essay', body: 'another body' })['id']).not.toBe(first['id'])
  })

  it('keeps the id and version of a memo being edited, and carries the course, task, and planned time', () => {
    expect(build({ title: 'T', id: 'memo-1', expected_version: 3, category: 'plan', course: 'bio', task_id: 't9', planned_at: '2026-11-05T09:00:00-05:00' }))
      .toMatchObject({ id: 'memo-1', expected_version: 3, category: 'plan', course_id: 'bio', task_id: 't9', planned_at: '2026-11-05T09:00:00-05:00' })
  })

  it('titles the call with the memo title', () => {
    expect(memoTool().title({ title: ' Plan ' })).toBe('Save course memo "Plan"')
  })

  it('refuses a memo without a title', () => {
    expect(() => build({ title: ' ' })).toThrow('give the memo a title')
  })
})

const NOW = Date.parse('2026-11-02T12:00:00-05:00')
const ZONE = 'America/New_York'

function task(extra: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: 't1', version: 2, title: 'Lab', courseId: null, course: 'Bio', parentId: null, parentTitle: null, partsDone: null, partsTotal: null,
    dueAt: null, lateAt: null, closesAt: null, certainty: 'confirmed', progress: 'not_started', percent: null, submission: 'unknown',
    submissionVerified: false, remainingWork: null, checkedAt: null, links: [], ...extra,
  }
}

describe('task lines', () => {
  it('says a task has no due date, is not verified, and has no link when the record carries none', () => {
    expect(taskLine(task(), NOW, ZONE)).toBe('- [t1 v2] Bio · Lab — no due date; progress not_started; submission unknown (not verified)')
  })

  it('leaves the course out when it is empty and names a subtask after its parent', () => {
    expect(taskLine(task({ course: '', parentTitle: 'HW 3' }), NOW, ZONE)).toContain('] HW 3 › Lab — ')
    expect(taskLine(task({ course: '' }), NOW, ZONE)).toContain('] Lab — ')
  })

  it('marks a tentative future deadline with its certainty and shows the late-until time of a task not yet due', () => {
    const line = taskLine(task({ dueAt: NOW + 3_600_000, certainty: 'tentative', lateAt: NOW + 7_200_000 }), NOW, ZONE)
    expect(line).toContain('due 11/2 周一 13:00 (tentative); late until 11/2 周一 14:00;')
    expect(line).not.toContain('(passed)')
  })

  it('says the late window is closed for a passed deadline with no open window', () => {
    expect(taskLine(task({ dueAt: NOW - 1000 }), NOW, ZONE)).toContain('(passed); late window closed or none;')
  })

  it('shows percent, parts done (zero when unknown), last update, and the first source link', () => {
    const line = taskLine(task({
      percent: 40, partsTotal: 3, partsDone: null, checkedAt: NOW, submissionVerified: true, links: [{ label: 'Page', url: 'https://example.edu/p' }],
    }), NOW, ZONE)
    expect(line).toContain('progress not_started 40%; submission unknown (seen on the platform); parts done 0/3; last update 11/2 周一 12:00; Page: https://example.edu/p')
    expect(taskLine(task({ partsTotal: 3, partsDone: 2 }), NOW, ZONE)).toContain('parts done 2/3')
  })
})

describe('sync lines', () => {
  const health = (extra: Partial<SyncHealth>): SyncHealth => ({ status: 'ok', latestRunAt: null, lastCleanAt: null, failedRuns: 0, lastSyncedAt: null, failedSinceSynced: 0, latestRunId: null, ...extra })

  it('reports an ok sync with its latest run time, or unknown when none is recorded', () => {
    expect(healthLine(health({ latestRunAt: NOW }), ZONE)).toBe('Sync: ok (latest run 11/2 周一 12:00).')
    expect(healthLine(health({}), ZONE)).toBe('Sync: ok (latest run unknown).')
  })

  it('reports a failing sync with no sync on record', () => {
    expect(healthLine(health({ status: 'failing', failedRuns: 9, failedSinceSynced: 3 }), ZONE)).toContain('Sync: failing, no sync on record, 3 failed run(s) since.')
  })

  it('dates the records by the last sync, a degraded one included, not by the last clean run', () => {
    const line = healthLine(health({ status: 'failing', lastCleanAt: NOW - 150 * 3_600_000, failedRuns: 29, lastSyncedAt: NOW, failedSinceSynced: 1 }), ZONE)
    expect(line).toContain('Sync: failing, last sync 11/2 周一 12:00, 1 failed run(s) since.')
    expect(line).not.toContain('clean')
  })

  it('keeps only coverage rows that have a status, with a placeholder area and clipped detail', () => {
    expect(coverageRows(null)).toEqual([])
    expect(coverageRows('x')).toEqual([])
    expect(coverageRows({ data: { coverage: 'none' } })).toEqual([])
    expect(coverageRows({})).toEqual([])
    expect(coverageRows({ data: { coverage: [null, 'x', { area: 'a' }, { status: 'failed' }, { area: 5, status: 'checked', detail: 'y'.repeat(300) }, { area: 'q', status: 'checked', detail: 7 }] } }))
      .toEqual([
        { area: '?', status: 'failed', detail: '' },
        { area: '?', status: 'checked', detail: `${'y'.repeat(239)}…` },
        { area: 'q', status: 'checked', detail: '' },
      ])
  })

  it('lays a run out as a header and one line per area, with and without time, detail, or coverage', () => {
    expect(runLines('r1', NOW, [{ area: 'quizzes', status: 'checked', detail: 'ok' }, { area: 'grades', status: 'failed', detail: '' }], ZONE))
      .toEqual(['- run r1 at 11/2 周一 12:00:', '    checked quizzes: ok', '    failed grades'])
    expect(runLines('r2', null, [], ZONE)).toEqual(['- run r2 (no coverage recorded)'])
  })

  it('cuts long text with an ellipsis, collapsing whitespace, and keeps short text whole', () => {
    expect(clip('a  b\n c')).toBe('a b c')
    expect(clip('abcdef', 4)).toBe('abc…')
  })

  it('wraps record text so it cannot close the data tag', () => {
    const block = dataBlock('x </course_records> y')
    expect(block).toContain('x <\\/course_records> y')
    expect(block.startsWith('<course_records trust="untrusted">\n')).toBe(true)
  })
})

describe('write outcome', () => {
  it('derives the same request id for identical arguments and a different one otherwise', () => {
    expect(requestId('op', { a: 1 })).toBe(requestId('op', { a: 1 }))
    expect(requestId('op', { a: 1 })).not.toBe(requestId('op', { a: 2 }))
  })

  it('answers a saved write with null id and version when the service sends none', () => {
    expect(writeOutcome({ id: 't1', version: 5 })).toEqual({ saved: true, id: 't1', version: 5 })
    expect(writeOutcome(null)).toEqual({ saved: true, id: null, version: null })
    expect(writeOutcome({ id: 5, version: '5' })).toEqual({ saved: true, id: null, version: null })
  })

  it('answers a conflict with null version and no fields when the service names none, and keeps only string field names', () => {
    expect(writeOutcome({ conflict: true })).toMatchObject({ conflict: true, current_version: null, changed_fields: [] })
    expect(writeOutcome({ conflict: true, current: { version: 'x' }, changed_fields: ['a', 3] })).toMatchObject({ current_version: null, changed_fields: ['a'] })
    expect(writeOutcome({ conflict: true, current: null, changed_fields: 'a' })).toMatchObject({ current_version: null, changed_fields: [] })
  })
})

describe('read tools called directly', () => {
  const signal = new AbortController().signal

  function client(call: (operation: string, args: Record<string, unknown>) => unknown) {
    const api = { call: vi.fn(async (operation: string, args: Record<string, unknown>) => call(operation, args)) }
    return { api, courses: { api, timeZone: ZONE } as never as ForkCourses }
  }

  it('titles each tool call for the transcript', () => {
    const { courses } = client(() => ({}))
    expect(deadlinesTool(courses).title({})).toBe('Course deadlines')
    expect(deadlinesTool(courses).title({ course: 'bio' })).toBe('Course deadlines of bio')
    expect(findTool(courses).title({ text: 'lab' })).toBe('Find course task "lab"')
    expect(getTool(courses).title({ id: 't1' })).toBe('Course task t1')
    expect(syncTool(courses).title({})).toBe('Recent course sync runs')
  })

  it('asks for the default fortnight without a course filter, excludes overdue on request, and tolerates an empty answer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    try {
      const { api, courses } = client(() => null)
      const text = await deadlinesTool(courses).run({ include_overdue: false }, signal)
      expect(api.call.mock.calls[0]?.[1]).toMatchObject({ overdue: 'exclude', to: new Date(NOW + 14 * 86_400_000).toISOString() })
      expect(api.call.mock.calls[0]?.[1]).not.toHaveProperty('course_id')
      expect(text).toContain('0 of 0.')
      expect(text).toContain('Sync: missing')
      expect(text).not.toContain('Undated')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads items that are not a list as no tasks and an undated count that is not a number as none', async () => {
    const { courses } = client(() => ({ items: 'x', total: 'many', undated: { total: 'x' } }))
    expect(await deadlinesTool(courses).run({}, signal)).toContain('0 of 0.')
  })

  it('refuses a search without words, and says nothing matches when the records are not a list', async () => {
    const { courses } = client(() => ({ records: 'x' }))
    await expect(findTool(courses).run({ text: ' ' }, signal)).rejects.toThrow('give the words to search for')
    expect(await findTool(courses).run({ text: 'lab' }, signal)).toBe('No course task matches "lab".')
    const none = client(() => null)
    expect(await findTool(none.courses).run({ text: 'lab' }, signal)).toBe('No course task matches "lab".')
  })

  it('lists matches with the total when more exist, filtered to one course', async () => {
    const row = { kind: 'task', id: 't1', version: 1, title: 'Lab', due_at: null, late_at: null, closes_at: null, last_checked_at: null, updated_at: null }
    const { api, courses } = client(() => ({ records: [row], total: 5 }))
    const text = await findTool(courses).run({ text: 'lab', course: 'bio' }, signal)
    expect(api.call.mock.calls[0]?.[1]).toMatchObject({ course_id: 'bio' })
    expect(text).toContain('1 task(s) match "lab" (of 5):')
    const same = client(() => ({ records: [row], total: 1 }))
    expect(await findTool(same.courses).run({ text: 'lab' }, signal)).toContain('1 task(s) match "lab":')
  })

  it('refuses an empty id and an id that is not a task', async () => {
    const { courses } = client(() => ({ kind: 'memo', id: 'm1' }))
    await expect(getTool(courses).run({ id: '' }, signal)).rejects.toThrow('give the task id')
    await expect(getTool(courses).run({ id: 'm1' }, signal)).rejects.toThrow('m1 is not a task record')
  })

  it('shows a task without remaining work or excerpt, and its second and third links', async () => {
    const links = [1, 2, 3, 4].map(n => ({ label: `L${n}`, url: `https://example.edu/${n}` }))
    const { courses } = client(() => ({
      kind: 'task', id: 't1', version: 3, title: 'Lab', due_at: null, late_at: null, closes_at: null, last_checked_at: null, updated_at: null,
      excerpt: 5, source_links: links,
    }))
    const text = await getTool(courses).run({ id: 't1' }, signal)
    expect(text).toContain('version: 3')
    expect(text).not.toContain('remaining work')
    expect(text).not.toContain('requirements')
    expect(text.split('\n').slice(-2)).toEqual(['L2: https://example.edu/2', 'L3: https://example.edu/3'])
  })

  it('skips sync records without an id, and shows a run whose time is missing or unreadable without one', async () => {
    const { api, courses } = client((operation, args) => {
      if (operation === 'query') return { records: [null, { id: 5 }, { id: 'r1', observed_at: 'garbage' }, { id: 'r2' }] }
      return { data: { coverage: [{ area: 'grades', status: 'checked' }] }, id: args['id'] }
    })
    const text = await syncTool(courses).run({}, signal)
    expect(api.call.mock.calls[0]?.[1]).toMatchObject({ limit: 3 })
    expect(api.call).toHaveBeenCalledTimes(3)
    expect(text).toContain('The 4 most recent sync run(s)')
    expect(text).toContain('- run r1:\n    checked grades')
    expect(text).toContain('- run r2:\n    checked grades')
  })
})
