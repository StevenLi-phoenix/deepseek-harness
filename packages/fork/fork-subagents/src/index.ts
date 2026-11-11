/**
 * Subagent panel, node half: registers the `forkSubagentActivity` projection, which folds every
 * subagent Session's own events into what it is doing now. The value rides the Session summary and
 * the Host-wide control stream, so the browser half reads it without opening a child's history.
 * Nothing here reaches a model request.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection'
import { ACTIVITY_KEY } from './activity.ts'
import { activityProjectionDefinition } from './projection.ts'

export * from './activity.ts'
export { activityProjectionDefinition, noteOf, previewOf, shorten } from './projection.ts'

/** Required Host services. */
export const inject = ['sessionProjections']

/**
 * Register the projection for the plugin's lifetime.
 * @param ctx - Host context with the projection registry.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.sessionProjections.register(activityProjectionDefinition)
  ctx.logger.info('fork-subagents: projection %s registered (subagent Sessions only)', ACTIVITY_KEY)
}
