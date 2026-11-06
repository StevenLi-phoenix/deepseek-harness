import { CoursesApiError } from '@deepseek-ai/dsh-lsy-courses'
import { describe, expect, it } from 'vitest'
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

  it('refuses a memo without a title', () => {
    expect(() => build({ title: ' ' })).toThrow('give the memo a title')
  })
})
