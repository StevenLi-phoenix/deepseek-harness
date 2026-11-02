/** Feedback mode for the Bilibili persona presets: one scope's keep/delete verdicts in front of each root Session. */

import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'
import { FeedbackStore, renderFeedbackBlock, type FeedbackScope } from './feedback.ts'
import { injectBlock } from './session-block.ts'
import { defaultMemoryFile } from './store.ts'

/**
 * Feedback mode: the pre-step injection of one scope's keep/delete verdicts, read-only and without tools.
 * @param ctx - the preset scope's context.
 * @param config - memory file (the feedback file sits beside it) and block budget.
 * @param scope - whose replies the verdicts are about.
 */
export function applyFeedback(ctx: Context, config: Config, scope: FeedbackScope): void {
  const store = new FeedbackStore(config.file === undefined ? join(dirname(defaultMemoryFile()), 'feedback.jsonl') : join(dirname(config.file), 'feedback.jsonl'))
  const maxBytes = Math.min(config.maxBytes ?? 8192, 8192)
  ctx.logger.info('lsy-memory: feedback mode, scope %s (read-only, no owner memory)', scope)
  injectBlock(ctx, async (session) => {
    try {
      const entries = await store.list(scope)
      const text = renderFeedbackBlock(entries, maxBytes)
      if (text !== undefined) ctx.logger.info('feedback block (%d verdicts, %d bytes, scope %s) entered session %s', entries.length, Buffer.byteLength(text), scope, session.id)
      return text
    } catch (error: unknown) {
      ctx.logger.warn('feedback not loaded for session %s: %s', session.id, error instanceof Error ? error.message : String(error))
      return undefined
    }
  })
}
