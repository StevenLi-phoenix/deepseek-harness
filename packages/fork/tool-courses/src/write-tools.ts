/**
 * The write tools: the owner's progress and memos, and what the agent itself read on a platform page. They carry
 * the record's `expected_version` and a `request_id`; the building of the request lives
 * here, the sending and the outcome in `register.ts`.
 */

import { createHash } from 'node:crypto'
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { text, ToolProblem } from './tool-args.ts'

const PROGRESS = ['not_started', 'in_progress', 'partial', 'completed', 'reopened'] as const
const MEMO_CATEGORIES = ['idea', 'plan', 'question', 'decision', 'note'] as const

/** A write tool: its text for the model and how its arguments become the service request. */
export interface WriteSpec {
  name: string
  operation: string
  description: string
  parameters: ParameterSchemaSpec
  title: (args: Record<string, unknown>) => string
  build: (args: Record<string, unknown>) => Record<string, unknown>
}

/**
 * Define `courses_set_progress`, the write of the owner's progress on one task.
 * @returns the tool's name, operation, description, parameters, title, and `build`, which makes the request body and throws
 *   `ToolProblem` without an id or evidence.
 */
export function progressTool(): WriteSpec {
  return {
    name: 'courses_set_progress',
    operation: 'set_progress',
    description: 'Record the owner\'s own progress on one course task, from what the owner told you: status, optionally a percent the owner gave, the work done and left, and named parts. It never changes the submission status, which comes only from a platform page read (the sync\'s, or your own saved with courses_observe): when the owner says they submitted, set status completed and say the platform status will confirm it when the page is next read. Read the task with courses_get first and pass its version as expected_version; a conflict answer means it changed meanwhile. A task done in parts takes its progress from its parts: update the parts instead (the error names them). Deadline reminders stop for a completed task.',
    parameters: {
      id: { type: 'string', required: true, description: 'The task id.' },
      expected_version: { type: 'integer', required: true, description: 'The version courses_get showed.' },
      status: { type: 'string', required: true, enum: [...PROGRESS], description: 'not_started, in_progress, partial, completed, or reopened.' },
      evidence: { type: 'string', required: true, description: 'What the owner said, briefly, in their words (kept with the record as the reason).' },
      percent: { type: 'number', description: 'Only a percent the owner stated; never estimate one.' },
      completed_work: { type: 'string', description: 'What is done.' },
      remaining_work: { type: 'string', description: 'What is left.' },
      request_id: { type: 'string', description: 'Leave it out: the tool derives one, the same for an identical retry.' },
    },
    title: args => `Set course progress of ${text(args['id'])} to ${text(args['status'])}`,
    build: (args) => {
      const id = text(args['id'])
      const evidence = text(args['evidence'])
      if (id === '' || evidence === '') throw new ToolProblem('give the task id and what the owner said')
      return {
        id,
        expected_version: args['expected_version'],
        status: text(args['status']),
        evidence: { kind: 'user', detail: evidence },
        ...typeof args['percent'] === 'number' ? { percent: args['percent'] } : {},
        ...text(args['completed_work']) === '' ? {} : { completed_work: text(args['completed_work']) },
        ...text(args['remaining_work']) === '' ? {} : { remaining_work: text(args['remaining_work']) },
      }
    },
  }
}

/**
 * Define `courses_save_memo`, the write of a note for the owner's courses.
 * @returns the tool's name, operation, description, parameters, title, and `build`, which makes the request body and throws
 *   `ToolProblem` without a title.
 */
