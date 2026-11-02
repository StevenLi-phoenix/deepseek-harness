/** Plugin configuration and the switches derived from it. */

import z from '@deepseek-ai/schemastery'
import { FEEDBACK_SCOPES, type FeedbackScope } from './feedback.ts'

/** Memory file and context budget. */
export interface Config {
  /** Absolute path of the memory file; defaults to `<DSH_HOME>/fork-memory/memory.jsonl`. */
  file?: string
  /** Cap on the memory block, in bytes. */
  maxBytes?: number
  /**
   * Hold a protected write (`instructions`, `preferences`, `identity`) until the owner approves it
   * when the turn was not the owner's alone, refuse to forget a protected entry then, and show
   * `identity` entries only as a count. Off keeps the provenance records and notices but no holds.
   * `FORK_MEMORY_HOLD=0` in the environment turns it off whatever the configuration says.
   */
  hold?: boolean
  /** Tell the owner on WeChat about protected writes, one merged notice per turn. */
  notify?: boolean
  /** Notices the owner gets in a day; further writes are still recorded in the history. */
  noticesPerDay?: number
  /**
   * Feedback mode, for the Bilibili persona presets (`up`, `bili`): no memory block and no tools; the Host puts the
   * owner's keep/delete verdicts on that scope's replies in front of each root Session as examples of tone.
   */
  feedbackScope?: FeedbackScope
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  file: z.string(),
  maxBytes: z.natural().min(1024).default(65_536),
  hold: z.boolean().default(true),
  notify: z.boolean().default(true),
  noticesPerDay: z.natural().min(1).default(12),
  feedbackScope: z.union(FEEDBACK_SCOPES),
})

/**
 * Whether protected writes are held. The environment switch works from `$DSH_HOME/.env` (restart needed), because a
 * profile patch cannot reach a row inside a preset.
 * @param config - the plugin configuration.
 * @param env - the process environment.
 * @returns whether the hold is on.
 */
export function holdEnabled(config: Config, env: NodeJS.ProcessEnv = process.env): boolean {
  return env['FORK_MEMORY_HOLD'] === '0' ? false : config.hold ?? true
}
