/** Durable state: the owner's registered devices and the record of each call. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

const deviceSchema = z.object({
  /** PushKit token as lower-case hex. */
  voipToken: z.string().min(1),
  environment: z.enum(['sandbox', 'production']),
  /** Name the app reported, e.g. the phone's name. */
  name: z.string(),
  /** First registration, in Unix epoch milliseconds. */
  registeredAt: z.number(),
  /** Latest registration or token change. */
  updatedAt: z.number(),
}).strict()

const lineSchema = z.object({
  role: z.enum(['owner', 'agent']),
  text: z.string(),
  at: z.number(),
}).strict()

const callSchema = z.object({
  initiator: z.enum(['agent', 'owner']),
  state: z.enum(['ringing', 'connecting', 'active', 'ended']),
  /** Why the agent called; null for the owner's calls. */
  reason: z.string().nullable(),
  createdAt: z.number(),
  answeredAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  outcome: z.enum(['completed', 'declined', 'missed', 'failed', 'cancelled']).nullable(),
  /** Why the call failed or was cancelled, for the log and the caller. */
  detail: z.string().nullable(),
  /** Device that picked the call up. */
  deviceId: z.string().nullable(),
  /** The call's conversation Session, once it exists. */
  sessionId: z.string().nullable(),
  /** What was said, oldest first; kept for the caller and the main agent. */
  transcript: z.array(lineSchema),
}).strict()

/** One registered device, keyed by device id. */
export type DeviceRecord = z.infer<typeof deviceSchema>
/** One line of a call's transcript. */
export type TranscriptLine = z.infer<typeof lineSchema>
/** One call, keyed by call id. */
export type CallRecord = z.infer<typeof callSchema>

/** Service storage: `devices` keyed by device id, `calls` keyed by call id. */
export const voiceCallDomain = defineDomain({
  name: 'voice_call',
  version: 1,
  tables: {
    devices: domainTable<string, DeviceRecord>(deviceSchema),
    calls: domainTable<string, CallRecord>(callSchema),
  },
})
