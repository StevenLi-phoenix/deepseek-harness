import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TypingStatus, type TypingStatusValue } from '../src/api.ts'
import { TYPING_KEEPALIVE_MS, TYPING_MAX_MS, TypingIndicator } from '../src/typing.ts'

/** An indicator whose ticket fetch and sends are recorded; a send may be replaced per test. */
function indicator() {
  const statuses: TypingStatusValue[] = []
  const warnings: string[] = []
  const io = {
    fetchTicket: () => Promise.resolve('ticket'),
    send: (_ticket: string, status: TypingStatusValue): Promise<void> => {
      statuses.push(status)
      return Promise.resolve()
    },
    warn: (message: string) => { warnings.push(message) },
  }
  return { typing: new TypingIndicator(io), io, statuses, warnings }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TypingIndicator', () => {
  it('says whether it is on', async () => {
    const { typing } = indicator()
    expect(typing.isActive).toBe(false)
    typing.start()
    expect(typing.isActive).toBe(true)
    await typing.stop()
    expect(typing.isActive).toBe(false)
  })

  it('cancels by itself when nobody stops it within the longest time', async () => {
    const { typing, statuses } = indicator()
    typing.start()
    await vi.advanceTimersByTimeAsync(TYPING_MAX_MS)
    expect(typing.isActive).toBe(false)
    expect(statuses.at(-1)).toBe(TypingStatus.CANCEL)
    const count = statuses.length
    await vi.advanceTimersByTimeAsync(TYPING_KEEPALIVE_MS * 2)
    expect(statuses).toHaveLength(count)
  })

  it('logs one failure per streak, whatever was thrown', async () => {
    const { typing, io, warnings } = indicator()
    io.fetchTicket = async () => { throw 'no ticket today' }
    typing.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(warnings).toEqual(['no typing ticket (no ticket today); retrying in 30s'])
    await typing.stop()
    await vi.advanceTimersByTimeAsync(30_000)
    typing.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(warnings).toHaveLength(1)
  })

  it('sends nothing more once it stopped in the moment the first send came back', async () => {
    const { typing, io, statuses } = indicator()
    let answered = (): void => {}
    const answer = new Promise<void>((resolve) => { answered = resolve })
    io.send = (_ticket, status) => {
      statuses.push(status)
      return status === TypingStatus.TYPING ? answer : Promise.resolve()
    }
    typing.start()
    await vi.advanceTimersByTimeAsync(0)
    // Queued behind the indicator's own wait on the answer, so stop runs before the keepalive is armed.
    const stopped = answer.then(() => typing.stop())
    answered()
    await stopped
    await vi.advanceTimersByTimeAsync(TYPING_KEEPALIVE_MS * 3)
    expect(statuses).toEqual([TypingStatus.TYPING, TypingStatus.CANCEL])
    expect(vi.getTimerCount()).toBe(0)
  })
})
