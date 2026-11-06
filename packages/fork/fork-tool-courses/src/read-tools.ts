/**
 * The four read tools. Each answers one text block; record text comes from course pages and is wrapped as untrusted
 * data when it is rendered.
 */

import { parseHealth, parseTasks, stamp, type ForkCourses } from '@deepseek-ai/dsh-fork-courses'
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { clip, coverageRows, healthLine, runLines, taskLine } from './format.ts'
import { clamp, text, ToolProblem } from './tool-args.ts'

/** Rows of one read at most. */
const MAX_ROWS = 30

/** A read tool: its name, its text for the model, and how it answers. */
export interface ReadSpec {
  name: string
  description: string
  parameters: ParameterSchemaSpec
  title: (args: Record<string, unknown>) => string
  run: (args: Record<string, unknown>, signal: AbortSignal) => Promise<string>
}

/**
 * Define `courses_deadlines`, the list of open tasks due soon.
 * @param courses - the courses client; its time zone formats dates.
 * @returns the tool's name, description, parameters, and run function; `run` rejects when the courses service call fails.
 */
export function deadlinesTool(courses: ForkCourses): ReadSpec {
  const zone = courses.timeZone
  return {
    name: 'courses_deadlines',
    description: 'What the owner still has to do for their courses: open tasks with a deadline up to `days` ahead, soonest first, overdue ones included (a missed deadline may still take late submissions; the line says until when). Done work (completed, or a submission seen on the platform) is left out. Each line has the record id and version (for courses_set_progress), course, title, dates in New York time, progress, submission, and "last update", which is when that task\'s own page was last read; say "last update <time>" when you answer instead of calling a record current. The Sync line says whether the sync runs are healthy; when it is not ok, tell the owner since when, but a failed run does not make earlier readings old (a run that read the assignment list may have left each task\'s own "last update" untouched), so call courses_sync before you tell the owner a date or status is out of date. These records are the sync\'s notes, not a live view of Brightspace: you cannot open the course pages; say so plainly when asked, and offer the owner the task\'s source link. Deadline reminders need no schedule: they go out by themselves before each deadline and stop once a task is done. A schedule you add that names a course task is fixed text and goes stale (the owner may finish the task first), so write into its prompt to read the task with courses_get when it fires and to leave out a task that is completed or submitted by then; when a scheduled prompt names a course task, read it with courses_get before you mention it.',
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
  }
}

/**
 * Define `courses_find`, the text search over all tasks.
 * @param courses - the courses client; its time zone formats dates.
 * @returns the tool's name, description, parameters, and run function; `run` throws `ToolProblem` when no words are given.
 */
export function findTool(courses: ForkCourses): ReadSpec {
  const zone = courses.timeZone
  return {
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
  }
}

/**
 * Define `courses_get`, the read of one task by id.
 * @param courses - the courses client; its time zone formats dates.
 * @returns the tool's name, description, parameters, and run function; `run` throws `ToolProblem` when the id is empty or not a task.
 */
export function getTool(courses: ForkCourses): ReadSpec {
  const zone = courses.timeZone
  return {
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
  }
}

/**
 * Define `courses_sync`, the report of what recent sync runs read.
 * @param courses - the courses client; its time zone formats dates.
 * @returns the tool's name, description, parameters, and run function.
 */
export function syncTool(courses: ForkCourses): ReadSpec {
  const zone = courses.timeZone
  return {
    name: 'courses_sync',
    description: 'What the recent sync runs actually read, newest first: per run, its time and one line per area (announcements, assignments, quizzes, content, grades, gradescope…) saying checked, not_checked, or failed with the detail the run wrote (for example which assignment list it read and the dates it saw). Use it when the owner asks how fresh a date or status is, or says the records look old: a task\'s "last update" only tells when its own page was last read, while a run that read the assignment list still confirms the due dates on that list. The courses service does not open Brightspace live, and you cannot either.',
    parameters: { runs: { type: 'integer', description: 'How many recent runs (default 3, at most 6).' } },
    title: () => 'Recent course sync runs',
    run: async (args, signal) => {
      const count = clamp(args['runs'], 3, 1, 6)
      const listed = await courses.api.call('query', { kind: 'sync', sort: 'updated_desc', limit: count }, signal)
      const listing = typeof listed === 'object' && listed !== null ? listed as { records?: unknown } : {}
      const records = Array.isArray(listing.records) ? listing.records as unknown[] : []
      const lines: string[] = [`The ${records.length} most recent sync run(s), newest first (times in ${zone}):`]
      for (const record of records) {
        const row = typeof record === 'object' && record !== null ? record as Record<string, unknown> : {}
        const id = typeof row['id'] === 'string' ? row['id'] : ''
        if (id === '') continue
        const observed = typeof row['observed_at'] === 'string' ? Date.parse(row['observed_at']) : Number.NaN
        const full = await courses.api.call('get', { id, detail: 'full' }, signal)
        lines.push(...runLines(id, Number.isFinite(observed) ? observed : null, coverageRows(full), zone))
      }
      lines.push('The courses service does not open Brightspace live: these lines are what each run wrote down.')
      return lines.join('\n')
    },
  }
}
