/**
 * The two write tools. They carry the record's `expected_version` and a `request_id`; the building of the request lives
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
    description: 'Record the owner\'s own progress on one course task, from what the owner told you: status, optionally a percent the owner gave, the work done and left, and named parts. It never changes the submission status, which only the platform sync records: when the owner says they submitted, set status completed and say the platform status will confirm it on the next sync. Read the task with courses_get first and pass its version as expected_version; a conflict answer means it changed meanwhile. A task done in parts takes its progress from its parts: update the parts instead (the error names them). Deadline reminders stop for a completed task.',
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
