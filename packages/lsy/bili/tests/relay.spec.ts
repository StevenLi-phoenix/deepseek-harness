/** The owner talking to the account on Bilibili: the message check, the turn, and the reply through bili-svc's Reply Gate. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { splitMessage } from '../src/text.ts'
import { FakeBiliSvc, replyItem } from './fake-bili-svc.ts'
import { allLogs, contexts, fakeSessions, harness } from './harness.ts'

const OWNER = 200000001
/** How the WeChat chat Session reads a fallback copy of the account's answer. */
const ORIGIN = 'the Bilibili account\'s Session (its answer could not go out as a Bilibili message)'
let dir: string
let svc: FakeBiliSvc

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bili-relay-'))
  svc = new FakeBiliSvc()
  vi.useFakeTimers()
  // Fri 2026-10-23 10:00 in New York (EDT).
  vi.setSystemTime(new Date('2026-10-23T14:00:00.000Z'))
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
  allLogs.splice(0)
})

function assistant(text: string): unknown {
  return { type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } } }
}

/** A mount whose first message check has recorded its baseline. */
async function conversing(config: Record<string, unknown> = {}) {
  const sessions = fakeSessions()
  const h = await harness({ svc, sessions, workspace: dir, config: { inboxPollMs: 600_000, ...config } })
  await vi.advanceTimersByTimeAsync(600_000)
  /** The owner's main account sends one message. */
  let key = 6_984_393_491_767_670_000n
  const ownerSays = (text: string): void => {
    key += 1n
    svc.ownerMessages.push({ sender: OWNER, text, key: String(key), at: Math.floor(Date.now() / 1000) })
    svc.unread.follow = 1
  }
  /** End one turn of the account's Session with a final answer. */
  const answer = async (text: string | undefined, reason: Record<string, unknown> = { kind: 'completed' }): Promise<void> => {
    if (text !== undefined) h.emit('bili-1', assistant(text))
    h.emit('bili-1', { type: 'turn/end', seq: 9, data: { turn: 1, reason } })
    await vi.advanceTimersByTimeAsync(1000)
  }
  return { ...h, sessions: sessions.state, ownerSays, answer }
}

