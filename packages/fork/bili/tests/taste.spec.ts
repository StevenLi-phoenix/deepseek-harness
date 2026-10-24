/** What the account learns of the owner's taste: its notes, the owner's, and how the owner took each find; every wake carries them. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeBili } from './fake-bili.ts'
import { allLogs, contexts, fakeSessions, harness } from './harness.ts'

const OWNER = 200000001
let dir: string
let fake: FakeBili

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bili-taste-'))
  fake = new FakeBili()
  fake.relations.set(OWNER, 6)
  vi.useFakeTimers()
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

async function signedIn() {
  const sessions = fakeSessions()
  const h = await harness({ bili: fake, sessions, workspace: dir, config: { inboxPollMs: 600_000 } })
  await h.signIn()
  // The first inbox check records the baseline.
  await vi.advanceTimersByTimeAsync(600_000)
  const answer = async (text: string): Promise<void> => {
    h.emit('bili-1', assistant(text))
    h.emit('bili-1', { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.advanceTimersByTimeAsync(300_000)
  }
  const last = (): string => (sessions.state.prompts.at(-1)!.content[0] as { text: string }).text
  return { ...h, sessions: sessions.state, answer, last }
}

describe('taste notes', () => {
  it('keeps the Session\'s and the owner\'s notes, lists them in every wake, and lets only the owner change the owner\'s', async () => {
    const h = await signedIn()
    expect(await h.account.tasteWrite('  她不爱看大众热门里的社会纪实  ')).toEqual({ saved: true, seq: 1, notes: 1 })
    expect((await h.post({ action: 'taste-add', text: '想看 AI agent 圈正在发酵的事，比如 B站大肥鱼鱼灾复盘' })).status).toBe(200)
    expect(await h.account.tasteWrite('她不爱看热门里的大众内容', 1)).toEqual({ saved: true, seq: 1, notes: 2 })
    expect(await h.account.tasteWrite('改掉主人的', 2)).toEqual({ refused: 'note 2 is the owner\'s own; add a new note instead' })
    expect(await h.account.tasteWrite('x'.repeat(201))).toEqual({ refused: 'the note is 201 characters; the limit is 200' })
    expect(await h.account.tasteWrite(' ')).toEqual({ refused: 'the note is empty' })
    expect((await h.view()).taste).toEqual([
      { seq: 1, at: expect.any(Number) as number, text: '她不爱看热门里的大众内容', from: 'cat' },
      { seq: 2, at: expect.any(Number) as number, text: '想看 AI agent 圈正在发酵的事，比如 B站大肥鱼鱼灾复盘', from: 'owner' },
    ])

    await h.post({ action: 'wake' })
    expect(h.last()).toContain([
      'What you know of the owner\'s taste (bili_taste_write adds a note, or replaces one by its number):',
      '[1] (you wrote) 她不爱看热门里的大众内容',
      '[2] (the owner wrote) 想看 AI agent 圈正在发酵的事，比如 B站大肥鱼鱼灾复盘',
    ].join('\n'))

    // The owner deletes a note in Settings.
    await h.post({ action: 'taste-delete', seq: 1 })
    expect((await h.view()).taste.map(note => note.seq)).toEqual([2])
    expect((await h.post({ action: 'taste-add', text: 'y'.repeat(201) })).status).toBe(400)
    expect(h.logs.some(line => line.text === 'bili: the owner deleted taste note 1')).toBe(true)
  })

  it('makes room by dropping the Session\'s oldest note, never the owner\'s', async () => {
    const h = await signedIn()
    await h.post({ action: 'taste-add', text: '主人的第一条' })
    for (let index = 0; index < 19; index += 1) await h.account.tasteWrite(`猫的第${index}条`)
    expect((await h.view()).taste).toHaveLength(20)
    expect(await h.account.tasteWrite('猫的新一条')).toMatchObject({ saved: true, seq: 21, notes: 20 })
    const texts = (await h.view()).taste.map(note => note.text)
    expect(texts[0]).toBe('主人的第一条')
    expect(texts).not.toContain('猫的第0条')
    expect(texts.at(-1)).toBe('猫的新一条')
  })
})

describe('finds', () => {
  it('keeps each video sent to the owner with its title, and the owner\'s first message after it as how they took it', async () => {
    const h = await signedIn()
    await h.post({ action: 'wake' })
    await h.run(h.account.video('BV1aa4y1X7aa'))
    await h.answer('魔女大人，这只猫会开门 https://www.bilibili.com/video/BV1aa4y1X7aa')
    expect(fake.sentMessages).toHaveLength(1)
    expect((await h.view()).finds).toEqual([{ bvid: 'BV1aa4y1X7aa', at: expect.any(Number) as number, title: '一只猫学会了开门' }])

    // The owner answers the find: that wake shows the find it may be about, and asks for a note.
    fake.ownerMessages.push({ sender: OWNER, text: '这种根本不值得看', key: '6984393491767670101', at: Math.floor(Date.now() / 1000) + 5 })
    fake.unread.follow = 1
    await vi.advanceTimersByTimeAsync(600_000)
    const inbox = h.last()
    expect(inbox).toContain('"text": "这种根本不值得看"')
    expect(inbox).toMatch(/Your latest find for the owner, sent Fri 2026-10-23 \d\d:\d\d: https:\/\/www\.bilibili\.com\/video\//)
    expect(inbox).toContain('/video/BV1aa4y1X7aa\nWhen their message tells you')
    expect(inbox).toContain('save it with bili_taste_write, in their words where you can.')
    expect((await h.view()).finds[0]!.reaction).toEqual({ text: '这种根本不值得看', at: expect.any(Number) as number })
    await h.answer('知道了')
    // Only the first message after a find is kept.
    fake.ownerMessages.push({ sender: OWNER, text: '你在干嘛', key: '6984393491767670102', at: Math.floor(Date.now() / 1000) })
    fake.unread.follow = 1
    await vi.advanceTimersByTimeAsync(65_000)
    expect((await h.view()).finds[0]!.reaction!.text).toBe('这种根本不值得看')

    // The next wake lists it, as data, so the Session never sends it again.
    await h.answer('嗯')
    await vi.advanceTimersByTimeAsync(61_000)
    await h.post({ action: 'wake' })
    const wake = h.last()
    expect(wake).toContain('Videos you already sent the owner, newest first, with the owner\'s first message after each; never send one again:')
    expect(wake).toContain('<bilibili_data source="your finds" trust="untrusted">')
    expect(wake).toContain('"title": "一只猫学会了开门"')
    expect(wake).toContain('"ownerReply": "这种根本不值得看"')
  })
})

describe('trends and sources', () => {
  it('notes memes, rewrites a term in place, lists fresh ones in a wake with the keywords and picks, and lets the owner delete one', async () => {
    const h = await harness({ bili: fake, sessions: fakeSessions(), workspace: dir, config: { picksPerDay: 5, keywords: ['DeepSeek Harness', 'Claude Code'] } })
    await h.signIn()
    expect(await h.account.trendWrite('鱼灾', '10 月 B站上 DeepSeek agent（大肥鱼）刷屏的那一周')).toEqual({ saved: true, seq: 1 })
    expect(await h.account.trendWrite('鱼灾', 'B站大肥鱼一周爆发，UP 主出了全复盘和安全养鱼指南')).toEqual({ saved: true, seq: 1 })
    expect(await h.account.trendWrite('', 'x')).toEqual({ refused: 'the term and its note must both be filled' })
    // Thirty-one days on, an old entry stays in Settings but leaves the wake.
    await h.account.trendWrite('旧梗', '很久以前的事')
    vi.setSystemTime(Date.now() + 31 * 86_400_000)
    await h.account.trendWrite('大肥鱼', 'DeepSeek 驱动的 agent 账号')
    await h.post({ action: 'keywords', text: ' DeepSeek Harness \n\nClaude Code\n大肥鱼 ' })
    expect((await h.view()).keywords.text).toBe('DeepSeek Harness\nClaude Code\n大肥鱼')
    await h.post({ action: 'wake' })
    const prompt = (h.sessions.prompts.at(-1)!.content[0] as { text: string }).text
    expect(prompt).toContain('Memes and events you keep up with, newest first (bili_trend_write adds one, or rewrites one by its number):')
    expect(prompt).toMatch(/\[3\] 大肥鱼 \(noted [^)]+\): DeepSeek 驱动的 agent 账号/)
    expect(prompt).not.toContain('旧梗')
    expect(prompt).not.toContain('鱼灾')
    expect(prompt).toContain('The owner\'s search keywords: DeepSeek Harness / Claude Code / 大肥鱼. Search each with bili_search order newest before the feeds')
    expect(prompt).toContain('Picks sent today: 0 of 5. Send this wake\'s must videos in one message, at most 4: each its title, its link, and one line of why.')
    expect((await h.view()).trends.map(trend => trend.term)).toEqual(['大肥鱼', '旧梗', '鱼灾'])
    await h.post({ action: 'trend-delete', seq: 2 })
    expect((await h.view()).trends.map(trend => trend.term)).toEqual(['大肥鱼', '鱼灾'])
  })

  it('reads hot searches, the leaderboard, and danmaku', async () => {
    const h = await signedIn()
    expect(await h.run(h.account.hotSearches())).toEqual([{ keyword: '鱼灾', label: 'B站鱼灾' }, { keyword: '大肥鱼' }])
    expect(fake.requestsTo('/x/web-interface/wbi/search/square').at(-1)!.query).toMatchObject({ limit: '30', platform: 'web' })
    const top = await h.run(h.account.ranking())
    expect(top.map(card => card.bvid)).toEqual(['BV1aa4y1X7aa', 'BV1bb4y1X7bb'])
    expect(await h.run(h.account.danmaku('BV1aa4y1X7aa'))).toEqual({ bvid: 'BV1aa4y1X7aa', lines: [
      { at: 0, text: '前方高能' }, { at: 30, text: '鱼灾 & 大肥鱼' }, { at: 60, text: '哈哈哈哈' },
    ] })
    expect(fake.requestsTo('/x/v1/dm/list.so').at(-1)!.query).toMatchObject({ oid: '9001' })
  })
})

describe('feeds', () => {
  it('leaves the owner\'s own uploads out of the feeds and search, and searches newest first when asked', async () => {
    const h = await signedIn()
    expect((await h.run(h.account.homeFeed())).map(card => card.bvid)).not.toContain('BV1oo4y1X7oo')
    expect((await h.run(h.account.popular())).map(card => card.bvid)).not.toContain('BV1oo4y1X7oo')
    expect((await h.run(h.account.search('主人'))).map(card => card.bvid)).toEqual([])
    await h.run(h.account.search('猫', 1, 'newest'))
    expect(fake.requestsTo('/x/web-interface/wbi/search/type').at(-1)!.query).toMatchObject({ keyword: '猫', order: 'pubdate' })
  })
})
