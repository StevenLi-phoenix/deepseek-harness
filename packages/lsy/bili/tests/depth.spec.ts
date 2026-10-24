/** The watch floor of a wake: an answer sent before the wake watched enough is held while the host asks for more browsing. */
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
  dir = mkdtempSync(join(tmpdir(), 'bili-depth-'))
  fake = new FakeBili()
  fake.relations.set(OWNER, 6)
  // Two more videos with subtitles, so a wake can watch three.
  fake.addVideo({ aid: 105, bvid: 'BV1cc4y1X7cc', cid: 9005, title: '鱼灾复盘', desc: '', owner: { mid: 779, name: '复盘君' }, subtitle: { lan: 'ai-zh', lines: ['这一周'] } })
  fake.addVideo({ aid: 106, bvid: 'BV1dd4y1X7dd', cid: 9006, title: '安全养鱼指南', desc: '', owner: { mid: 780, name: '养鱼人' }, subtitle: { lan: 'ai-zh', lines: ['第一步'] } })
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

/** A signed-in mount with a watch floor of three videos and two continuations. */
async function deep(config: Record<string, unknown> = {}) {
  const sessions = fakeSessions()
  const h = await harness({ bili: fake, sessions, workspace: dir, config: { depth: { minWatched: 3, maxRounds: 2 }, ...config } })
  await h.signIn()
  /** End the running turn with `text` (or nothing), and let the continuation's prompt go in. */
  const answer = async (text: string | undefined, reason: Record<string, unknown> = { kind: 'completed' }): Promise<void> => {
    if (text !== undefined) h.emit('bili-1', assistant(text))
    h.emit('bili-1', { type: 'turn/end', seq: 9, data: { turn: 1, reason } })
    await vi.advanceTimersByTimeAsync(30_000)
  }
  const prompt = (index: number): string => (sessions.state.prompts[index]!.content[0] as { text: string }).text
  return { ...h, sessions: sessions.state, answer, prompt }
}

