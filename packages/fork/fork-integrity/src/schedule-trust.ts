/**
 * The schedule file as the schedule service last wrote it. The service announces every durable write; the file as it
 * stands then is the legitimate state, so a scan can tell an edit behind the service's back from the service's own.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-schedule'
import { writeJson } from './files.ts'
import { scheduleState, type Target } from './scan.ts'
import type { TrustedSchedule } from './compare.ts'

export const trustedOf = (digest: string, tasks: Record<string, string> | undefined): TrustedSchedule => (
  { at: new Date().toISOString(), digest, ...tasks === undefined ? {} : { tasks } }
)

/** What a scan asks of the trust recorder. */
export interface ScheduleTrust {
  /** Resolves once every announced write is recorded. */
  readonly settled: () => Promise<void>
  /** How many writes have been announced; a change while a scan reads means look again. */
  readonly version: () => number
}

/**
 * Record the trusted schedule state on every `schedule/changed`.
 * @param ctx - the root context.
 * @param scheduleTarget - the schedule file, when it is watched.
 * @param trustedFile - where the trusted state is kept.
 * @returns the handle a scan waits on.
 */
export function mountScheduleTrust(ctx: Context, scheduleTarget: Target | undefined, trustedFile: string): ScheduleTrust {
  let trusting: Promise<void> = Promise.resolve()
  let trustVersion = 0
  const trustSchedule = async (): Promise<void> => {
    if (scheduleTarget === undefined) return
    const state = await scheduleState(scheduleTarget.path)
    if (state.digest === 'unreadable') {
      ctx.logger.warn('fork-integrity: schedule file unreadable right after a schedule change; the last trusted state stays')
      return
    }
    await writeJson(trustedFile, trustedOf(state.digest, state.tasks))
    ctx.logger.info('fork-integrity: schedule written through the service: %d task(s), digest %s', Object.keys(state.tasks ?? {}).length, state.digest.slice(0, 12))
  }
  if (scheduleTarget !== undefined) {
    ctx.on('schedule/changed', () => {
      trustVersion += 1
      trusting = trusting.then(trustSchedule).catch((error: unknown) => {
        ctx.logger.warn('fork-integrity: recording the schedule state failed: %s', error instanceof Error ? error.message : String(error))
      })
    })
  }
  return { settled: () => trusting, version: () => trustVersion }
}
