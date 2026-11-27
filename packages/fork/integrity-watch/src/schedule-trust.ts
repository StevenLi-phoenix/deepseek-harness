/**
 * The schedule file as the schedule service last wrote it. The service announces every durable write; the file as it
 * stands then is the legitimate state, so a scan can tell an edit behind the service's back from the service's own.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-schedule'
import { writeJson } from './files.ts'
import { scheduleState, type Target } from './scan.ts'
import type { TrustedSchedule } from './compare.ts'

/**
 * Make the trusted schedule state for a digest.
 * @param digest - digest of all task definitions.
 * @param tasks - task id to the digest of its definition; undefined when the file had none.
 * @returns the state stamped with the current time as an ISO string.
 */
export const trustedOf = (digest: string, tasks: Record<string, string> | undefined): TrustedSchedule => (
  { at: new Date().toISOString(), digest, ...tasks === undefined ? {} : { tasks } }
)

/** What a scan asks of the trust recorder. */
export interface ScheduleTrust {
  /** Resolves once every announced write is recorded. */
  readonly settled: () => Promise<void>
  /** How many writes have been announced; a change while a scan reads means look again. */
  readonly version: () => number
  /**
   * Record a state a scan found before any service write reported one, in line behind the writes already
   * announced, and only when none was announced since the scan read the version; a stale seed would
   * otherwise overwrite the record of a service write that landed meanwhile, and the next scan would call
   * that write an edit behind the service.
   */
  readonly seed: (version: number, state: TrustedSchedule) => Promise<void>
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
    /* v8 ignore next -- the handler is registered only when the target is defined. */
    if (scheduleTarget === undefined) return
    const state = await scheduleState(scheduleTarget.path)
    if (state.digest === 'unreadable') {
      ctx.logger.warn('integrity-watch: schedule file unreadable right after a schedule change; the last trusted state stays')
      return
    }
    await writeJson(trustedFile, trustedOf(state.digest, state.tasks))
    ctx.logger.info('integrity-watch: schedule written through the service: %d task(s), digest %s', Object.keys(state.tasks ?? {}).length, state.digest.slice(0, 12))
  }
  if (scheduleTarget !== undefined) {
    ctx.on('schedule/changed', () => {
      trustVersion += 1
      trusting = trusting.then(trustSchedule).catch((error: unknown) => {
        /* v8 ignore next -- only fs errors reach here, which are Error instances. */
        ctx.logger.warn('integrity-watch: recording the schedule state failed: %s', error instanceof Error ? error.message : String(error))
      })
    })
  }
  const seed = (version: number, state: TrustedSchedule): Promise<void> => {
    trusting = trusting.then(async () => {
      if (version !== trustVersion) {
        ctx.logger.info('integrity-watch: a service write landed during the scan; its record stands over the scanned state')
        return
      }
      await writeJson(trustedFile, state)
    }).catch((error: unknown) => {
      /* v8 ignore next -- only fs errors reach here, which are Error instances. */
      ctx.logger.warn('integrity-watch: recording the scanned schedule state failed: %s', error instanceof Error ? error.message : String(error))
    })
    return trusting
  }
  return { settled: () => trusting, version: () => trustVersion, seed }
}
