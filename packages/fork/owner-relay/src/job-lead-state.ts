/** Private on-disk state for the job-lead route. */
import { readFileSync } from 'node:fs'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { SessionId } from '@deepseek-ai/dsh-session'

/** One replacement in the rolling reset window. */
export interface JobLeadReset {
  at: number
  oldSessionId: string
  reason: string
}

/** Route target and reset history, independent of the profile patch. */
export interface JobLeadState {
  jobLeadSessionId: SessionId
  resets: readonly JobLeadReset[]
  limitReported?: true
  poisonedSessionStillscheduled?: readonly string[]
}

/**
 * Locate the job-lead route state independently of the profile patch.
 * @returns The private state location under the configured Harness home.
 */
export function jobLeadStateFile(): string {
  return dshHomePath('data', 'owner-relay', 'job-lead.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isReset(value: unknown): value is JobLeadReset {
  return isRecord(value) && typeof value['at'] === 'number' && Number.isSafeInteger(value['at'])
    && typeof value['oldSessionId'] === 'string' && typeof value['reason'] === 'string'
}

/**
 * Load the route target before any events can be received. A corrupt state file never falls back to the stale seed.
 * @param file - runtime state path.
 * @param seed - profile target used only when no file has been written.
 * @returns The selected route target and its rate-limit state.
 */
export function readJobLeadState(file: string, seed: SessionId): JobLeadState {
  let data: unknown
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { jobLeadSessionId: seed, resets: [] }
  }
  if (!isRecord(data)) throw new Error('owner-relay: invalid job-lead state')
  const { jobLeadSessionId, resets, limitReported, poisonedSessionStillscheduled } = data
  if (typeof jobLeadSessionId !== 'string' || jobLeadSessionId.trim() === ''
    || !Array.isArray(resets) || !resets.every(isReset)
    || (limitReported !== undefined && limitReported !== true)
    || (poisonedSessionStillscheduled !== undefined && (!Array.isArray(poisonedSessionStillscheduled)
      || !poisonedSessionStillscheduled.every((id: unknown): id is string => typeof id === 'string')))) {
    throw new Error('owner-relay: invalid job-lead state')
  }
  return { jobLeadSessionId: SessionId(jobLeadSessionId), resets,
    ...(limitReported === true ? { limitReported } : {}),
    ...(poisonedSessionStillscheduled === undefined ? {} : { poisonedSessionStillscheduled }) }
}

/**
 * Atomically replace the relay's private state without writing to the profile.
 * @param file - runtime state path.
 * @param state - complete replacement value.
 * @returns Once the same-directory rename has committed.
 */
export function writeJobLeadState(file: string, state: JobLeadState): Promise<void> {
  return writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}
