import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as protocol from '../src/protocol.ts'

const FIXTURES = join(import.meta.dirname, 'protocol-fixtures', 'v1.0')
const FIXTURES_1_1 = join(import.meta.dirname, 'protocol-fixtures', 'v1.1')
const read = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'))
const read11 = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES_1_1, `${name}.json`), 'utf8'))

/** The frozen v1.0 samples, each with the schema that must keep accepting it. */
const SAMPLES: Record<string, z.ZodType> = {
  'hello': protocol.HelloDto,
  'status': protocol.StatusDto,
  'groups': z.array(protocol.GroupDto),
  'messages': protocol.MessageListDto,
  'message-page': protocol.MessagePageDto,
  'search-request': protocol.SearchRequestDto,
  'lookup-request': protocol.LookupRequestDto,
  'members': protocol.MembersDto,
  'config': protocol.RecorderConfigDto,
  'config-applied': protocol.ConfigAppliedDto,
  'login': protocol.LoginDto,
  'refresh': protocol.RefreshDto,
  'events': z.array(protocol.EventDto),
  'legacy-state': protocol.LegacyDigestStateDto,
  'error': protocol.ErrorDto,
}

describe('protocol v1.0 fixtures', () => {
  it('has a fixture for every sample and no stray file', () => {
    expect(readdirSync(FIXTURES).map(name => name.replace(/\.json$/, '')).sort()).toEqual(Object.keys(SAMPLES).sort())
  })

  it.each(Object.entries(SAMPLES))('still parses %s (changes are additive only)', (name, schema) => {
    const parsed = schema.safeParse(read(name))
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true)
  })

  it('round-trips: what parses serializes back to the same value, plus the defaults a later minor added', () => {
    for (const [name, schema] of Object.entries(SAMPLES)) {
      const value = read(name)
      expect(schema.parse(value), name).toMatchObject(value as object)
    }
  })

  it('reads a message of a v1.0 recorder, which has no media field, as one with no media', () => {
    const [message] = protocol.MessageListDto.parse(read('messages'))
    expect(message).toMatchObject({ text: '今天讨论部署', media: [] })
  })
})

describe('protocol v1.1 fixtures (added in the minor that introduced media)', () => {
  const SAMPLES_1_1: Record<string, z.ZodType> = {
    'hello': protocol.HelloDto,
    'message-media': protocol.MessageDto,
    'message-page-media': protocol.MessagePageDto,
    'media-header': protocol.MediaHeaderDto,
  }

  it.each(Object.entries(SAMPLES_1_1))('parses %s and serializes it back unchanged', (name, schema) => {
    const value = read11(name)
    expect(schema.parse(value), name).toEqual(value)
  })

  it('refuses a media reference that is not one, and a file type that is not a picture the models read once the type is known', () => {
    expect(protocol.MediaRefDto.safeParse('../etc/passwd').success).toBe(false)
    expect(protocol.MediaRefDto.safeParse('m12ab').success).toBe(true)
    expect(protocol.MediaHeaderDto.parse({ contentType: 'image/avif', bytes: 1, groupId: '123456' }).contentType).toBe('unknown')
  })
})

describe('evolution rules', () => {
  it('strips keys it does not know, in answers and in requests, so a newer end can add fields', () => {
    const newer = { ...(read('hello') as object), addedLater: true, protocol: { name: 'qq-recorder', major: 1, minor: 7, extra: 1 } }
    expect(protocol.HelloDto.parse(newer)).toEqual({ protocol: { name: 'qq-recorder', major: 1, minor: 7 }, build: '3f9a1c0d7b2e', startedAt: 1790000000000 })
    expect(protocol.SearchRequestDto.parse({ ...(read('search-request') as object), later: 1 })).not.toHaveProperty('later')
  })

  it('reads an enumeration value it does not know as unknown instead of failing', () => {
    const status = structuredClone(read('status')) as { connection: { state: string } }
    status.connection.state = 'hibernating'
    expect(protocol.StatusDto.parse(status).connection.state).toBe('unknown')
    expect(protocol.LoginDto.parse({ ...(read('login') as object), door: 'moved', state: 'teleporting' })).toMatchObject({ door: 'unknown', state: 'unknown' })
  })

  it('skips an event type it does not know', () => {
    expect(protocol.EventDto.safeParse({ type: 'from-the-future' }).success).toBe(false)
  })

  it('refuses what is not the protocol: a bad cursor, a bad group number, a token variable outside the recorder\'s secrets', () => {
    expect(protocol.CursorDto.safeParse('has space').success).toBe(false)
    expect(protocol.LookupRequestDto.safeParse({ groupId: 'abc', messageIds: [] }).success).toBe(false)
    expect(protocol.LookupRequestDto.safeParse({ groupId: '123456', messageIds: Array.from({ length: 201 }, (_unused, i) => String(i)) }).success).toBe(false)
    const config = { ...(read('config') as object), tokenEnv: 'QQ_RECORDER_TOKEN' }
    expect(protocol.RecorderConfigDto.safeParse(config).success).toBe(false)
  })

  it('writes the protocol tag both ends send, and reads it back', () => {
    expect(protocol.protocolTag()).toBe('qq-recorder/1.1')
    expect(protocol.parseProtocolTag('qq-recorder/1.4')).toEqual({ major: 1, minor: 4 })
    expect(protocol.parseProtocolTag('other/1.0')).toBeUndefined()
    expect(protocol.parseProtocolTag(undefined)).toBeUndefined()
  })

  it('tags every optional capability with the minor that introduced it', () => {
    for (const [feature, minor] of Object.entries(protocol.FEATURE_MINOR)) {
      expect(Number.isInteger(minor) && minor >= 0 && minor <= protocol.PROTOCOL.minor, feature).toBe(true)
    }
  })
})
