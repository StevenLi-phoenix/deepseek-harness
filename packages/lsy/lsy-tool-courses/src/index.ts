/**
 * Course tools for the owner's main agent, over `ctx.lsyCourses` (the courses service): what is due, a search, one
 * record, and two writes, `courses_set_progress` and `courses_save_memo`. Reads return one line per task with only
 * what answering the owner needs; record text comes from course pages and is wrapped as untrusted data. Writes
 * carry the record's `expected_version` and a `request_id` that stays the same when the identical write is retried,
 * so a lost answer cannot apply it twice. Facts, progress, and submission stay apart as the service keeps them: the
 * agent writes the owner's progress and notes; the submission status comes only from the platform sync.
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { CoursesApiError, parseHealth, parseTasks, stamp, type LsyCourses } from '@deepseek-ai/dsh-lsy-courses'
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { clip, dataBlock, healthLine, taskLine } from './format.ts'

export { clip, dataBlock, healthLine, taskLine } from './format.ts'

/** Plugin name. */
export const name = 'lsy-tool-courses'

/** Mounted inside an agent preset's scope, like other tool plugins. */
export const inject = ['tools']

/** Rows of one read at most. */
const MAX_ROWS = 30

const PROGRESS = ['not_started', 'in_progress', 'partial', 'completed', 'reopened'] as const
const MEMO_CATEGORIES = ['idea', 'plan', 'question', 'decision', 'note'] as const

/** A tool problem the model should read, not a crash. */
class ToolProblem extends Error {}

/** Human-readable error text. */
function errorText(error: unknown): string {
  if (error instanceof CoursesApiError && error.failure === 'not-configured') return 'The course records are not reachable: the courses token is not configured. Tell the owner; do not retry.'
  if (error instanceof CoursesApiError && error.failure === 'auth') return 'The courses service refused the token. Tell the owner; do not retry.'
  return error instanceof Error ? error.message : String(error)
}

/** A model-supplied argument as text; anything else is empty. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Clamp a model-supplied number into a range. */
function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * The request id of a write: the caller's, or one derived from the write's arguments, so retrying the identical
 * write reuses it and the service answers the first outcome again.
 * @param operation - the service operation.
 * @param args - the write's arguments without `request_id`.
 * @returns the id.
 */
export function requestId(operation: string, args: Record<string, unknown>): string {
  return `dsh-${operation}-${createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 24)}`
}

/**
 * The answer of a write: saved with the new version, or a version conflict to reconcile.
 * @param result - the service's `result`.
 * @returns the model's answer.
 */
export function writeOutcome(result: unknown): JsonValue {
  const row = typeof result === 'object' && result !== null ? result as Record<string, unknown> : {}
  if (row['conflict'] === true) {
    const current = typeof row['current'] === 'object' && row['current'] !== null ? row['current'] as Record<string, unknown> : {}
    return {
      conflict: true,
      current_version: typeof current['version'] === 'number' ? current['version'] : null,
      changed_fields: Array.isArray(row['changed_fields']) ? row['changed_fields'].filter((field): field is string => typeof field === 'string') : [],
      next: 'Someone changed the record since you read it: read it again with courses_get, reconcile with the owner if the change matters, and retry with the current version.',
    }
  }
  return { saved: true, id: typeof row['id'] === 'string' ? row['id'] : null, version: typeof row['version'] === 'number' ? row['version'] : null }
}

