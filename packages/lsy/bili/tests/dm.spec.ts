/** The DM channel alone: which answers go to the owner through bili-svc, and what falls back to WeChat. */
import type { LsyNote } from '@deepseek-ai/dsh-lsy-event-bus'
import { describe, expect, it, vi } from 'vitest'
import { BILI_FALLBACK_LABEL, DmChannel, type DmOutcome } from '../src/dm.ts'

/** A host double whose replies wait until the test settles them. */
function host(options: { notifier?: false | ((note: LsyNote) => Promise<void>) } = {}) {
  const pending: Array<(outcome: DmOutcome) => void> = []
  const notes: LsyNote[] = []
  const send = options.notifier === undefined ? (note: LsyNote) => { notes.push(note); return Promise.resolve() } : options.notifier
  const value = {
    replyOwner: vi.fn((_text: string) => new Promise<DmOutcome>((resolve) => { pending.push(resolve) })),
    hold: <T>(work: Promise<T>): Promise<T> => work,
    notifier: () => (send === false ? undefined : { send }),
    logger: { info: vi.fn((_message: string) => {}), warn: vi.fn((_message: string) => {}) },
  }
  /** Answer every waiting reply with `outcome`. */
  const settle = async (outcome: DmOutcome): Promise<void> => {
    for (const resolve of pending.splice(0)) resolve(outcome)
    await new Promise(resolve => setImmediate(resolve))
  }
  return { host: value, notes, settle }
}

const SENT: DmOutcome = { status: 'sent', detail: 'sent' }

describe('DmChannel', () => {
  it('sends the answer of a turn the owner\'s messages started as replies, even when the next prompt comes before the last answer went out', async () => {
    const h = host()
    const dm = new DmChannel(h.host)
    dm.expectReply('bili-1')
    dm.onTurnEnd('bili-1', 'answer')
    const first = dm.deliver({ sessionId: 'bili-1', text: '在的', outcome: 'completed' })
    // The owner writes again before bili-svc answered the first reply.
    dm.expectReply('bili-1')
    dm.onTurnEnd('bili-1', 'answer')
    const second = dm.deliver({ sessionId: 'bili-1', text: '刚睡醒', outcome: 'completed' })
    await new Promise(resolve => setImmediate(resolve))
    await h.settle(SENT)
    expect(await first).toBe('sent')
    expect(await second).toBe('sent')
    expect(h.host.replyOwner.mock.calls.map(([text]) => text)).toEqual(['在的', '刚睡醒'])
    expect(h.notes).toEqual([])
  })

  it('keeps the answer of a turn the owner\'s messages did not start, including the turn after a reply turn that sent nothing', async () => {
    const h = host()
    const dm = new DmChannel(h.host)
    expect(await dm.deliver({ sessionId: 'bili-1', text: 'a Web UI answer', outcome: 'completed' })).toBe('kept')
    dm.expectReply('bili-1')
    dm.onTurnEnd('bili-1', 'silent')
    dm.onTurnEnd('bili-1', 'answer')
    expect(await dm.deliver({ sessionId: 'bili-1', text: 'the next Web UI answer', outcome: 'completed' })).toBe('kept')
    expect(h.host.replyOwner).not.toHaveBeenCalled()
  })

  it('forgets the mark of a prompt that failed', async () => {
    const h = host()
    const dm = new DmChannel(h.host)
    dm.expectReply('bili-1')
    dm.dropReply('bili-1')
    dm.onTurnEnd('bili-1', 'answer')
    expect(await dm.deliver({ sessionId: 'bili-1', text: 'x', outcome: 'completed' })).toBe('kept')
  })

  it('sends what the Reply Gate held or blocked to WeChat with the reason, labelled as the account\'s', async () => {
    for (const status of ['held', 'blocked', 'failed'] as const) {
      const h = host()
      const dm = new DmChannel(h.host)
      dm.expectReply('bili-1')
      dm.onTurnEnd('bili-1', 'answer')
      const answer = dm.deliver({ sessionId: 'bili-1', text: '在 https://www.bilibili.com/video/BV1aa4y1X7aa', outcome: 'completed' })
      await new Promise(resolve => setImmediate(resolve))
      await h.settle({ status, detail: `bili-svc's Reply Gate answered ${status} (r-1)` })
      expect(await answer).toBe('sent')
      expect(h.notes).toEqual([{
        title: '📺 B站：这条没能用 B站私信发出，改发微信',
        body: `在 https://www.bilibili.com/video/BV1aa4y1X7aa\n\n原因：bili-svc's Reply Gate answered ${status} (r-1)`,
        origin: BILI_FALLBACK_LABEL,
      }])
    }
  })

  it('splits a long answer into two replies, and sends the rest to WeChat once one is held', async () => {
    const h = host()
    const dm = new DmChannel(h.host)
    dm.expectReply('bili-1')
    dm.onTurnEnd('bili-1', 'answer')
    const answer = dm.deliver({ sessionId: 'bili-1', text: `${'a'.repeat(450)}\n\n${'b'.repeat(450)}`, outcome: 'completed' })
    await new Promise(resolve => setImmediate(resolve))
    await h.settle(SENT)
    await h.settle({ status: 'held', detail: 'bili-svc\'s Reply Gate answered held' })
    expect(await answer).toBe('sent')
    expect(h.host.replyOwner.mock.calls.map(([text]) => text)).toEqual(['a'.repeat(450), 'b'.repeat(450)])
    expect(h.notes.map(note => note.body)).toEqual([`${'b'.repeat(450)}\n\n原因：bili-svc's Reply Gate answered held`])
  })

  it('rejects when WeChat cannot take the answer either, so the relay knows it was not delivered', async () => {
    const missing = host({ notifier: false })
    const dm = new DmChannel(missing.host)
    dm.expectReply('bili-1')
    dm.onTurnEnd('bili-1', 'answer')
    const answer = expect(dm.deliver({ sessionId: 'bili-1', text: 'a reply', outcome: 'completed' })).rejects.toThrow('no lsyNotifier is mounted')
    await new Promise(resolve => setImmediate(resolve))
    await missing.settle({ status: 'blocked', detail: 'bili-svc\'s Reply Gate answered blocked' })
    await answer
  })
})
