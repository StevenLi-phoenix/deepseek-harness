import type { Branded } from '@deepseek-ai/dsh-brand'
import { describe, expect, it } from 'vitest'
import {
  PROTOCOL_VERSION,
  assertNever,
  callPushPayload,
  connectBody,
  deviceBody,
  isCallId,
  isDeviceId,
  parseAppMessage,
  placeCallBody,
  registerDeviceBody,
  serverFrame,
  type CallId,
} from '../src/protocol.ts'

const callId: CallId = '3f2c8a1e-9b4d-4c6e-8f0a-1b2c3d4e5f60' as Branded<'VoiceCallId'>

describe('path ids', () => {
  it('accepts device ids of 8 to 64 letters, digits, and hyphens', () => {
    expect(isDeviceId('ABCDEF12')).toBe(true)
    expect(isDeviceId('a'.repeat(64))).toBe(true)
    expect(isDeviceId('A1B2-C3D4-E5F6')).toBe(true)
    expect(isDeviceId('short')).toBe(false)
    expect(isDeviceId('a'.repeat(65))).toBe(false)
    expect(isDeviceId('has space here')).toBe(false)
    expect(isDeviceId('../../etc')).toBe(false)
  })

  it('accepts only lower-case UUIDs as call ids', () => {
    expect(isCallId(callId)).toBe(true)
    expect(isCallId(callId.toUpperCase())).toBe(false)
    expect(isCallId('not-a-uuid')).toBe(false)
    expect(isCallId(`${callId}0`)).toBe(false)
  })
})

describe('request bodies', () => {
  it('registers a device with a lower-case hex VoIP token', () => {
    const body = { voipToken: 'ab'.repeat(32), environment: 'sandbox', name: '  Phone  ' }
    expect(registerDeviceBody.parse(body)).toEqual({ voipToken: 'ab'.repeat(32), environment: 'sandbox', name: 'Phone' })
    expect(registerDeviceBody.safeParse({ ...body, voipToken: 'AB'.repeat(32) }).success).toBe(false)
    expect(registerDeviceBody.safeParse({ ...body, environment: 'staging' }).success).toBe(false)
    expect(registerDeviceBody.safeParse({ ...body, name: '   ' }).success).toBe(false)
    expect(registerDeviceBody.safeParse({ ...body, extra: true }).success).toBe(false)
  })

  it('checks the device id of place, connect, decline, and hang-up bodies', () => {
    expect(placeCallBody.safeParse({ deviceId: 'ABCDEF12' }).success).toBe(true)
    expect(placeCallBody.safeParse({ deviceId: 'x' }).success).toBe(false)
    expect(deviceBody.safeParse({ deviceId: 'ABCDEF12' }).success).toBe(true)
    expect(deviceBody.safeParse({ deviceId: 'ABCDEF12', more: 1 }).success).toBe(false)
    expect(connectBody.safeParse({ deviceId: 'ABCDEF12', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0' }).success).toBe(true)
    expect(connectBody.safeParse({ deviceId: 'ABCDEF12', sdp: 'v=0' }).success).toBe(false)
    expect(connectBody.safeParse({ deviceId: 'ABCDEF12', sdp: 'x'.repeat(32_769) }).success).toBe(false)
  })
})

describe('the VoIP push payload', () => {
  it('carries the call under dsh with an empty aps member', () => {
    expect(callPushPayload({ callId, reason: 'Build finished', createdAt: 42 }, 'DSH')).toEqual({
      aps: {},
      dsh: { v: PROTOCOL_VERSION, callId, reason: 'Build finished', caller: 'DSH', createdAt: 42 },
    })
  })

  it('cuts a long reason to 120 code points without splitting a character', () => {
    const reason = '😀'.repeat(200)
    const payload = callPushPayload({ callId, reason, createdAt: 1 }, 'DSH')
    expect(Array.from(payload.dsh.reason)).toHaveLength(120)
    expect(payload.dsh.reason).toBe('😀'.repeat(120))
  })

  it('sends an empty reason for an owner-placed call without one', () => {
    expect(callPushPayload({ callId, reason: null, createdAt: 1 }, 'DSH').dsh.reason).toBe('')
  })
})

describe('control messages', () => {
  it('parses each version 1 message from the app without its version', () => {
    expect(parseAppMessage('{"v":1,"type":"utterance","text":"hello"}')).toEqual({ type: 'utterance', text: 'hello' })
    expect(parseAppMessage('{"v":1,"type":"speaking"}')).toEqual({ type: 'speaking' })
    expect(parseAppMessage('{"v":1,"type":"interrupt"}')).toEqual({ type: 'interrupt' })
    expect(parseAppMessage('{"v":1,"type":"hangup"}')).toEqual({ type: 'hangup' })
  })

  it('ignores frames that are not JSON, another version, an unknown type, or too long', () => {
    expect(parseAppMessage('not json')).toBeUndefined()
    expect(parseAppMessage('{"v":2,"type":"hangup"}')).toBeUndefined()
    expect(parseAppMessage('{"v":1,"type":"wave"}')).toBeUndefined()
    expect(parseAppMessage('{"type":"hangup"}')).toBeUndefined()
    expect(parseAppMessage(JSON.stringify({ v: 1, type: 'utterance', text: 'x'.repeat(4001) }))).toBeUndefined()
  })

  it('serializes server messages with the protocol version first', () => {
    expect(serverFrame({ type: 'state', state: 'thinking' })).toBe('{"v":1,"type":"state","state":"thinking"}')
    expect(serverFrame({ type: 'hangup', reason: 'done' })).toBe('{"v":1,"type":"hangup","reason":"done"}')
  })
})

describe('closed unions', () => {
  it('throws with the context and the value that should not exist', () => {
    expect(() => assertNever(JSON.parse('{"kind":"y"}') as never, 'kind')).toThrow('unexpected kind: {"kind":"y"}')
  })
})