export function memoTool(): WriteSpec {
  return {
    name: 'courses_save_memo',
    operation: 'save_memo',
    description: 'Keep a note for the owner\'s courses: an idea, plan, question, decision, or note, optionally tied to a course or a task, with an optional personal planned time (not a deadline). Never write a guess that a date is old or wrong into a memo: record what the owner said and what courses_sync shows, as separate facts. A new memo uses expected_version 0 and no id; to edit one, pass its id and current version.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short title.' },
      body: { type: 'string', description: 'The note.' },
      category: { type: 'string', enum: [...MEMO_CATEGORIES], description: 'idea, plan, question, decision, or note (default note).' },
      course: { type: 'string', description: 'Course id or short name.' },
      task_id: { type: 'string', description: 'Task id.' },
      planned_at: { type: 'string', description: 'When the owner plans to do it, ISO 8601 with offset.' },
      id: { type: 'string', description: 'An existing memo to edit.' },
      expected_version: { type: 'integer', description: '0 for a new memo (default); the current version to edit one.' },
      request_id: { type: 'string', description: 'Leave it out: the tool derives one, the same for an identical retry.' },
    },
    title: args => `Save course memo "${text(args['title'])}"`,
    build: (args) => {
      const title = text(args['title'])
      if (title === '') throw new ToolProblem('give the memo a title')
      const fields = {
        title,
        category: text(args['category']) === '' ? 'note' : text(args['category']),
        ...text(args['body']) === '' ? {} : { body: text(args['body']) },
        ...text(args['course']) === '' ? {} : { course_id: text(args['course']) },
        ...text(args['task_id']) === '' ? {} : { task_id: text(args['task_id']) },
        ...text(args['planned_at']) === '' ? {} : { planned_at: text(args['planned_at']) },
      }
      const id = text(args['id']) === '' ? `memo-dsh-${createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 12)}` : text(args['id'])
      return { id, expected_version: typeof args['expected_version'] === 'number' ? args['expected_version'] : 0, evidence: { kind: 'user', detail: 'The owner asked DSH to keep this note.' }, ...fields }
    },
  }
}

const SUBMISSION = ['unknown', 'not_submitted', 'submitted'] as const
const CERTAINTY = ['confirmed', 'tentative', 'unknown'] as const
/** The areas a sync run reports on, as the courses service names them. */
export const SYNC_AREAS = ['announcements', 'assignments', 'quizzes', 'discussions', 'content', 'gradescope', 'grades', 'materials'] as const

/** The current minute in UTC: an identical retry within the minute derives the same request id. */
function minute(now: Date): string {
  return `${now.toISOString().slice(0, 16)}:00Z`
}

/** The platform a page belongs to, named as a collector would. */
function platformOf(url: string): string {
  const host = (() => {
    try {
      return new URL(url).hostname
    } catch {
      return ''
    }
  })()
  if (host.endsWith('gradescope.com')) return 'Gradescope'
  if (host.startsWith('brightspace.')) return 'Brightspace'
  return host === '' ? 'platform' : host
}

/** A model-supplied list of strings, trimmed, empties dropped. */
function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(item => item !== '') : []
}

/**
 * The files and links an observation hands over, each with a title and where it is or what it says.
 * @param value - the model's `materials` argument.
 * @returns the materials without empty fields.
 * @throws `ToolProblem` for an entry without a title, or with neither a url nor content.
 */
function materials(value: unknown): Record<string, string>[] {
  if (!Array.isArray(value)) return []
  return (value as Record<string, unknown>[]).map((fields) => {
    const title = text(fields['title'])
    const url = text(fields['url'])
    const content = text(fields['content'])
    if (title === '' || (url === '' && content === '')) throw new ToolProblem('each material needs a title and a url or content')
    return { title, ...url === '' ? {} : { url }, ...content === '' ? {} : { content } }
  })
}

/**
 * Define `courses_observe`, the write of what the agent itself read on a course platform page for one task: its dates,
 * certainty, submission status, or a task the records lack.
 * @param now - the clock; observed_at is its minute.
 * @returns the tool's name, operation, description, parameters, title, and `build`, which makes the request body and throws
 *   `ToolProblem` without a page, without what it showed, without a fact to save, or for a new task without course, title
 *   and due date.
 */