describe('watch floor', () => {
  it('holds an early find, asks for more browsing in the same wake, and sends the answer once the wake watched enough', async () => {
    const h = await deep()
    await h.post({ action: 'wake' })
    const wokeAt = (await h.view()).clock.lastWake!.at
    expect(h.prompt(0)).toContain('Watch at least 3 videos through their subtitles this wake before you settle on anything for the owner; the host holds back an answer sent sooner and asks you to keep browsing.')
    await h.run(h.account.video('BV1aa4y1X7aa'))
    await h.answer('魔女大人，这只猫会开门 https://www.bilibili.com/video/BV1aa4y1X7aa')
    expect(fake.sentMessages).toEqual([])
    expect(h.sessions.prompts).toHaveLength(2)
    expect(h.prompt(1)).toBe([
      'Keep browsing: you have watched 1 of at least 3 videos this wake (continuation 1 of 2).',
      'Your last answer was held back, not sent: «魔女大人，这只猫会开门 https://www.bilibili.com/video/BV1aa4y1X7aa»',
      'Not graded must with bili_verdict, so they cannot go to the owner: BV1aa4y1X7aa. Read their subtitles and grade them, or leave them out.',
      'Try a source you have not used this wake (a search on the owner\'s keywords, popular, the leaderboard, hot searches, your following feed, the home feed), watch and grade what looks good, then send this wake\'s must videos in one message, or exactly NO_REPLY.',
    ].join('\n'))
    // A continuation is the same wake, not a new one.
    expect((await h.view()).clock.lastWake!.at).toBe(wokeAt)
    expect(h.logs.some(line => line.text === 'bili: the manual wake watched 1 of 3 video(s); asking for more (continuation 1 of 2)')).toBe(true)

    // The same video twice counts once.
    await h.run(h.account.video('BV1aa4y1X7aa'))
    await h.run(h.account.video('BV1cc4y1X7cc'))
    await h.run(h.account.video('BV1dd4y1X7dd'))
    expect(await h.account.verdict('BV1cc4y1X7cc', 'must', '说的就是我们这种 agent')).toEqual({ saved: true, grade: 'must' })
    await h.answer('魔女大人，B站鱼灾一周全复盘 https://www.bilibili.com/video/BV1cc4y1X7cc')
    expect(fake.sentMessages.map(message => message.text)).toEqual(['魔女大人，B站鱼灾一周全复盘 https://www.bilibili.com/video/BV1cc4y1X7cc'])
    expect(h.sessions.prompts).toHaveLength(2)
    expect(h.logs.some(line => line.text === 'bili: the manual wake ends after 3 video(s) watched and 1 continuation(s)')).toBe(true)
  })

  it('asks again after NO_REPLY, and after the last continuation lets the wake end, sending what it answered', async () => {
    const h = await deep()
    await vi.advanceTimersByTimeAsync(Date.parse('2026-10-23T17:00:05Z') - Date.now())
    expect(h.sessions.prompts).toHaveLength(1)
    await h.answer('NO_REPLY')
    expect(h.sessions.prompts).toHaveLength(2)
    expect(h.prompt(1)).toBe([
      'Keep browsing: you have watched 0 of at least 3 videos this wake (continuation 1 of 2).',
      'Try a source you have not used this wake (a search on the owner\'s keywords, popular, the leaderboard, hot searches, your following feed, the home feed), watch and grade what looks good, then send this wake\'s must videos in one message, or exactly NO_REPLY.',
    ].join('\n'))
    await h.answer(undefined)
    expect(h.sessions.prompts).toHaveLength(3)
    expect(h.prompt(2)).toContain('(continuation 2 of 2)')
    // Two continuations are the most: the third answer goes out, short of the floor or not.
    await h.answer('魔女大人，今天没刷到好的，就这只猫 https://www.bilibili.com/video/BV1aa4y1X7aa')
    expect(h.sessions.prompts).toHaveLength(3)
    expect(fake.sentMessages).toHaveLength(1)
    expect(h.logs.some(line => line.text === 'bili: the clock wake ends after 0 video(s) watched and 2 continuation(s); 1 link(s) not graded must go out anyway')).toBe(true)
  })

  it('holds a find that links a video not graded must, even after enough watching, and grades only with evidence', async () => {
    const h = await deep()
    await h.post({ action: 'wake' })
    for (const bvid of ['BV1aa4y1X7aa', 'BV1bb4y1X7bb', 'BV1cc4y1X7cc']) await h.run(h.account.video(bvid))
    // BV1bb4y1X7bb has no subtitles: from its title alone it is at most ok.
    expect(await h.account.verdict('BV1bb4y1X7bb', 'must', '风景很好')).toEqual({ refused: 'you have not read the subtitles of BV1bb4y1X7bb (bili_video); without them it is at most ok' })
    expect(await h.account.verdict('BV1bb4y1X7bb', 'ok', '看不到画面，只知道标题')).toEqual({ saved: true, grade: 'ok' })
    await h.answer('魔女大人，风景 https://www.bilibili.com/video/BV1bb4y1X7bb')
    expect(fake.sentMessages).toEqual([])
    expect(h.prompt(1)).toContain('Not yet: you watched 3 videos this wake, but your answer cannot go out as it is (continuation 1 of 2).')
    expect(h.prompt(1)).toContain('Not graded must with bili_verdict, so they cannot go to the owner: BV1bb4y1X7bb.')
    expect(await h.account.verdict('BV1cc4y1X7cc', 'must', '鱼灾复盘')).toEqual({ saved: true, grade: 'must' })
    await h.answer('魔女大人，鱼灾复盘 https://www.bilibili.com/video/BV1cc4y1X7cc')
    expect(fake.sentMessages).toHaveLength(1)
    // The seen list keeps the grades, the search marks them, and Settings shows the day.
    expect((await h.account.seen()).entries.map(entry => [entry.bvid, entry.grade, entry.read])).toEqual([['BV1cc4y1X7cc', 'must', true], ['BV1bb4y1X7bb', 'ok', false]])
    expect((await h.run(h.account.search('鱼灾'))).find(card => card.bvid === 'BV1cc4y1X7cc')?.graded).toBe('must')
    const view = await h.view()
    expect(view.today.graded).toEqual({ must: 1, ok: 1, skip: 0 })
    expect(view.seen[0]).toMatchObject({ bvid: 'BV1cc4y1X7cc', title: '鱼灾复盘', author: '复盘君', grade: 'must', sent: true })
  })

  it('never holds a reply to the owner, and ends the wake when the owner stops it', async () => {
    const h = await deep({ inboxPollMs: 600_000 })
    await vi.advanceTimersByTimeAsync(600_000)
    fake.ownerMessages.push({ sender: OWNER, text: '在吗', key: '6984393491767670001', at: Math.floor(Date.now() / 1000) })
    fake.unread.follow = 1
    await vi.advanceTimersByTimeAsync(600_000)
    expect(h.sessions.prompts).toHaveLength(1)
    await h.answer('在')
    expect(fake.sentMessages.map(message => message.text)).toEqual(['在'])
    expect(h.sessions.prompts).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(61_000)
    await h.post({ action: 'wake' })
    expect(h.sessions.prompts).toHaveLength(2)
    await h.answer('半句', { kind: 'aborted', reason: { kind: 'user' } })
    expect(h.sessions.prompts).toHaveLength(2)
    expect(fake.sentMessages).toHaveLength(1)
    expect(h.logs.some(line => line.text === 'bili: the manual wake ends: its turn did not complete (0 video(s) watched)')).toBe(true)
  })

  it('holds nothing without a floor', async () => {
    const h = await deep({ depth: { minWatched: 0 } })
    await h.post({ action: 'wake' })
    expect(h.prompt(0)).not.toContain('Watch at least')
    await h.answer('魔女大人，看猫 https://www.bilibili.com/video/BV1aa4y1X7aa')
    expect(fake.sentMessages).toHaveLength(1)
    expect(h.sessions.prompts).toHaveLength(1)
  })
})

describe('replies to the owner', () => {
  it('answers every message the owner sends, with no daily cap on replies', async () => {
    const h = await deep({ inboxPollMs: 600_000, depth: { minWatched: 0 } })
    await vi.advanceTimersByTimeAsync(600_000)
    let key = 6_984_393_491_767_680_000n
    for (let index = 0; index < 40; index += 1) {
      key += 1n
      fake.ownerMessages.push({ sender: OWNER, text: `第${index}条`, key: String(key), at: Math.floor(Date.now() / 1000) })
      fake.unread.follow = 1
      // The first waits for the 10-minute check; then the conversation is checked every minute.
      await vi.advanceTimersByTimeAsync(index === 0 ? 600_000 : 65_000)
      await h.answer(`回${index}`)
    }
    expect(fake.sentMessages).toHaveLength(40)
    expect(h.notes).toEqual([])
    expect((await h.view()).usage.actions.some(row => (row.action as string) === 'dmReply')).toBe(false)
  })
})
