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

export {
  CATEGORIES, CATEGORY_DISPLAY, isProtected, MAX_TEXT_CHARS, PROTECTED_CATEGORIES, SOURCES,
  type MemoryCategory, type MemoryDraft, type MemoryEntry, type MemorySource, type PendingEntry, type WriteMeta,
} from './entries.ts'
export {
  CLI_ORIGIN, describeRollback, planPurge, purgeConfirmed, purgeToken, REVIEW_OPS, reviewWrite, rollbackConfirmed, rollbackToken,
  type PurgePlan, type ReviewOp, type ReviewResult, type RollbackItem,
} from './admin.ts'
export { parseClaudeExport } from './export.ts'
export { CJK_SPAN, sharesSpan, spanKeys, WORD_SPAN } from './overlap.ts'
export { memoryNotice, type NoticeItem } from './notice.ts'
export { renderMemoryBlock } from './render.ts'
export {
  defaultMemoryFile, localDate, matchesRollback, MAX_ENTRIES, MAX_PENDING, MemoryError, MemoryStore, PENDING_DAYS,
  type HistoryRecord, type PurgeOptions, type PurgeResult, type RollbackFilter, type RollbackOptions, type RollbackResult,
} from './store.ts'
export {
  defaultFeedbackFile, FEEDBACK_KINDS, FEEDBACK_SCOPES, FEEDBACK_VERDICTS, FeedbackError, FeedbackStore,
  MAX_FEEDBACK_PER_SCOPE, renderFeedbackBlock,
  type FeedbackEntry, type FeedbackInput, type FeedbackKind, type FeedbackScope, type FeedbackVerdict,
} from './feedback.ts'
export { runAdminCli, runImportCli } from './cli.ts'
export { isCategory, isEntryId } from './entries.ts'
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
