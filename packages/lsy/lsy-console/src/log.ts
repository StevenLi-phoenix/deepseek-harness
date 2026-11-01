/** One log line per action: what, on what, how it ended, and how long it took; never tokens or message text. */

import { Refusal } from './request.ts'

/** The logger methods this package calls. */
export interface Log {
  info(message: string): void
  warn(message: string): void
}

/**
 * Run an action and log its outcome.
 * @param log - logger.
 * @param action - action name, for example `subscription.delete`.
 * @param target - id of what it acted on, or an empty string.
 * @param run - the action; a {@link Refusal} it throws is logged as its code and thrown again.
 * @returns what `run` returned.
 */
export async function logAction<T>(log: Log, action: string, target: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now()
  const label = `lsy-console: ${action}${target === '' ? '' : ` ${target}`}`
  try {
    const result = await run()
    log.info(`${label} -> ok (${Date.now() - started} ms)`)
    return result
  } catch (error: unknown) {
    const outcome = error instanceof Refusal ? error.code : `error ${error instanceof Error ? error.name : 'unknown'}`
    log.warn(`${label} -> ${outcome} (${Date.now() - started} ms)`)
    throw error
  }
}
