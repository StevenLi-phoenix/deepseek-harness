/** Durable bus state: every published event, pending subscription work, and dispatched batches. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

const eventRecordSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  kind: z.string().min(1),
  key: z.string().min(1),
  subject: z.string().min(1),
  title: z.string().min(1),
  url: z.string().optional(),
  actor: z.string().optional(),
  text: z.string().optional(),
  occurredAt: z.number().optional(),
  receivedAt: z.number(),
  outcome: z.enum(['accepted', 'suppressed', 'unmatched']),
  reason: z.string().optional(),
  subscriptions: z.array(z.string()),
}).strict()

const pendingRecordSchema = z.object({
  subscription: z.string().min(1),
  eventId: z.string().min(1),
  enqueuedAt: z.number(),
}).strict()

const batchRecordSchema = z.object({
  id: z.string().min(1),
  subscription: z.string().min(1),
  action: z.enum(['notify', 'session']),
  title: z.string(),
  eventIds: z.array(z.string()),
  createdAt: z.number(),
  /** `dispatched` → handed to the actuator; `delivered` → notify accepted; `completed` → Session ended its first turn. */
  status: z.enum(['dispatched', 'delivered', 'completed', 'failed']),
  error: z.string().optional(),
  sessionId: z.string().optional(),
  outcome: z.string().optional(),
}).strict()

/** One published, non-duplicate event and what the bus decided about it. */
export type LsyEventRecord = z.infer<typeof eventRecordSchema>
/** One event waiting for one subscription's next batch. */
export type PendingRecord = z.infer<typeof pendingRecordSchema>
/** One batch handed to an actuator. */
export type BatchRecord = z.infer<typeof batchRecordSchema>

/** Bus storage; malformed rows reject opening the domain. */
export const busDomain = defineDomain({
  name: 'lsy_event_bus',
  version: 1,
  tables: {
    events: domainTable<string, LsyEventRecord>(eventRecordSchema),
    pending: domainTable<string, PendingRecord>(pendingRecordSchema),
    batches: domainTable<string, BatchRecord>(batchRecordSchema),
  },
})