/**
 * Register the course tools once `ctx.lsyCourses` is mounted.
 * @param ctx - the preset scope's context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['lsyCourses'], (scoped) => {
    const courses: LsyCourses = scoped.lsyCourses
    const zone = courses.timeZone

    const read = (spec: {
      name: string
      description: string
      parameters: ParameterSchemaSpec
      title: (args: Record<string, unknown>) => string
      run: (args: Record<string, unknown>, signal: AbortSignal) => Promise<string>
    }): void => {
      scoped.tools.register(defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: {
          schema: { type: 'json' },
          render: (_args: unknown, value: unknown) => {
            const record = value as { text?: unknown; error?: unknown }
            const body = typeof record.text === 'string' ? record.text : ''
            return [{ type: 'text' as const, text: typeof record.error === 'string' ? JSON.stringify({ error: record.error }) : dataBlock(body) }]
          },
        },
        async execute(args, exec): Promise<JsonValue> {
          try {
            const answer = await spec.run(args as Record<string, unknown>, exec.signal)
            scoped.logger.info(`lsy-tool-courses: ${spec.name} answered ${answer.length} chars`)
            return { text: answer }
          } catch (error: unknown) {
            scoped.logger.warn(`lsy-tool-courses: ${spec.name} failed: ${errorText(error)}`)
            return { error: errorText(error) }
          }
        },
        presentCall: args => ({ card: 'generic', title: spec.title(args as Record<string, unknown>), kind: 'read' }),
      }))
    }

    const write = (spec: {
      name: string
      operation: string
      description: string
      parameters: ParameterSchemaSpec
      title: (args: Record<string, unknown>) => string
      build: (args: Record<string, unknown>) => Record<string, unknown>
    }): void => {
      scoped.tools.register(defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: { schema: { type: 'json' }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
        async execute(args, exec): Promise<JsonValue> {
          try {
            const body = spec.build(args as Record<string, unknown>)
            const given = text((args as Record<string, unknown>)['request_id'])
            const request = given === '' ? requestId(spec.operation, body) : given
            const outcome = writeOutcome(await courses.api.call(spec.operation, { ...body, request_id: request }, exec.signal))
            scoped.logger.info(`lsy-tool-courses: ${spec.operation} ${String(body['id'])} (${request}): ${JSON.stringify(outcome)}`)
            return outcome
          } catch (error: unknown) {
            scoped.logger.warn(`lsy-tool-courses: ${spec.operation} failed: ${errorText(error)}`)
            return { error: errorText(error) }
          }
        },
        presentCall: args => ({ card: 'generic', title: spec.title(args as Record<string, unknown>), kind: 'edit' }),
      }))
    }

    read({
      name: 'courses_deadlines',
      description: 'What the owner still has to do for their courses: open tasks with a deadline up to `days` ahead, soonest first, overdue ones included (a missed deadline may still take late submissions; the line says until when). Done work (completed, or a submission seen on the platform) is left out. Each line has the record id and version (for courses_set_progress), course, title, dates in New York time, progress, submission, and when the record was last updated; say "last update <time>" when you answer instead of calling a record current. The Sync line says whether the course records are being kept up to date; when it is not ok, tell the owner since when.',
      parameters: {
        days: { type: 'integer', description: 'How many days ahead (default 14, at most 60).' },
        course: { type: 'string', description: 'Only one course: its id or a short name such as "bio" or "1234".' },
        include_overdue: { type: 'boolean', description: 'Include tasks whose deadline passed (default true).' },
      },
      title: args => `Course deadlines${text(args['course']) === '' ? '' : ` of ${text(args['course'])}`}`,
      run: async (args, signal) => {
        const now = Date.now()
        const days = clamp(args['days'], 14, 1, 60)
        const course = text(args['course'])
        const result = await courses.api.call('report', {
          view: 'deadlines', to: new Date(now + days * 86_400_000).toISOString(), include_undated: 'separate', coverage_limit: 1, limit: MAX_ROWS,
          overdue: args['include_overdue'] === false ? 'exclude' : 'include', ...course === '' ? {} : { course_id: course },
        }, signal)
        const body = typeof result === 'object' && result !== null ? result as { items?: unknown; total?: unknown; undated?: { total?: unknown }; coverage?: unknown } : {}
        const tasks = parseTasks(Array.isArray(body.items) ? body.items : [])
        const total = typeof body.total === 'number' ? body.total : tasks.length
        const undated = typeof body.undated?.total === 'number' ? body.undated.total : 0
        const lines = [
          `Open course tasks due by ${stamp(now + days * 86_400_000, zone)} (${zone}), soonest first: ${tasks.length} of ${total}.`,
          ...tasks.map(task => taskLine(task, now, zone)),
          ...undated > 0 ? [`Undated or tentative tasks: ${undated} (courses_find searches all tasks).`] : [],
          healthLine(parseHealth(body.coverage), zone),
        ]
        return lines.join('\n')
      },
    })

    read({
      name: 'courses_find',
      description: 'Search the owner\'s course tasks by words in their id, title, requirements, notes, or remaining work, done ones included (the submission and progress fields say which are done). Use it to find the task the owner means ("the essay", "lab 2") before courses_get or courses_set_progress.',
      parameters: {
        text: { type: 'string', required: true, description: 'Words to find.' },
        course: { type: 'string', description: 'Only one course: its id or a short name.' },
      },
      title: args => `Find course task "${text(args['text'])}"`,
      run: async (args, signal) => {
        const words = text(args['text'])
        if (words === '') throw new ToolProblem('give the words to search for')
        const course = text(args['course'])
        const result = await courses.api.call('query', { kind: 'task', text: words, limit: 10, ...course === '' ? {} : { course_id: course } }, signal)
        const body = typeof result === 'object' && result !== null ? result as { records?: unknown; total?: unknown } : {}
        const tasks = parseTasks(Array.isArray(body.records) ? body.records : [])
        if (tasks.length === 0) return `No course task matches "${words}".`
        const now = Date.now()
        return [`${tasks.length} task(s) match "${words}"${typeof body.total === 'number' && body.total > tasks.length ? ` (of ${body.total})` : ''}:`, ...tasks.map(task => taskLine(task, now, zone))].join('\n')
      },
    })

    read({
      name: 'courses_get',
      description: 'One course task by its id: the line courses_deadlines shows, its current version (send it as expected_version when you write), what is left to do, and an excerpt of the requirements. Read it right before courses_set_progress.',
      parameters: { id: { type: 'string', required: true, description: 'The task id, e.g. from courses_deadlines.' } },
      title: args => `Course task ${text(args['id'])}`,
      run: async (args, signal) => {
        const id = text(args['id'])
        if (id === '') throw new ToolProblem('give the task id')
        const result = await courses.api.call('get', { id }, signal)
        const [task] = parseTasks([result])
        if (task === undefined) throw new ToolProblem(`${id} is not a task record`)
        const excerpt = typeof (result as { excerpt?: unknown }).excerpt === 'string' ? (result as { excerpt: string }).excerpt : ''
        return [
          taskLine(task, Date.now(), zone),
          `version: ${task.version}`,
          ...task.remainingWork === null ? [] : [`remaining work: ${clip(task.remainingWork)}`],
          ...excerpt === '' ? [] : [`requirements (excerpt): ${clip(excerpt)}`],
          ...task.links.slice(1, 3).map(link => `${link.label}: ${link.url}`),
        ].join('\n')
      },
    })

    write({
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
    })

    write({
      name: 'courses_save_memo',
      operation: 'save_memo',
      description: 'Keep a note for the owner\'s courses: an idea, plan, question, decision, or note, optionally tied to a course or a task, with an optional personal planned time (not a deadline). A new memo uses expected_version 0 and no id; to edit one, pass its id and current version.',
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
    })
  })
}
