import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { splitMessage } from '../src/text.ts'
import { FakeBili } from './fake-bili.ts'
import { allLogs, contexts, fakeSessions, harness } from './harness.ts'

const OWNER = 200000001
/** How the WeChat chat Session reads a fallback copy of the account's answer. */
const ORIGIN = 'the Bilibili account\'s Session (its answer could not go out as a Bilibili message)'
let dir: string
let fake: FakeBili

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bili-relay-'))
  fake = new FakeBili()
  fake.relations.set(OWNER, 6)
  vi.useFakeTimers()
  // Fri 2026-10-23 10:00 in New York (EDT).
  vi.setSystemTime(new Date('2026-10-23T14:00:00.000Z'))
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
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

/** A signed-in mount whose first inbox poll has recorded its baseline. */
async function conversing(config: Record<string, unknown> = {}) {
  const sessions = fakeSessions()
  const h = await harness({ bili: fake, sessions, workspace: dir, config: { inboxPollMs: 600_000, ...config } })
  await h.signIn()
  await vi.advanceTimersByTimeAsync(600_000)
  /** The owner's main account sends one message. */
  let key = 6_984_393_491_767_670_000n
  const ownerSays = (text: string): void => {
    key += 1n
    fake.ownerMessages.push({ sender: OWNER, text, key: String(key), at: Math.floor(Date.now() / 1000) })
    fake.unread.follow = 1
  }
  /** End one turn of the account's Session with a final answer. */
  const answer = async (text: string | undefined, kind = 'completed'): Promise<void> => {
    if (text !== undefined) h.emit('bili-1', assistant(text))
    h.emit('bili-1', { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind } } })
    // The reply gap is 3-10 s; requests are spaced 1.2-2 s.
    await vi.advanceTimersByTimeAsync(30_000)
  }
  return { ...h, sessions: sessions.state, ownerSays, answer }
}

describe('replies to the owner', () => {
  it('answers an owner message with a Bilibili message, not WeChat, counted as dmReply', async () => {
    const h = await conversing()
    h.ownerSays('hi')
    await vi.advanceTimersByTimeAsync(600_000)
    expect(h.sessions.prompts).toHaveLength(1)
    const prompt = (h.sessions.prompts[0]!.content[0] as { text: string }).text
    expect(prompt).toContain('"text": "hi"')
    expect(prompt).toContain('Your final answer is your reply to the owner\'s message: it goes back to them as a Bilibili message from your account.')
    await h.answer('hi！我在。今天看到一只会开门的猫：https://www.bilibili.com/video/BV1aa4y1X7aa')
    expect(fake.sentMessages).toEqual([{ receiver: OWNER, text: 'hi！我在。今天看到一只会开门的猫：https://www.bilibili.com/video/BV1aa4y1X7aa' }])
    expect(h.notes).toEqual([])
    const usage = (await h.view()).usage.actions
    expect(usage.some(row => (row.action as string) === 'dmReply')).toBe(false)
    expect((await h.view()).recent.filter(row => row.action === 'dmReply')).toHaveLength(1)
    expect(usage.find(row => row.action === 'dmOwner')).toEqual({ action: 'dmOwner', used: 0, cap: 5 })
    expect(h.logs.some(line => line.text === 'bili: sent the turn\'s answer to the owner as 1 Bilibili message(s) (dmReply)')).toBe(true)
  })

  it('checks messages every minute for 15 minutes after an owner message, extending on each, and lets owner wakes past the hourly cap', async () => {
    const h = await conversing({ inboxWakesPerHour: 1 })
    const polls = (): number => fake.requestsTo('/x/msgfeed/unread').length
    h.ownerSays('在吗')
    await vi.advanceTimersByTimeAsync(600_000)
    expect(h.sessions.prompts).toHaveLength(1)
    expect(h.logs.some(line => line.text.startsWith('bili: the owner is messaging; checking messages every 60 s until '))).toBe(true)
    await h.answer('在的')
    const before = polls()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(polls() - before).toBeGreaterThanOrEqual(4)
    // A second owner message within the hour wakes it again, and within a minute.
    h.ownerSays('看了那个视频吗')
    await vi.advanceTimersByTimeAsync(65_000)
    expect(h.sessions.prompts).toHaveLength(2)
    await h.answer('看了，很好笑')
    expect(fake.sentMessages.map(message => message.text)).toEqual(['在的', '看了，很好笑'])
    // Fifteen quiet minutes later it falls back to the 10-minute check.
    await vi.advanceTimersByTimeAsync(16 * 60_000)
    expect(h.logs.some(line => line.text === 'bili: the owner\'s conversation went quiet; back to the 10-minute inbox check')).toBe(true)
    const quiet = polls()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(polls() - quiet).toBeLessThanOrEqual(1)
  })

  it('splits a long answer into at most two messages of 500 characters', async () => {
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
    expect(fake.sentMessages.map(message => message.text)).toEqual(['a'.repeat(450), 'b'.repeat(450)])
    expect((await h.view()).recent.filter(row => row.action === 'dmReply')).toHaveLength(2)
  })
})

