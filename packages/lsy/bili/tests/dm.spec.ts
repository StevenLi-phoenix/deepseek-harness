/** The DM channel alone: which answer goes out by which message, and what falls back to WeChat. */
import type { LsyNote } from '@deepseek-ai/dsh-lsy-event-bus'
import { describe, expect, it, vi } from 'vitest'
import { BILI_FALLBACK_LABEL, DmChannel, type DmOutcome, type WakeOrigin } from '../src/dm.ts'

/** A host double whose messages wait until the test settles them. */
function host(options: { notifier?: false | ((note: LsyNote) => Promise<void>); hold?: boolean } = {}) {
  const pending: Array<(outcome: DmOutcome) => void> = []
  const notes: LsyNote[] = []
  const send = options.notifier === undefined ? (note: LsyNote) => { notes.push(note); return Promise.resolve() } : options.notifier
  const value = {
    messageOwner: vi.fn((_action: 'dmOwner' | 'dmReply', _text: string, _maxWaitMs: number) => new Promise<DmOutcome>((resolve) => { pending.push(resolve) })),
    reportShares: vi.fn((_text: string) => {}),
    hold: <T>(work: Promise<T>): Promise<T> => work,
    continueWake: vi.fn((_sessionId: string, _origin: WakeOrigin, _draft: string | undefined) => options.hold === true),
    endWake: vi.fn((_sessionId: string) => {}),
    notifier: () => (send === false ? undefined : { send }),
    logger: { info: vi.fn((_message: string) => {}), warn: vi.fn((_message: string) => {}) },
  }
  /** Answer every waiting message with `outcome`. */
  const settle = async (outcome: DmOutcome): Promise<void> => {
    for (const resolve of pending.splice(0)) resolve(outcome)
    await new Promise(resolve => setImmediate(resolve))
  }
  return { host: value, notes, settle }
}

const SENT: DmOutcome = { outcome: 'sent', detail: 'dmOwner sent' }

