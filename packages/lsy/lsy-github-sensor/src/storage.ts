/** Durable polling cursors: validators, seen ids, and poll pacing per stream. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

const cursorSchema = z.object({
  /** `ETag` of the last 200 response, sent as `If-None-Match`. */
  etag: z.string().optional(),
  /** `Last-Modified` of the last 200 response, sent as `If-Modified-Since`. */
  lastModified: z.string().optional(),
  /** Ids already seen, newest first, bounded by `maxSeenPerStream`. */
  seen: z.array(z.string()),
  /** False until the first successful poll recorded the baseline. */
  initialized: z.boolean(),
  /** Earliest next poll from `X-Poll-Interval`, in Unix epoch milliseconds. */
  nextPollAt: z.number().optional(),
}).strict()

/** One stream's polling state. */
export type StreamCursor = z.infer<typeof cursorSchema>

/** Sensor storage, keyed by stream id (`repo:<owner/name>:<kind>` or `notifications`). */
export const sensorDomain = defineDomain({
  name: 'lsy_github_sensor',
  version: 1,
  tables: {
    cursors: domainTable<string, StreamCursor>(cursorSchema),
  },
})