export function observeTool(now: () => Date = () => new Date()): WriteSpec {
  return {
    name: 'courses_observe',
    operation: 'save_task_observation',
    description: 'Save what you yourself read on a course platform page (Brightspace, Gradescope) in this turn for one task: its due date, late date, deadline certainty, submission status, requirements, materials, date warning, or a task the records lack. Only what the page showed: never what the owner told you (that is courses_set_progress), never a guess. To update a task, read it with courses_get and pass its id and version, and send only the fields that differ from the record; the others keep their saved values. When a date changes, also compare the saved requirements and date_warning: send the page\'s current requirements, and replace the warning or clear it with "none", so no earlier text keeps contradicting the new date. Before adding a task, search with courses_find by a short title word, because record titles can differ from the platform\'s ("Homework 5" for "Homework Assignment 5"); only when it is really absent pass expected_version 0 with course, title, and due_at ("none" when the page shows no date). Unchanged tasks are not rewritten: list them in courses_record_sync checked_ids.',
    parameters: {
      id: { type: 'string', description: 'The task id from courses_get. Leave it out for a new task: one is derived.' },
      expected_version: { type: 'integer', required: true, description: 'The version courses_get showed; 0 for a new task.' },
      url: { type: 'string', required: true, description: 'The page you read it on: the assignment list or the assignment itself.' },
      observed: { type: 'string', required: true, description: 'What the page showed, briefly and in its own words, e.g. "Due on Nov 28, 2026 11:59 PM · 1 Submission, 1 File".' },
      course: { type: 'string', description: 'Course id or short name; required for a new task.' },
      title: { type: 'string', description: 'The platform title; required for a new task.' },
      due_at: { type: 'string', description: 'Due date as ISO 8601 with offset (New York time, e.g. 2026-11-28T23:59:00-05:00); "none" when the page shows no date.' },
      late_at: { type: 'string', description: 'Last date late work is accepted, ISO 8601 with offset.' },
      deadline_certainty: { type: 'string', enum: [...CERTAINTY], description: 'confirmed when the page states the date; tentative when it says the date may change.' },
      submission_status: { type: 'string', enum: [...SUBMISSION], description: 'submitted when the page shows a submission (e.g. "1 Submission"); not_submitted when it shows none.' },
      requirements: { type: 'string', description: 'The assignment\'s instructions and deliverables as the platform words them; replaces the saved text. Leave it out when unchanged or when the page shows none.' },
      materials: {
        type: 'array',
        description: 'Files and links the assignment hands out, added to the ones already saved (none is removed).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true, description: 'File name or link text.' },
            url: { type: 'string', description: 'Where it is on the platform.' },
            content: { type: 'string', description: 'The text itself, when it is text you read.' },
          },
        },
      },
      date_warning: { type: 'string', description: 'What is still uncertain or conflicting about the dates; replaces the saved warning. "none" removes a warning the page no longer supports.' },
    },
    title: args => `Save what the platform showed for ${text(args['id']) === '' ? `"${text(args['title'])}"` : text(args['id'])}`,
    build: (args) => {
      const url = text(args['url'])
      const observed = text(args['observed'])
      if (url === '' || observed === '') throw new ToolProblem('give the page url and what it showed')
      const version = typeof args['expected_version'] === 'number' ? args['expected_version'] : -1
      if (version < 0) throw new ToolProblem('give expected_version: the version courses_get showed, or 0 for a new task')
      const fresh = version === 0
      const course = text(args['course'])
      const title = text(args['title'])
      const handed = materials(args['materials'])
      const facts: Record<string, unknown> = {
        ...text(args['due_at']).toLowerCase() === 'none' ? { due_at: null } : text(args['due_at']) === '' ? {} : { due_at: text(args['due_at']) },
        ...text(args['late_at']) === '' ? {} : { late_at: text(args['late_at']) },
        ...text(args['deadline_certainty']) === '' ? {} : { deadline_certainty: text(args['deadline_certainty']) },
        ...text(args['submission_status']) === '' ? {} : { submission: { status: text(args['submission_status']), platform: platformOf(url) } },
        ...text(args['requirements']) === '' ? {} : { requirements: text(args['requirements']) },
        ...handed.length === 0 ? {} : { materials: handed },
        ...text(args['date_warning']).toLowerCase() === 'none' ? { date_warning: null } : text(args['date_warning']) === '' ? {} : { date_warning: text(args['date_warning']) },
      }
      if (fresh) {
        if (course === '' || title === '' || !('due_at' in facts)) throw new ToolProblem('a new task needs course, title, and due_at ("none" when the page shows no date)')
      } else if (Object.keys(facts).length === 0 && title === '') {
        throw new ToolProblem('nothing to save: send the fields that differ from the record; a task you found unchanged goes into courses_record_sync checked_ids')
      }
      const given = text(args['id'])
      if (!fresh && given === '') throw new ToolProblem('give the task id to update, or expected_version 0 for a new task')
      const id = given === '' ? `task-dsh-${createHash('sha256').update(JSON.stringify({ course, title })).digest('hex').slice(0, 12)}` : given
      return {
        id,
        expected_version: version,
        ...fresh ? { course_id: course, category: 'assignment', source_url: url } : {},
        ...course !== '' && !fresh ? { course_id: course } : {},
        ...title === '' ? {} : { title },
        ...facts,
        evidence: { kind: 'platform', detail: observed, url, observed_at: minute(now()) },
      }
    },
  }
}