describe('DmChannel', () => {
  it('answers each turn by the channel of the wake that started it, even when the next wake comes before the last answer went out', async () => {
    const h = host()
    const dm = new DmChannel(h.host)
    dm.setOrigin('bili-1', { reason: 'clock', owner: false })
    dm.onTurnEnd('bili-1', 'answer')
    const share = dm.deliver({ sessionId: 'bili-1', text: 'a share', outcome: 'completed' })
    // The owner writes while the share waits for its write slot: an inbox wake starts the next turn.
    dm.setOrigin('bili-1', { reason: 'inbox', owner: true })
    dm.onTurnEnd('bili-1', 'answer')
    const reply = dm.deliver({ sessionId: 'bili-1', text: 'a reply', outcome: 'completed' })
    await new Promise(resolve => setImmediate(resolve))
    expect(h.host.messageOwner.mock.calls.map(([action, text]) => [action, text])).toEqual([['dmOwner', 'a share'], ['dmReply', 'a reply']])
    await h.settle(SENT)
    expect(await share).toBe('sent')
    expect(await reply).toBe('sent')
    expect(h.notes).toEqual([])
  })

  it('keeps the answer of a turn no wake started, including the turn after a wake turn that sent nothing', async () => {
    const h = host()
    const dm = new DmChannel(h.host)
    // A wake turn that answered NO_REPLY: the relay ends it without a delivery.
    dm.setOrigin('bili-1', { reason: 'clock', owner: false })
    dm.onTurnEnd('bili-1', 'silent')
    // The owner then chats with the Session in the Web UI.
    dm.onTurnEnd('bili-1', 'answer')
    expect(await dm.deliver({ sessionId: 'bili-1', text: 'a Web UI answer', outcome: 'completed' })).toBe('kept')
    expect(h.host.messageOwner).not.toHaveBeenCalled()
    expect(h.host.logger.info).toHaveBeenCalledWith('bili: Session bili-1 ended a turn no wake started (completed); its answer stays in the Session')
    // The silent wake turn asked the host whether the wake keeps browsing; the Web UI turn did not.
    expect(h.host.continueWake.mock.calls).toEqual([['bili-1', { reason: 'clock', owner: false }, undefined]])
  })

  it('holds back a wake turn\'s answer while the host asks for more browsing, and ends the wake of a stopped or failed turn', async () => {
    const held = host({ hold: true })
    const dm = new DmChannel(held.host)
    dm.setOrigin('bili-1', { reason: 'clock', owner: false })
    dm.onTurnEnd('bili-1', 'answer')
    expect(await dm.deliver({ sessionId: 'bili-1', text: '看这个', outcome: 'completed' })).toBe('kept')
    expect(held.host.messageOwner).not.toHaveBeenCalled()
    expect(held.host.continueWake).toHaveBeenCalledWith('bili-1', { reason: 'clock', owner: false }, '看这个')
    expect(held.host.logger.info).toHaveBeenCalledWith('bili: held the clock turn\'s answer of Session bili-1 (3 chars) until the wake has watched more')

    // The owner stopped it: the wake ends, and nothing is asked.
    const h = host()
    const other = new DmChannel(h.host)
    other.setOrigin('bili-1', { reason: 'manual', owner: false })
    other.onTurnEnd('bili-1', 'stopped')
    expect(h.host.endWake).toHaveBeenCalledWith('bili-1')
    // A failed turn's warning goes out as before, and ends the wake.
    other.setOrigin('bili-1', { reason: 'manual', owner: false })
    other.onTurnEnd('bili-1', 'answer')
    const failed = other.deliver({ sessionId: 'bili-1', text: '⚠️ 本轮未完成（error）', outcome: 'error' })
    await new Promise(resolve => setImmediate(resolve))
    await h.settle(SENT)
    expect(await failed).toBe('sent')
    expect(h.host.endWake).toHaveBeenCalledTimes(2)
    expect(h.host.continueWake).not.toHaveBeenCalled()
  })

  it('forgets the origin of a wake whose prompt failed', async () => {
    const h = host()
    const dm = new DmChannel(h.host)
    dm.setOrigin('bili-1', { reason: 'manual', owner: false })
    dm.dropOrigin('bili-1')
    dm.onTurnEnd('bili-1', 'answer')
    expect(await dm.deliver({ sessionId: 'bili-1', text: 'x', outcome: 'completed' })).toBe('kept')
  })

  it('sends what could not go out to WeChat with the reason and its origin, and reports the shared links', async () => {
    const h = host()
    const dm = new DmChannel(h.host)
    dm.setOrigin('bili-1', { reason: 'inbox', owner: true })
    dm.onTurnEnd('bili-1', 'answer')
    const answer = dm.deliver({ sessionId: 'bili-1', text: '在 https://www.bilibili.com/video/BV1aa4y1X7aa', outcome: 'completed' })
    await new Promise(resolve => setImmediate(resolve))
    await h.settle({ outcome: 'refused', detail: 'Bilibili refused it', verification: '只有绑定手机号的账号才能发送消息' })
    expect(await answer).toBe('sent')
    expect(h.notes).toEqual([{
      title: '📺 B站：这条没能用 B站私信发出，改发微信',
      body: '在 https://www.bilibili.com/video/BV1aa4y1X7aa\n\nB站私信没发出：只有绑定手机号的账号才能发送消息',
      origin: BILI_FALLBACK_LABEL,
    }])
    expect(h.host.reportShares).toHaveBeenCalledWith('在 https://www.bilibili.com/video/BV1aa4y1X7aa')
  })

  it('rejects when WeChat cannot take the answer either, so the relay knows it was not delivered', async () => {
    const missing = host({ notifier: false })
    const dm = new DmChannel(missing.host)
    dm.setOrigin('bili-1', { reason: 'clock', owner: false })
    dm.onTurnEnd('bili-1', 'answer')
    const answer = expect(dm.deliver({ sessionId: 'bili-1', text: 'a share', outcome: 'completed' })).rejects.toThrow('no lsyNotifier is mounted')
    await new Promise(resolve => setImmediate(resolve))
    await missing.settle({ outcome: 'refused', detail: 'writes are paused' })
    await answer
    expect(missing.host.reportShares).not.toHaveBeenCalled()
  })
})
