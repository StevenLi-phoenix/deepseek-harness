import { untrustedRequestId } from '@deepseek-ai/dsh-turn-taint'
import { describe, expect, it } from 'vitest'
import { formatGap, formatStamp } from '../src/format.ts'
import { classifyArrival, incomingKind, measureGap, timeGapNotice, timeGapSummary } from '../src/notice.ts'

const zone = 'America/New_York'
const now = Date.parse('2026-11-01T13:30:00Z')
const MIN = 60_000
const threshold = 5 * MIN

describe('formatStamp and formatGap', () => {
  it('writes the wall clock in the zone and the gap in at most two units', () => {
    expect(formatStamp(now, zone)).toBe('Sun 2026-11-01 08:30')
    expect(formatStamp(now, 'Asia/Shanghai')).toBe('Sun 2026-11-01 21:30')
    expect(formatGap(59_000)).toBe('under a minute')
    expect(formatGap(12 * MIN + 59_000)).toBe('12 min')
    expect(formatGap(5 * 3_600_000)).toBe('5 h')
    expect(formatGap(5 * 3_600_000 + 39 * MIN)).toBe('5 h 39 min')
    expect(formatGap(2 * 86_400_000 + 3 * 3_600_000 + 7 * MIN)).toBe('2 d 3 h')
    expect(formatGap(3 * 86_400_000)).toBe('3 d')
    expect(formatGap(-5)).toBe('under a minute')
  })
})

describe('measureGap', () => {
  it('gives no gap for the first input of a Session', () => {
    expect(measureGap(now, { lastIncomingAt: null, lastReplyAt: null }, threshold)).toBeUndefined()
  })

  it('gives no gap under the threshold, measured from the later of the last reply and the last input', () => {
    expect(measureGap(now, { lastIncomingAt: now - 4 * MIN, lastReplyAt: null }, threshold)).toBeUndefined()
    expect(measureGap(now, { lastIncomingAt: now - 60 * MIN, lastReplyAt: now - 4 * MIN }, threshold)).toBeUndefined()
    expect(measureGap(now, { lastIncomingAt: now - 4 * MIN, lastReplyAt: now - 60 * MIN }, threshold)).toBeUndefined()
  })

  it('counts a spell of exactly the threshold, and says what the last activity was', () => {
    expect(measureGap(now, { lastIncomingAt: now - 6 * MIN, lastReplyAt: now - 5 * MIN }, threshold))
      .toEqual({ gapMs: 5 * MIN, lastAt: now - 5 * MIN, last: 'reply' })
    expect(measureGap(now, { lastIncomingAt: now - 70 * MIN, lastReplyAt: now - 90 * MIN }, threshold))
      .toEqual({ gapMs: 70 * MIN, lastAt: now - 70 * MIN, last: 'incoming' })
  })
})

