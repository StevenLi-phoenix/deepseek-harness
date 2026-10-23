/** Durable channel state: long-poll cursors, reply windows, chat Sessions, undelivered texts, and chat activity. */
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

/** What the bot's latest message to the owner was. */
export const SENT_KINDS = ['reply', 'note', 'file', 'notice', 'digest'] as const
/** One of {@link SENT_KINDS}: a chat Session reply, another Session's note, a file, a channel notice, or an outbox digest. */
export type SentKind = typeof SENT_KINDS[number]

const activitySchema = z.object({
  /** When the owner's latest message arrived, in Unix epoch milliseconds. */
  ownerAt: z.number().optional(),
  /** When the bot last sent the owner a message, in Unix epoch milliseconds. */
  sentAt: z.number().optional(),
  /** What that message was. */
  sent: z.enum(SENT_KINDS).optional(),
}).strict()

const sentSchema = z.object({
  /** Send order. */
  seq: z.number().int().nonnegative(),
  /** The text as the owner received it. */
  text: z.string(),
  /** When the send started and when it was accepted, in Unix epoch milliseconds. */
  sentAt: z.number(),
  doneAt: z.number(),
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
/** Latest message in the owner's chat, each way. */
export type ActivityRecord = z.infer<typeof activitySchema>
/** One text the bot sent, kept so a quote of it can be read back. */
export type SentRecord = z.infer<typeof sentSchema>

/**
 * Channel storage. `cursors` is keyed by bot id, `windows` by `<botId>/<ownerUserId>`,
 * `chats` and `activity` by owner id, `sessions` by Session id, and `outbox` and `sent` by zero-padded `seq`.
 * A table added later loads empty from an existing file, so `activity` needs no version change.
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
    activity: domainTable<string, ActivityRecord>(activitySchema),
    sent: domainTable<string, SentRecord>(sentSchema),
  },
})
