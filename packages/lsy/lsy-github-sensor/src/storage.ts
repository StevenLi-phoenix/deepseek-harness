/** Durable sensor state: polling cursors per stream and repository watches created at run time. */
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

const watchSchema = z.object({
  /** Watch id chosen by the caller, e.g. the matching bus subscription id. */
  ref: z.string().min(1),
  /** `owner/name`. */
  repo: z.string().min(1),
  /** Streams to poll, in order. */
  watch: z.array(z.enum(['releases', 'commits', 'tags'])).min(1),
  /** Branch for `commits`; the default branch when unset. */
  branch: z.string().min(1).optional(),
  createdAt: z.number(),
}).strict()

/** One stream's polling state. */
export type StreamCursor = z.infer<typeof cursorSchema>
/** One repository watch created at run time. */
export type WatchRecord = z.infer<typeof watchSchema>

/**
 * Sensor storage: cursors keyed by stream id (`repo:<owner/name>:<kind>`,
 * `repo:<owner/name>:commits@<branch>`, or `notifications`) and watches keyed by ref.
 */
export const sensorDomain = defineDomain({
  name: 'lsy_github_sensor',
  version: 1,
  tables: {
    cursors: domainTable<string, StreamCursor>(cursorSchema),
    watches: domainTable<string, WatchRecord>(watchSchema),
  },
})
