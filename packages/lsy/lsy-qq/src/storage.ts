/** Durable channel state: chat Sessions per peer, reply windows, and the unknown senders already reported. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

const chatSchema = z.object({
  /** The peer's current chat Session. */
  sessionId: z.string().min(1),
  /** `c2c` for a private chat, `group` for a group chat. */
  scope: z.enum(['c2c', 'group']),
  /** `user_openid` or `group_openid`: where replies go. */
  targetId: z.string().min(1),
  createdAt: z.number(),
}).strict()

const sessionSchema = z.object({
  /** Peer key (`c2c:<openid>` or `group:<openid>`) the Session was created for. */
  peerKey: z.string().min(1),
  createdAt: z.number(),
}).strict()

const windowSchema = z.object({
  /** QQ's id of the peer's latest message; a reply quotes it. */
  msgId: z.string().min(1),
  /** When that message arrived, in Unix epoch milliseconds. */
  receivedAt: z.number(),
  /** Passive replies already sent against this message id. */
  used: z.number().int().nonnegative(),
}).strict()

const unknownSchema = z.object({
  /** When the owner was last told this sender wrote, in Unix epoch milliseconds. */
  notifiedAt: z.number(),
}).strict()

/** Current chat Session of one peer. */
export type ChatRecord = z.infer<typeof chatSchema>
/** One chat Session this channel created, current or retired by `/new`. */
export type SessionRecord = z.infer<typeof sessionSchema>
/** Reply window opened by a peer's latest message. */
export type WindowRecord = z.infer<typeof windowSchema>
/** A sender outside the allowlist the owner was told about. */
export type UnknownRecord = z.infer<typeof unknownSchema>

/**
 * Channel storage. `chats` and `windows` are keyed by peer key (`c2c:<user_openid>` or
 * `group:<group_openid>`), `sessions` by Session id, `unknown` by the sender's openid.
 */
export const qqDomain = defineDomain({
  name: 'lsy_qq',
  version: 1,
  tables: {
    chats: domainTable<string, ChatRecord>(chatSchema),
    sessions: domainTable<string, SessionRecord>(sessionSchema),
    windows: domainTable<string, WindowRecord>(windowSchema),
    unknown: domainTable<string, UnknownRecord>(unknownSchema),
  },
})