describe('replies to the owner', () => {
  it('answers an owner message through bili-svc\'s Reply Gate, not WeChat', async () => {
    const h = await conversing()
    expect(h.logs.some(line => line.text === 'bili: owner-message baseline: 0 message(s) already there')).toBe(true)
    h.ownerSays('hi')
    await vi.advanceTimersByTimeAsync(600_000)
    expect(h.sessions.prompts).toHaveLength(1)
    const prompt = (h.sessions.prompts[0]!.content[0] as { text: string }).text
    expect(prompt).toContain('"text": "hi"')
    expect(prompt).toContain('<bilibili_data source="inbox" trust="untrusted">')
    expect(prompt).toContain('Your final answer is your reply to the owner\'s message: it goes back to them as a Bilibili message from your account.')
    expect(svc.callsTo('dmMessages')[0]!.query).toMatchObject({ talker_id: OWNER, session_type: 1 })
    await h.answer('hi！我在。今天看到一只会开门的猫：https://www.bilibili.com/video/BV1aa4y1X7aa')
    expect(svc.replies).toEqual([{ account: 'maomao', talker: OWNER, message: 'hi！我在。今天看到一只会开门的猫：https://www.bilibili.com/video/BV1aa4y1X7aa' }])
    expect(h.notes).toEqual([])
    expect(h.logs.some(line => line.text === 'bili: sent the turn\'s answer to the owner as 1 Bilibili message(s) through bili-svc')).toBe(true)
    // Nothing reaches Bilibili except through bili-svc's two doors.
    expect(new Set(svc.requests.map(request => request.path))).toEqual(new Set(['/v1/bili/call', '/v1/reply/dm']))
  })

  it('sends what the Reply Gate held or blocked to WeChat, with the reason, labelled as the account\'s', async () => {
    const h = await conversing()
    svc.replyStatus = ['held']
    h.ownerSays('在吗')
    await vi.advanceTimersByTimeAsync(600_000)
    await h.answer('在的')
    expect(h.notes).toEqual([{ title: '📺 B站：这条没能用 B站私信发出，改发微信', body: '在的\n\n原因：bili-svc\'s Reply Gate answered held (r-1)', origin: ORIGIN }])
    svc.replyStatus = ['blocked']
    h.ownerSays('还在吗')
    await vi.advanceTimersByTimeAsync(65_000)
    await h.answer('还在')
    expect(h.notes.at(-1)?.body).toBe('还在\n\n原因：bili-svc\'s Reply Gate answered blocked (r-2)')
    // No answer from bili-svc: the outcome is unknown, so it goes to WeChat too and is never sent again.
    svc.answer('/v1/reply/dm', new TypeError('fetch failed'))
    h.ownerSays('喂')
    await vi.advanceTimersByTimeAsync(65_000)
    await h.answer('喂？')
    expect(h.notes.at(-1)?.body).toBe('喂？\n\n原因：the outcome at bili-svc is unknown (reply/dm: bili-svc is unreachable (TypeError))')
    expect(svc.replies).toHaveLength(2)
  })

  it('checks messages every minute for 15 minutes after an owner message, extending on each', async () => {
    const h = await conversing()
    const polls = (): number => svc.callsTo('dmUnread').length
    h.ownerSays('在吗')
    await vi.advanceTimersByTimeAsync(600_000)
    expect(h.sessions.prompts).toHaveLength(1)
    expect(h.logs.some(line => line.text.startsWith('bili: the owner is messaging; checking messages every 60 s until '))).toBe(true)
    await h.answer('在的')
    svc.unread.follow = 0
    const before = polls()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(polls() - before).toBeGreaterThanOrEqual(4)
    h.ownerSays('看了那个视频吗')
    await vi.advanceTimersByTimeAsync(65_000)
    expect(h.sessions.prompts).toHaveLength(2)
    await h.answer('看了，很好笑')
    expect(svc.replies.map(reply => reply.message)).toEqual(['在的', '看了，很好笑'])
    svc.unread.follow = 0
    await vi.advanceTimersByTimeAsync(16 * 60_000)
    expect(h.logs.some(line => line.text === 'bili: the owner\'s conversation went quiet; back to the regular message check')).toBe(true)
    const quiet = polls()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(polls() - quiet).toBeLessThanOrEqual(1)
  })

  it('splits a long answer into at most two replies of 500 characters', async () => {
    expect(splitMessage('短', 500, 2)).toEqual(['短'])
    const parts = splitMessage(`${'甲'.repeat(300)}\n${'乙'.repeat(400)}\n${'丙'.repeat(600)}`, 500, 2)
    expect(parts).toHaveLength(2)
    expect(parts[0]).toBe('甲'.repeat(300))
    expect(Array.from(parts[1]!)).toHaveLength(500)
    expect(parts[1]!.endsWith('…')).toBe(true)
    const h = await conversing()
    h.ownerSays('讲讲')
    await vi.advanceTimersByTimeAsync(600_000)
    await h.answer(`${'a'.repeat(450)}\n\n${'b'.repeat(450)}`)
    expect(svc.replies.map(reply => reply.message)).toEqual(['a'.repeat(450), 'b'.repeat(450)])
  })

  it('sends nothing for NO_REPLY, for a turn the owner stopped, or for a turn the owner\'s messages did not start', async () => {
    const h = await conversing()
    h.ownerSays('嗯')
    await vi.advanceTimersByTimeAsync(600_000)
    await h.answer('NO_REPLY')
    h.ownerSays('停')
    await vi.advanceTimersByTimeAsync(65_000)
    await h.answer('half an answer', { kind: 'aborted', reason: { kind: 'user' } })
    await h.answer('a Web UI answer')
    expect(svc.replies).toEqual([])
    expect(h.notes).toEqual([])
    expect(h.logs.some(line => line.text === 'bili: Session bili-1 ended a turn the owner\'s messages did not start (completed); its answer stays in the Session')).toBe(true)
  })

  it('answers nobody but the owner: replies and mentions from strangers start no turn, and nothing is read without an owner account', async () => {
    const h = await conversing()
    svc.unread = { reply: 3, at: 2, follow: 0, unfollow: 4 }
    svc.replyItems = [replyItem(1, '600000000009', '你也喜欢猫？')]
    svc.ownerMessages.push({ sender: 777, text: '陌生人的私信', key: '1', at: Math.floor(Date.now() / 1000) })
    await vi.advanceTimersByTimeAsync(1_200_000)
    expect(h.sessions.prompts).toEqual([])
    expect(svc.callsTo('replyFeed')).toEqual([])
    expect(svc.callsTo('atFeed')).toEqual([])
    await h.ctx.fiber.dispose()
    const before = svc.calls.length
    await harness({ svc, workspace: dir, config: { ownerMid: undefined, inboxPollMs: 600_000 } })
    await vi.advanceTimersByTimeAsync(1_200_000)
    expect(svc.calls.length).toBe(before)
  })
})
