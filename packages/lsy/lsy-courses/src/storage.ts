/** Durable reminder state: the keys already sent, the latest messages, and the poll, sync-alert, and outage records. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

const sentSchema = z.object({
  at: z.number(),
  taskId: z.string(),
  title: z.string(),
  phase: z.enum(['due', 'late']),
  checkpoint: z.union([z.number(), z.literal('open')]),
  deadline: z.number(),
}).strict()

const noteSchema = z.object({
  seq: z.number().int(),
  at: z.number(),
  title: z.string(),
  body: z.string(),
  kinds: z.array(z.string()),
  outcome: z.enum(['sent', 'failed']),
  error: z.string().optional(),
}).strict()

const pollSchema = z.object({
  at: z.number(),
  trigger: z.enum(['timer', 'manual']),
  durationMs: z.number(),
  ok: z.boolean(),
  error: z.string().optional(),
  openTasks: z.number().int().optional(),
  reminders: z.number().int().optional(),
  outcome: z.enum(['none', 'sent', 'held', 'failed', 'disabled']).optional(),
  syncStatus: z.string().optional(),
}).strict()

const syncSchema = z.object({
  active: z.boolean(),
  alertedAt: z.number().nullable(),
  cleanAt: z.number().nullable(),
}).strict()

const outageSchema = z.object({
  failures: z.number().int(),
  since: z.number().nullable(),
  alerted: z.boolean(),
}).strict()

/** One reminder key that went out. */
export type SentRecord = z.infer<typeof sentSchema>
/** One message the plugin sent or failed to send. */
export type NoteRecord = z.infer<typeof noteSchema>
/** The latest poll. */
export type PollRecord = z.infer<typeof pollSchema>
/** The sync alert. */
export type SyncRecord = z.infer<typeof syncSchema>
/** Consecutive failed polls and whether the owner was told. */
export type OutageRecord = z.infer<typeof outageSchema>

/** Storage domain `lsy_courses`: `sent` by reminder key, `notes` by sequence, one row each (key `latest`) in `poll`, `sync`, `outage`. */
export const coursesDomain = defineDomain({
  name: 'lsy_courses',
  version: 1,
  tables: {
    sent: domainTable<string, SentRecord>(sentSchema),
    notes: domainTable<string, NoteRecord>(noteSchema),
    poll: domainTable<string, PollRecord>(pollSchema),
    sync: domainTable<string, SyncRecord>(syncSchema),
    outage: domainTable<string, OutageRecord>(outageSchema),
  },
})
