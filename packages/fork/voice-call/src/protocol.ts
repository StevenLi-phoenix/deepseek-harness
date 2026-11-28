/**
 * Version 1 of the wire protocol between the DSH Call app and this service: the HTTP bodies, the
 * VoIP push payload, and the JSON messages on the WebRTC `control` data channel. The app in
 * `fork/apps/voice-call-ios` implements the other side.
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'

/** Protocol version carried in the push payload, the health answer, and every control message. */
export const PROTOCOL_VERSION = 1

/** Call id: a UUID minted by this service. */
export type CallId = Branded<'VoiceCallId'>
/** Device id: a UUID the app generates once. */
export type DeviceId = Branded<'VoiceCallDeviceId'>

/** Who placed the call. */
export type CallInitiator = 'agent' | 'owner'
/** Where a call stands. */
export type CallState = 'ringing' | 'connecting' | 'active' | 'ended'
/** How an ended call ended. */
export type CallOutcome = 'completed' | 'declined' | 'missed' | 'failed' | 'cancelled'
/** APNs environment of a device token. */
export type ApnsEnvironment = 'sandbox' | 'production'
/** Where speech is recognized or synthesized. */
export type SpeechMode = 'server' | 'device'

/** A call as the app reads it. */
export interface CallView {
  callId: CallId
  initiator: CallInitiator
  state: CallState
  reason: string | null
  createdAt: number
  answeredAt: number | null
  endedAt: number | null
  outcome: CallOutcome | null
}

/** A registered device as the app reads it; the push token is never returned. */
export interface DeviceView {
  deviceId: DeviceId
  name: string
  environment: ApnsEnvironment
  registeredAt: number
}

const DEVICE_ID = /^[A-Za-z0-9-]{8,64}$/u
const CALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/**
 * Whether a path segment is a device id.
 * @param value - the segment.
 * @returns true for 8 to 64 letters, digits, or hyphens.
 */
export function isDeviceId(value: string): value is DeviceId {
  return DEVICE_ID.test(value)
}

/**
 * Whether a path segment is a call id.
 * @param value - the segment.
 * @returns true for a lower-case UUID.
 */
export function isCallId(value: string): value is CallId {
  return CALL_ID.test(value)
}

/** `PUT /devices/{deviceId}` body. */
export const registerDeviceBody = z.object({
  /** PushKit token as lower-case hex. */
  voipToken: z.string().regex(/^[0-9a-f]{64,512}$/u, 'voipToken must be lower-case hex'),
  environment: z.enum(['sandbox', 'production']),
  name: z.string().trim().min(1).max(100),
}).strict()

/** `POST /calls` body. */
export const placeCallBody = z.object({
  deviceId: z.string().regex(DEVICE_ID),
}).strict()

/** `POST /calls/{id}/connect` body. */
export const connectBody = z.object({
  deviceId: z.string().regex(DEVICE_ID),
  /** The complete SDP offer, ICE candidates included. */
  sdp: z.string().min(10).max(32_768),
}).strict()

/** `POST /calls/{id}/decline` and `/hangup` body. */
export const deviceBody = z.object({
  deviceId: z.string().regex(DEVICE_ID),
}).strict()

/** `GET /health` answer. */
export interface HealthView {
  v: typeof PROTOCOL_VERSION
  enabled: boolean
  speech: { stt: SpeechMode; tts: SpeechMode }
}

/** The `dsh` member of a VoIP push. */
export interface CallPush {
  v: typeof PROTOCOL_VERSION
  callId: CallId
  reason: string
  caller: string
  createdAt: number
}

/** Longest reason sent in a push, in code points; APNs caps a VoIP payload at 5 KB. */
const PUSH_REASON_CHARS = 120

/**
 * The VoIP push payload of a ringing call.
 * @param call - the call.
 * @param caller - the name CallKit shows.
 * @returns the APNs JSON body.
 */
export function callPushPayload(call: Pick<CallView, 'callId' | 'reason' | 'createdAt'>, caller: string): { aps: Record<string, never>; dsh: CallPush } {
  return {
    aps: {},
    dsh: { v: PROTOCOL_VERSION, callId: call.callId, reason: Array.from(call.reason ?? '').slice(0, PUSH_REASON_CHARS).join(''), caller, createdAt: call.createdAt },
  }
}

/** What the agent is doing, shown in the call screen. */
export type AgentActivity = 'listening' | 'thinking' | 'speaking'

/** Messages this service sends on the control channel. */
export type ServerMessage =
  | { v: typeof PROTOCOL_VERSION; type: 'state'; state: AgentActivity }
  | { v: typeof PROTOCOL_VERSION; type: 'transcript'; role: 'owner' | 'agent'; text: string }
  | { v: typeof PROTOCOL_VERSION; type: 'say'; text: string }
  | { v: typeof PROTOCOL_VERSION; type: 'stop-speaking' }
  | { v: typeof PROTOCOL_VERSION; type: 'hangup'; reason: string }

/** Messages the app sends on the control channel. */
export type AppMessage =
  | { type: 'utterance'; text: string }
  | { type: 'speaking' }
  | { type: 'interrupt' }
  | { type: 'hangup' }

const appMessage = z.discriminatedUnion('type', [
  z.object({ v: z.literal(PROTOCOL_VERSION), type: z.literal('utterance'), text: z.string().max(4000) }),
  z.object({ v: z.literal(PROTOCOL_VERSION), type: z.literal('speaking') }),
  z.object({ v: z.literal(PROTOCOL_VERSION), type: z.literal('interrupt') }),
  z.object({ v: z.literal(PROTOCOL_VERSION), type: z.literal('hangup') }),
])

/**
 * Parse one control message from the app.
 * @param raw - the data channel frame.
 * @returns the message, or undefined for a frame that is not a version 1 message this service knows;
 *   unknown types are ignored so the app may add some.
 */
export function parseAppMessage(raw: string): AppMessage | undefined {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return undefined
  }
  const parsed = appMessage.safeParse(json)
  if (!parsed.success) return undefined
  const { v: _version, ...message } = parsed.data
  return message
}

/**
 * Serialize one control message for the app.
 * @param message - the message without its version.
 * @returns the JSON frame.
 */
export function serverFrame(message: DistributiveOmit<ServerMessage, 'v'>): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, ...message })
}

/** `Omit` applied to each member of a union. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/**
 * Fail on a value a closed union cannot hold.
 * @param value - the impossible value.
 * @param context - what was being switched on.
 * @returns never.
 * @throws always.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`unexpected ${context}: ${JSON.stringify(value)}`)
}
