/** Durable bus state: published events, pending subscription work, dispatched batches, run-time subscriptions, persistent Sessions. */
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
  /** True when the Session's final answer was the silent reply, so no result message was sent. */
  silent: z.boolean().optional(),
  /** How a `session` batch was delivered (absent on rows written before persistent Sessions). */
  delivery: z.enum(['fresh', 'persistent-new', 'persistent', 'rollover', 'detached']).optional(),
}).strict()

const persistentRecordSchema = z.object({
  subscription: z.string().min(1),
  sessionId: z.string().min(1),
  createdAt: z.number(),
  batches: z.number().int().min(0),
  compactions: z.number().int().min(0),
  /** Text of the Session's latest compaction summary, bounded; seeds the next Session at a rollover. */
  lastSummary: z.string().optional(),
  /** The Session this one replaced at a rollover; archived once this one exists. */
  previous: z.string().optional(),
}).strict()

const sessionActionSchema = z.object({
  workspacePath: z.string().min(1),
  agentPreset: z.string().min(1),
  permissionPreset: z.string().min(1),
  instructions: z.string().min(1),
  titlePrefix: z.string().optional(),
  maxPromptEvents: z.number().int().min(1),
  maxTextChars: z.number().int().min(1),
}).strict()

const subscriptionRecordSchema = z.object({
  id: z.string().min(1),
  sources: z.array(z.string()),
  kinds: z.array(z.string()),
  subjects: z.array(z.string()),
  action: z.enum(['notify', 'session']),
  coalesceMs: z.number().int().min(0),
  maxPerHour: z.number().int().min(1),
  session: sessionActionSchema.optional(),
  createdAt: z.number(),
  /** Session whose agent created the subscription. */
  createdBy: z.string().optional(),
  /** Set by `setPaused()`: new events no longer match and pending ones wait. */
  paused: z.literal(true).optional(),
}).strict()

/** One published, non-duplicate event and what the bus decided about it. */
export type ForkEventRecord = z.infer<typeof eventRecordSchema>
/** One event waiting for one subscription's next batch. */
export type PendingRecord = z.infer<typeof pendingRecordSchema>
/** One batch handed to an actuator. */
export type BatchRecord = z.infer<typeof batchRecordSchema>
/** One subscription created at run time, keyed by its id. */
export type SubscriptionRecord = z.infer<typeof subscriptionRecordSchema>
/** The persistent Session of one subscription, keyed by subscription id. */
export type PersistentRecord = z.infer<typeof persistentRecordSchema>

/** Bus storage; malformed rows reject opening the domain. */
export const busDomain = defineDomain({
  name: 'fork_event_bus',
  version: 1,
  tables: {
    events: domainTable<string, ForkEventRecord>(eventRecordSchema),
    pending: domainTable<string, PendingRecord>(pendingRecordSchema),
    batches: domainTable<string, BatchRecord>(batchRecordSchema),
    subscriptions: domainTable<string, SubscriptionRecord>(subscriptionRecordSchema),
    persistent: domainTable<string, PersistentRecord>(persistentRecordSchema),
  },
})