describe('shares', () => {
  it('sends a body-clock share as a Bilibili message counted as dmOwner, and nothing for NO_REPLY', async () => {
    const sessions = fakeSessions()
    const h = await harness({ bili: fake, sessions, workspace: dir })
    await h.signIn()
    await vi.advanceTimersByTimeAsync(Date.parse('2026-10-23T17:00:05Z') - Date.now())
    expect((sessions.state.prompts[0]!.content[0] as { text: string }).text)
      .toContain('Your final answer reaches the owner as a Bilibili message from your account (plain text; link videos as https://www.bilibili.com/video/<bvid>); answer exactly NO_REPLY when nothing is worth sending.')
    h.emit('bili-1', assistant('今天看到一只会开门的猫：https://www.bilibili.com/video/BV1aa4y1X7aa'))
    h.emit('bili-1', { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(fake.sentMessages).toEqual([{ receiver: OWNER, text: '今天看到一只会开门的猫：https://www.bilibili.com/video/BV1aa4y1X7aa' }])
    expect((await h.view()).usage.actions.find(row => row.action === 'dmOwner')?.used).toBe(1)
    expect(h.notes).toEqual([])

    await h.post({ action: 'wake' })
    h.emit('bili-1', assistant('NO_REPLY'))
    h.emit('bili-1', { type: 'turn/end', seq: 12, data: { turn: 2, reason: { kind: 'completed' } } })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(fake.sentMessages).toHaveLength(1)
    expect(h.notes).toEqual([])
  })

  it('falls back to WeChat with the reason when a message cannot go out', async () => {
    fake.relations.set(OWNER, 2)
    const sessions = fakeSessions()
    const h = await harness({ bili: fake, sessions, workspace: dir })
    await h.signIn()
    await h.post({ action: 'wake' })
    h.emit('bili-1', assistant('分享一个视频'))
    h.emit('bili-1', { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(fake.sentMessages).toEqual([])
    expect(h.notes).toEqual([{
      title: '📺 B站：这条没能用 B站私信发出，改发微信',
      body: '分享一个视频\n\n原因：the owner\'s account does not follow this account back; Bilibili delivers messages only between mutual followers, so ask the owner to follow it',
      origin: ORIGIN,
    }])

    // A failed send, and a turn that failed, both land on WeChat with why.
    fake.relations.set(OWNER, 6)
    fake.reply('/web_im/v1/web_im/send_msg', new TypeError('fetch failed'))
    await vi.advanceTimersByTimeAsync(61_000)
    await h.post({ action: 'wake' })
    h.emit('bili-1', { type: 'turn/end', seq: 12, data: { turn: 2, reason: { kind: 'error', error: { code: 'AUTH', message: '401 User not found.' } } } })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(h.notes[1]).toEqual({
      title: '📺 B站：这条没能用 B站私信发出，改发微信',
      body: '⚠️ 本轮未完成（error）\n原因：AUTH: 401 User not found.\n\n原因：the outcome is unknown (dmSend: network error (TypeError)); it counts against today\'s budget and will not be sent again',
      origin: ORIGIN,
    })
  })

  it('relays nothing for a turn no wake started', async () => {
    const sessions = fakeSessions()
    const h = await harness({ bili: fake, sessions, workspace: dir })
    await h.signIn()
    await h.post({ action: 'wake' })
    h.emit('bili-1', assistant('first'))
    h.emit('bili-1', { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })
    // The owner chats with the Session in the Web UI; that answer stays there.
    h.emit('bili-1', assistant('second'))
    h.emit('bili-1', { type: 'turn/end', seq: 12, data: { turn: 2, reason: { kind: 'completed' } } })
    h.emit('other', assistant('not ours'))
    h.emit('other', { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(fake.sentMessages.map(message => message.text)).toEqual(['first'])
    expect(h.notes).toEqual([])
    expect(h.logs.some(line => line.text === 'bili: Session bili-1 ended a turn no wake started (completed); its answer stays in the Session')).toBe(true)
    expect(h.logs.filter(line => line.text.includes('first') || line.text.includes('second'))).toEqual([])
  })
})

describe('phone verification', () => {
  const NEEDS_PHONE = '为了维护社区的良好秩序，只有绑定手机号的账号才能发送消息'

  it('sends a reply Bilibili refuses for want of a verified phone to WeChat, quoting Bilibili, without pausing, until a message goes through', async () => {
    const h = await conversing()
    fake.reply('/web_im/v1/web_im/send_msg', { body: { code: 21015, message: NEEDS_PHONE } })
    h.ownerSays('在吗')
    await vi.advanceTimersByTimeAsync(600_000)
    await h.answer('在')
    expect(fake.sentMessages).toEqual([])
    expect(h.notes).toEqual([{ title: '📺 B站：这条没能用 B站私信发出，改发微信', body: `在\n\nB站私信没发出：${NEEDS_PHONE}`, origin: ORIGIN }])
    const view = await h.view()
    // A refusal, not risk control: no pause, and the ledger says why in Bilibili's words.
    expect(view.pause).toBeNull()
    expect(view.recent[0]).toMatchObject({ action: 'dmReply', state: 'failed', detail: `Bilibili refused it until the account verifies a phone number: code 21015 (${NEEDS_PHONE})` })
    expect(view.verification).toEqual([{ kind: 'message', message: NEEDS_PHONE, since: expect.any(Number) as number }])
    // Not uncertain either: once the owner verifies, the same words can go out, and the hint clears.
    h.ownerSays('好了')
    await vi.advanceTimersByTimeAsync(65_000)
    await h.answer('在')
    expect(fake.sentMessages).toEqual([{ receiver: OWNER, text: '在' }])
    expect((await h.view()).verification).toEqual([])
    expect(h.logs.some(line => line.text === 'bili: a message went through; the phone-verification hint is cleared')).toBe(true)
  })

  it('reads the same demand from Bilibili\'s words under another code, for public speech too', async () => {
    const h = await conversing()
    fake.reply('/x/v2/reply/add', { body: { code: 12099, message: '发表评论前请先绑定手机号' } })
    expect(await h.run(h.account.comment('BV1aa4y1X7aa', '好看'))).toEqual({
      outcome: 'refused',
      detail: 'Bilibili refused it until the account verifies a phone number: code 12099 (发表评论前请先绑定手机号)',
      verification: '发表评论前请先绑定手机号',
    })
    const view = await h.view()
    expect(view.pause).toBeNull()
    expect(view.verification).toEqual([{ kind: 'speech', message: '发表评论前请先绑定手机号', since: expect.any(Number) as number }])
    // A captcha is still risk control.
    fake.reply('/x/v2/reply/add', { body: { code: 12099, message: '请输入验证码' } })
    await vi.advanceTimersByTimeAsync(200_000)
    expect(await h.run(h.account.comment('BV1bb4y1X7bb', '风景真好'))).toMatchObject({ outcome: 'refused' })
    expect((await h.view()).pause).toMatchObject({ scope: 'all' })
  })
})