/**
 * Define `courses_record_sync`, the record of one platform reading run: what was read, what failed, and the tasks found
 * unchanged.
 * @param now - the clock; the run's id and observed_at are its minute.
 * @returns the tool's name, operation, description, parameters, title, and `build`, which makes the request body and throws
 *   `ToolProblem` without a detail, without any checked or failed area, or with checked areas but no page url.
 */
export function syncRunTool(now: () => Date = () => new Date()): WriteSpec {
  return {
    name: 'courses_record_sync',
    operation: 'record_sync',
    description: 'Close one course-platform reading run, once at its end, also when it failed: which areas you read (checked), which you tried and could not read (failed), and in checked_ids every task you compared with the page and found unchanged. The records then show when they were last read, and the sync health counts the run. It saves nothing about the tasks themselves: save each change with courses_observe first.',
    parameters: {
      detail: { type: 'string', required: true, description: 'What this run read or where it broke: the courses and pages, e.g. "Assignments lists of PT, GD, HCI, ML, DP, ELS, TCH; 41 tasks compared, 2 saved".' },
      checked: { type: 'array', items: { type: 'string', enum: [...SYNC_AREAS] }, description: 'Areas you read in full: announcements, assignments, quizzes, discussions, content, gradescope, grades, materials.' },
      failed: { type: 'array', items: { type: 'string', enum: [...SYNC_AREAS] }, description: 'Areas you tried and could not read.' },
      checked_ids: { type: 'array', items: { type: 'string' }, description: 'Task ids you compared with the page and found unchanged (at most 500).' },
      url: { type: 'string', description: 'The main page you read, e.g. the course home; required when an area was checked.' },
      scope: { type: 'string', description: '"all" (default), a course id or short name, or a task id.' },
    },
    title: args => `Record a course sync run (${list(args['checked']).join(', ') || 'nothing read'})`,
    build: (args) => {
      const detail = text(args['detail'])
      const checked = new Set(list(args['checked']))
      const failed = new Set(list(args['failed']))
      const url = text(args['url'])
      if (detail === '') throw new ToolProblem('give the run\'s detail: what it read or where it broke')
      if (checked.size === 0 && failed.size === 0) throw new ToolProblem('name the areas you read (checked) or tried and could not read (failed)')
      if (checked.size > 0 && url === '') throw new ToolProblem('give the url of the page you read')
      const at = now()
      const scope = text(args['scope']) === '' ? 'all' : text(args['scope'])
      const stamp = at.toISOString().slice(0, 16).replace(/[-:]/gu, '')
      const ids = list(args['checked_ids']).slice(0, 500)
      return {
        id: `sync-dsh-${scope.replace(/[^\w-]/gu, '-')}-${stamp}Z`,
        expected_version: 0,
        scope,
        ...ids.length === 0 ? {} : { checked_ids: ids },
        coverage: SYNC_AREAS.map(area => ({
          area,
          status: checked.has(area) ? 'checked' : failed.has(area) ? 'failed' : 'not_checked',
          detail: checked.has(area) || failed.has(area) ? detail : 'Not read by DSH in this run.',
        })),
        evidence: checked.size > 0
          ? { kind: 'platform', detail, url, observed_at: minute(at) }
          : { kind: 'inference', detail, observed_at: minute(at) },
      }
    },
  }
}
