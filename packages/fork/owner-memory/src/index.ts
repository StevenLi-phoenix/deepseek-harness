/**
 * Owner memory across Sessions. The Host keeps the entries in one JSONL file and
 * puts them in front of the model itself: the first request of a root Session
 * (and the first after compaction shadows it) carries the memory block, so
 * recall never depends on the model choosing to look. The model reads details
 * and writes through three typed tools whose input the store validates.
 *
 * @module @deepseek-ai/dsh-owner-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { holdEnabled, type Config } from './config.ts'
import { applyFeedback } from './feedback-mode.ts'
import { mountMemoryBlock } from './memory-block.ts'
import { mountNotices } from './notice-queue.ts'
import { SOURCE_KIND } from './session-block.ts'
import { defaultMemoryFile, MemoryStore } from './store.ts'
import { registerMemoryTools } from './tools.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * The memory block and the requests of the memory plugin.
     * @persistenceAttribution
     */
    'owner-memory': { kind: 'owner-memory' } & ContextFormed
  }
}

export type { MemoryCategory, MemoryDraft, MemoryEntry, MemorySource, PendingEntry, WriteMeta } from './entries.ts'
export type { PurgePlan, ReviewOp, ReviewResult, RollbackItem } from './admin.ts'
export type { NoticeItem } from './notice.ts'
export { MemoryError, type HistoryRecord, type PurgeOptions, type PurgeResult, type RollbackFilter, type RollbackOptions, type RollbackResult } from './store.ts'
export { FeedbackError, type FeedbackEntry, type FeedbackInput, type FeedbackKind, type FeedbackScope, type FeedbackVerdict } from './feedback.ts'
export { Config } from './config.ts'

/** Plugin name; also the source kind of the memory message. */
export const name = SOURCE_KIND

/** Mounted inside an agent preset's scope, like other tool plugins. */
export const inject = ['tools']

/**
 * Register the memory tools and the pre-step injection.
 * @param ctx - the preset scope's context.
 * @param config - memory file and context budget.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.feedbackScope !== undefined) {
    applyFeedback(ctx, config, config.feedbackScope)
    return
  }
  const store = new MemoryStore(config.file ?? defaultMemoryFile())
  const maxBytes = config.maxBytes ?? 65_536
  const hold = holdEnabled(config)
  const notify = config.notify ?? true
  const noticesPerDay = config.noticesPerDay ?? 12
  ctx.logger.info('owner-memory: hold %s, notices %s (at most %d a day)', hold ? 'on' : 'off (observing: records, history, and notices only)', notify ? 'on' : 'off', noticesPerDay)

  const enqueue = mountNotices(ctx, { notify, noticesPerDay })
  mountMemoryBlock(ctx, store, maxBytes)
  registerMemoryTools(ctx, { store, hold, enqueue })
}
