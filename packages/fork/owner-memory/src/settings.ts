/**
 * Memory settings route, mounted as its own row (`@deepseek-ai/dsh-owner-memory/settings`) at the Host root,
 * apart from the agent-facing `owner-memory` rows inside the presets: `GET`/`POST /api/owner-memory` for the
 * browser half's Settings section (`@deepseek-ai/dsh-owner-memory-admin`).
 * The owner reviews what the agent remembers there: waiting writes to approve or discard, entries to
 * search, undo, or erase, a Session's changes to roll back, and the keep/delete verdicts on persona replies.
 * The route sits under `/api`, so the connection's sign-in check guards it and only the owner's Web UI
 * reaches it. The plugin registers no tool and no service: the agent cannot call it, and a write waiting for
 * the owner cannot be approved by the Session that made it.
 */

import { dirname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defaultFeedbackFile, FeedbackStore } from './feedback.ts'
import { defaultMemoryFile, MemoryStore } from './store.ts'
import { MemoryHandler } from './settings/handler.ts'
import { MEMORY_PATH } from './settings/view.ts'

export { MemoryHandler, SETTINGS_ORIGIN } from './settings/handler.ts'
export type * from './settings/view.ts'

/** Plugin configuration. */
export interface Config {
  /** Absolute path of the memory file; unset reads `<DSH_HOME>/owner-memory/memory.jsonl`, the file the agent's `owner-memory` rows use. */
  file?: string
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  file: z.string(),
})

/** Required Host services. */
export const inject = ['connection']

/** The slice of the connection service this plugin uses. */
interface MemoryConnection {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'POST')[]
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/**
 * Register the Memory settings route.
 * @param ctx - Host context with the connection service.
 * @param config - resolved configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.file !== undefined && !isAbsolute(config.file)) throw new Error('owner-memory-settings: file must be an absolute path')
  const file = config.file ?? defaultMemoryFile()
  const feedbackFile = config.file === undefined ? defaultFeedbackFile() : join(dirname(config.file), 'feedback.jsonl')
  const handler = new MemoryHandler({ store: new MemoryStore(file), feedback: new FeedbackStore(feedbackFile), logger: ctx.logger })
  const connection = Reflect.get(ctx, 'connection') as MemoryConnection
  ctx.logger.info('owner-memory-settings: serving %s from %s', MEMORY_PATH, file)
  ctx.effect(() => connection.fetch.register({
    path: MEMORY_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: request => handler.fetch(request),
  }), 'owner-memory-settings: /api/owner-memory')
}