describe('classifyArrival', () => {
  const senders = new Set(['qqbot'])

  it('reads the input kind from the source alone', () => {
    expect(incomingKind({ kind: 'user' })).toBe('message')
    expect(incomingKind({ kind: 'webhook' })).toBe('event')
    expect(incomingKind({ kind: 'tool-monitor' })).toBe('event')
    expect(incomingKind({ kind: 'old-tool-monitor' })).toBe('event')
    expect(incomingKind({ kind: 'schedule' })).toBe('reminder')
    for (const kind of ['owner-memory', 'time-context', 'time-gap', 'wechat', 'agent-instructions']) expect(incomingKind({ kind })).toBeUndefined()
  })

  it('takes a Web UI prompt, a WeChat message, and a Bilibili message of the owner\'s account for the owner', () => {
    expect(classifyArrival({ kind: 'user', rpcId: 'web-1' }, undefined, senders)).toBe('owner')
    expect(classifyArrival({ kind: 'user', rpcId: 'wx-1' }, 'unattended', senders)).toBe('owner')
    expect(classifyArrival({ kind: 'user', rpcId: 'dm-1' }, 'bili', senders)).toBe('owner')
  })

  it('takes a channel bot\'s prompt, a guest, and a message another Session passed on for a sender', () => {
    expect(classifyArrival({ kind: 'user', rpcId: 'old-untrusted:bili:1' }, undefined, senders)).toBe('sender')
    expect(classifyArrival({ kind: 'user', rpcId: 'qq-1' }, 'qqbot', senders)).toBe('sender')
    expect(classifyArrival({ kind: 'user', rpcId: 'g-1', principal: { id: 'guest' } }, undefined, senders)).toBe('sender')
    expect(classifyArrival({ kind: 'user', rpcId: untrustedRequestId('bili') }, 'unattended', senders)).toBe('sender')
  })

  it('names events and reminders as such in any preset, and context as nothing', () => {
    expect(classifyArrival({ kind: 'webhook' }, 'unattended', senders)).toBe('event')
    expect(classifyArrival({ kind: 'schedule' }, 'qqbot', senders)).toBe('reminder')
    expect(classifyArrival({ kind: 'owner-memory' }, 'unattended', senders)).toBeUndefined()
  })
})

describe('timeGapNotice', () => {
  const afterReply = { gapMs: 3 * 3_600_000 + 5 * MIN, lastAt: now - (3 * 3_600_000 + 5 * MIN), last: 'reply' as const }

  it('tells the model when the owner wrote, how long the Session was quiet, and to re-check what may have changed', () => {
    expect(timeGapNotice('owner', now, afterReply, zone)).toBe(
      'Time check: the owner sent the message below at Sun 2026-11-01 08:30 (America/New_York), after 3 h 5 min of silence in this Session.'
      + ' Before it, the last exchange here was your own reply, at Sun 2026-11-01 05:25.'
      + ' Read the message on its own terms: it starts a new exchange unless it clearly refers back to something earlier.'
      + ' Things outside this conversation (files, processes, services, accounts, other people\'s messages) may have changed since then; check again before relying on what you saw earlier.',
    )
  })

  it('says "the sender" for someone who is not the owner', () => {
    const text = timeGapNotice('sender', now, afterReply, zone)
    expect(text.startsWith('Time check: the sender sent the message below at Sun 2026-11-01 08:30 (America/New_York), after 3 h 5 min of silence')).toBe(true)
    expect(text).not.toContain('owner')
  })

  it('words an event and a reminder as arriving after the silence, days later included', () => {
    const days = { gapMs: 2 * 86_400_000 + 3 * 3_600_000, lastAt: now - (2 * 86_400_000 + 3 * 3_600_000), last: 'reply' as const }
    expect(timeGapNotice('event', now, days, zone)).toBe(
      'Time check: this event arrived at Sun 2026-11-01 08:30 (America/New_York), after 2 d 3 h of silence in this Session.'
      // Daylight saving time ended in New York on Nov 1, so 51 hours back reads 06:30 EDT.
      + ' Before it, the last exchange here was your own reply, at Fri 2026-10-30 06:30.'
      + ' Treat it as arriving now, not as part of the last exchange: what it concerns may have changed since then, so check the current state before acting on it.',
    )
    expect(timeGapNotice('reminder', now, days, zone)).toMatch(/^Time check: this reminder arrived at Sun 2026-11-01 08:30 \(America\/New_York\), after 2 d 3 h of silence in this Session\./u)
  })

  it('says when the last input got no reply', () => {
    const text = timeGapNotice('owner', now, { gapMs: 70 * MIN, lastAt: now - 70 * MIN, last: 'incoming' }, zone)
    expect(text).toContain('after 1 h 10 min of silence in this Session. Before it, the last exchange here was an earlier input that got no reply, at Sun 2026-11-01 07:20.')
  })

  it('keeps a one-line summary for the collapsed row', () => {
    expect(timeGapSummary(afterReply)).toBe('Time check: 3 h 5 min since the last exchange')
  })
})
