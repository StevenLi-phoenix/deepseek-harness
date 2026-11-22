/**
 * Course tools for the owner's main agent, over `ctx.courses` (the courses service): what is due, a search, one
 * record, the owner's writes `courses_set_progress` and `courses_save_memo`, and the collector's writes
 * `courses_observe` and `courses_record_sync` for what the agent itself read on a platform page. Reads return one line per task with only
 * what answering the owner needs; record text comes from course pages and is wrapped as untrusted data. Writes
 * carry the record's `expected_version` and a `request_id` that stays the same when the identical write is retried,
 * so a lost answer cannot apply it twice. Facts, progress, and submission stay apart as the service keeps them: what the
 * owner says goes to progress and notes; dates and the submission status come only from a platform page read, the
 * course sync's or the agent's own headless-browser read through `courses_observe`.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Courses } from '@deepseek-ai/dsh-courses'
import { deadlinesTool, findTool, getTool, syncTool } from './read-tools.ts'
import { registerRead, registerWrite } from './register.ts'
import { memoTool, observeTool, progressTool, syncRunTool } from './write-tools.ts'

export { clip, dataBlock, healthLine, taskLine } from './format.ts'
export { requestId, writeOutcome } from './write-outcome.ts'

/** Plugin name. */
export const name = 'tool-courses'

/** Mounted inside an agent preset's scope, like other tool plugins. */
export const inject = ['tools']

/**
 * Register the course tools once `ctx.courses` is mounted.
 * @param ctx - the preset scope's context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['courses'], (scoped) => {
    const courses: Courses = scoped.courses
    for (const spec of [deadlinesTool(courses), findTool(courses), getTool(courses), syncTool(courses)]) registerRead(scoped, spec)
    for (const spec of [progressTool(), memoTool(), observeTool(), syncRunTool()]) registerWrite(scoped, courses, spec)
  })
}
