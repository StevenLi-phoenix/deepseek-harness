/** Owner-memory mode: the memory block in front of each root Session. */

import type { Context } from '@deepseek-ai/cordis'
import { renderMemoryBlock } from './render.ts'
import { injectBlock } from './session-block.ts'
import type { MemoryStore } from './store.ts'

/**
 * Inject the memory block into each root Session. A file that cannot be read is logged and the request goes on without
 * memory.
 * @param ctx - the preset scope's context.
 * @param store - the memory file.
 * @param maxBytes - the block's byte budget.
 */
export function mountMemoryBlock(ctx: Context, store: MemoryStore, maxBytes: number): void {
  injectBlock(ctx, async (session) => {
    let entries
    try {
      entries = await store.list()
    } catch (error: unknown) {
      ctx.logger.warn('memory not loaded for session %s: %s', session.id, error instanceof Error ? error.message : String(error))
      return undefined
    }
    const text = renderMemoryBlock(entries, maxBytes)
    if (text !== undefined) ctx.logger.info('memory block (%d entries, %d bytes) entered session %s', entries.length, Buffer.byteLength(text), session.id)
    return text
  })
}
