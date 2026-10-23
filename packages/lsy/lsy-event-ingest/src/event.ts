/**
 * Validation of one pushed event. The token decides the source; the body only
 * describes the event, and every field is bounded before it reaches the bus.
 */

import type { LsyEventInput } from '@deepseek-ai/dsh-lsy-event-bus'

/** Field limits, in UTF-16 code units. */
export const LIMITS = { kind: 100, key: 200, subject: 200, title: 300, text: 8000, url: 2000 } as const

const FIELDS = new Set(['kind', 'key', 'subject', 'title', 'text', 'url', 'occurredAt'])
const KIND = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+$/u

/** A body the route refuses, with a message safe to send back. */
export class InvalidEvent extends Error {}

function line(body: Record<string, unknown>, field: 'key' | 'subject' | 'title'): string {
  const value = body[field]
  if (typeof value !== 'string') throw new InvalidEvent(`${field} must be a string`)
  const text = value.replace(/\s+/gu, ' ').trim()
  if (text === '' || text.length > LIMITS[field]) throw new InvalidEvent(`${field} must be 1-${String(LIMITS[field])} characters`)
  return text
}

/**
 * Turn a parsed body into a bus event for `source`.
 * @param source - the source the request's token belongs to.
 * @param body - parsed JSON.
 * @throws InvalidEvent naming the first field that fails.
 */
export function eventFrom(source: string, body: unknown): LsyEventInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new InvalidEvent('body must be a JSON object')
  const record = body as Record<string, unknown>
  const unknown = Object.keys(record).filter(field => !FIELDS.has(field))
  if (unknown.length > 0) throw new InvalidEvent(`unknown field(s) ${unknown.join(', ')}; the token sets the source`)
  const kind = record['kind']
  if (typeof kind !== 'string' || kind.length > LIMITS.kind || !KIND.test(kind) || !kind.startsWith(`${source}.`)) {
    throw new InvalidEvent(`kind must be dotted lowercase words starting with "${source}.", at most ${String(LIMITS.kind)} characters`)
  }
  const text = record['text']
  if (text !== undefined && (typeof text !== 'string' || text.length > LIMITS.text)) throw new InvalidEvent(`text must be a string of at most ${String(LIMITS.text)} characters`)
  const url = record['url']
  if (url !== undefined && (typeof url !== 'string' || url.length > LIMITS.url || !/^https?:\/\/\S+$/u.test(url))) {
    throw new InvalidEvent('url must be an http(s) URL')
  }
  const occurredAt = record['occurredAt']
  if (occurredAt !== undefined && (typeof occurredAt !== 'number' || !Number.isSafeInteger(occurredAt) || occurredAt <= 0)) {
    throw new InvalidEvent('occurredAt must be epoch milliseconds')
  }
  return {
    source,
    kind,
    key: line(record, 'key'),
    subject: line(record, 'subject'),
    title: line(record, 'title'),
    ...text === undefined || text === '' ? {} : { text },
    ...url === undefined ? {} : { url },
    ...occurredAt === undefined ? {} : { occurredAt },
  }
}
