/** Durable channel state: long-poll cursors, reply windows, chat Sessions, and undelivered texts. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

const cursorSchema = z.object({
  /** `get_updates_buf` of the last answer, sent back on the next long-poll. */
  buf: z.string(),
}).strict()

const windowSchema = z.object({
  /** `context_token` of the owner's latest message; every send must carry one. */
  token: z.string().min(1),
  /** When that message arrived, in Unix epoch milliseconds. */
  receivedAt: z.number(),
  /** Messages sent with this token. */
  used: z.number().int().nonnegative(),
  /** The server rejected a send with this token (`ret -2`); wait for the next owner message. */
  exhausted: z.boolean(),
}).strict()

const chatSchema = z.object({
  /** The owner's current chat Session. */
  sessionId: z.string().min(1),
  createdAt: z.number(),
}).strict()

const sessionSchema = z.object({
  /** Owner the Session was created for. */
  ownerUserId: z.string().min(1),
  createdAt: z.number(),
}).strict()

const outboxSchema = z.object({
  /** Delivery order. */
  seq: z.number().int().nonnegative(),
  text: z.string(),
  /** Unix epoch milliseconds. */
  queuedAt: z.number(),
}).strict()

/** Long-poll cursor of one bot. */
export type CursorRecord = z.infer<typeof cursorSchema>
/** Reply window opened by the owner's latest message. */
export type WindowRecord = z.infer<typeof windowSchema>
/** Current chat Session of one owner. */
export type ChatRecord = z.infer<typeof chatSchema>
/** One chat Session this channel created, current or retired by `/new`. */
export type SessionRecord = z.infer<typeof sessionSchema>
/** One text waiting for a reply window. */
export type OutboxRecord = z.infer<typeof outboxSchema>

/**
 * Channel storage. `cursors` is keyed by bot id, `windows` by `<botId>/<ownerUserId>`,
 * `chats` by owner id, `sessions` by Session id, and `outbox` by zero-padded `seq`.
 */
export const wechatDomain = defineDomain({
  name: 'lsy_wechat',
  version: 1,
  tables: {
    cursors: domainTable<string, CursorRecord>(cursorSchema),
    windows: domainTable<string, WindowRecord>(windowSchema),
    chats: domainTable<string, ChatRecord>(chatSchema),
    sessions: domainTable<string, SessionRecord>(sessionSchema),
    outbox: domainTable<string, OutboxRecord>(outboxSchema),
  },
})
