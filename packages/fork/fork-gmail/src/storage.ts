/**
 * Durable Gmail state outside the credential store: each account's address, policy, and health; the messages held
 * for the owner's confirmation; and the latest activity for Settings. Refresh tokens never live here: they are grant
 * records in `ctx.credentials` (`fork-gmail/<account>`).
 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

const accountSchema = z.object({
  id: z.string(),
  email: z.string(),
  /** Display name of the primary send-as address; empty when Gmail has none. */
  name: z.string(),
  policy: z.enum(['read-only', 'confirm-all', 'confirm-untrusted', 'direct']),
  addedAt: z.number(),
  /** Last call that succeeded. */
  lastOkAt: z.number().nullable(),
  /** Last failure, shown in Settings. */
  lastError: z.string().nullable(),
  /** Google refused the refresh token: the owner must sign in again. */
  needsReconnect: z.boolean(),
  /** When the owner was told about `needsReconnect`; null until then. */
  reconnectNoticeAt: z.number().nullable(),
}).strict()

const pendingSchema = z.object({
  code: z.string(),
  account: z.string(),
  from: z.string(),
  draftId: z.string(),
  threadId: z.string().nullable(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  subject: z.string(),
  preview: z.string(),
  attachments: z.array(z.string()),
  createdAt: z.number(),
  origin: z.string(),
  reason: z.string(),
  sessionId: z.string().nullable(),
  status: z.enum(['held', 'sent', 'discarded', 'expired']),
  resolvedAt: z.number().nullable(),
  resolvedBy: z.enum(['settings', 'owner-turn', 'expiry']).nullable(),
  messageId: z.string().nullable(),
  /** Whether the owner's WeChat notice went out. */
  noticeSent: z.boolean(),
  /** SHA-256 over the held draft's recipients, subject, text, and attachment names; a changed draft is never sent. */
  fingerprint: z.string(),
}).strict()

const activitySchema = z.object({
  seq: z.number().int(),
  at: z.number(),
  account: z.string(),
  kind: z.enum(['connected', 'removed', 'policy', 'sent', 'held', 'confirmed', 'discarded', 'expired', 'drafted', 'modified', 'refused', 'error', 'reconnect']),
  detail: z.string(),
}).strict()

const sendsSchema = z.object({
  /** Unix epoch milliseconds of the sends in the last 24 hours. */
  at: z.array(z.number()),
}).strict()

/** One connected account, without its token. */
export type AccountRecord = z.infer<typeof accountSchema>
/** One message held for the owner's confirmation. */
export type PendingRecord = z.infer<typeof pendingSchema>
/** One line of the activity list. */
export type ActivityRecord = z.infer<typeof activitySchema>
/** The recent sends of one account, for the daily cap. */
export type SendsRecord = z.infer<typeof sendsSchema>

/**
 * Storage domain `fork_gmail`: `accounts` by account id, `pending` by code, `activity` by zero-padded sequence, and
 * `sends` by account id.
 */
export const gmailDomain = defineDomain({
  name: 'fork_gmail',
  version: 1,
  tables: {
    accounts: domainTable<string, AccountRecord>(accountSchema),
    pending: domainTable<string, PendingRecord>(pendingSchema),
    activity: domainTable<string, ActivityRecord>(activitySchema),
    sends: domainTable<string, SendsRecord>(sendsSchema),
  },
})
