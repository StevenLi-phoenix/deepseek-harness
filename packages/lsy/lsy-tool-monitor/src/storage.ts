/** Durable monitor records: what the host starts again after a restart. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

const monitorSchema = z.object({
  /** Session the monitor reports to. */
  owner: z.string().min(1),
  command: z.string().min(1),
  description: z.string(),
  /** Working directory the command runs in. */
  cwd: z.string().min(1),
  /** First start, in Unix epoch milliseconds; a restart keeps it. */
  startedAt: z.number(),
  /** When the host stops the monitor, in Unix epoch milliseconds; absent for a persistent monitor. */
  deadline: z.number().optional(),
}).strict()

/** One running monitor as stored. Its environment is never stored: every start scrubs the host's again. */
export type MonitorRecord = z.infer<typeof monitorSchema>

/** Monitor storage: `monitors` is keyed by monitor id and holds the monitors that are running. */
export const monitorDomain = defineDomain({
  name: 'lsy_tool_monitor',
  version: 1,
  tables: {
    monitors: domainTable<string, MonitorRecord>(monitorSchema),
  },
})
