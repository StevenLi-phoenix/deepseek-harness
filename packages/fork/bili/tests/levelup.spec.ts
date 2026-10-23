import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeBili } from './fake-bili.ts'
import { allLogs, contexts, fakeSessions, harness } from './harness.ts'

const CAT = 'BV1aa4y1X7aa'
const VIEW = 'BV1bb4y1X7bb'
/** Reposted by the owner's main account: one coin at most, otherwise like any other video. */
const OWNERS = 'BV1oo4y1X7oo'

let dir: string
let fake: FakeBili

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bili-levelup-'))
  fake = new FakeBili()
  fake.relations.set(200000001, 6)
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

describe('watch reports', () => {
  it('reports one watch for a video whose subtitles it read, as far as it read, once a day and outside the write gap', async () => {
    const h = await harness({ bili: fake, workspace: dir })
    await h.signIn()
    const started = Date.now()
    await h.run(h.account.video(CAT))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fake.watched).toHaveLength(1)
    expect(fake.watched[0]).toMatchObject({ aid: '101', bvid: CAT, cid: '9001', mid: '3000001', played_time: '4', video_duration: '125', csrf: fake.session!.bili_jct })
    expect(Date.now() - started).toBeLessThan(60_000)
    // Reading it again today reports nothing more; a video without subtitles reports nothing.
    await h.run(h.account.video(CAT))
    await h.run(h.account.video(VIEW))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fake.watched).toHaveLength(1)
    expect((await h.view()).usage.actions.find(row => row.action === 'watch')).toEqual({ action: 'watch', used: 1, cap: 10 })
    // A write the model makes right after still gets its normal slot: the report took none.
    expect(await h.run(h.account.like(CAT))).toMatchObject({ outcome: 'sent' })
  })
})

describe('share reports', () => {
  it('reports a share only for a video the host delivered to the owner, once per video', async () => {
    const sessions = fakeSessions()
    const h = await harness({ bili: fake, sessions, workspace: dir })
    await h.signIn()
    await h.post({ action: 'wake' })
    h.emit('bili-1', assistant(`这个猫会开门 https://www.bilibili.com/video/${CAT}\n魔女转的也不错 https://www.bilibili.com/video/${OWNERS}`))
    h.emit('bili-1', { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(fake.sentMessages).toHaveLength(1)
    expect(fake.shared).toEqual([CAT, OWNERS])
    await vi.advanceTimersByTimeAsync(61_000)
    await h.post({ action: 'wake' })
    h.emit('bili-1', assistant(`再看一遍 https://www.bilibili.com/video/${CAT}`))
    h.emit('bili-1', { type: 'turn/end', seq: 12, data: { turn: 2, reason: { kind: 'completed' } } })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(fake.sentMessages).toHaveLength(2)
    expect(fake.requestsTo('/x/web-interface/share/add')).toHaveLength(2)
  })
})

describe('coins', () => {
  it('gives an original 2 coins by default, without a like, one coin write per video, and no daily cap', async () => {
    const h = await harness({ bili: fake, workspace: dir })
    await h.signIn()
    expect(await h.run(h.account.coin(CAT))).toEqual({ outcome: 'sent', detail: 'gave 2 coins' })
    expect(fake.requestsTo('/x/web-interface/coin/add')[0]!.form).toMatchObject({ aid: '101', multiply: '2', select_like: '0' })
    expect(fake.coined.get(101)).toBe(2)
    expect(fake.liked.has(101)).toBe(false)
    expect(await h.run(h.account.coin(CAT, 1))).toEqual({ outcome: 'refused', detail: 'this account already gave BV1aa4y1X7aa coins; one coin write per video' })
    // More coin writes the same day: only the balance (5) limits them.
    expect(await h.run(h.account.coin(VIEW, 1))).toEqual({ outcome: 'sent', detail: 'gave 1 coin' })
    expect(await h.run(h.account.coin(OWNERS))).toEqual({ outcome: 'sent', detail: 'gave 1 coin' })
    expect(fake.account.coins).toBe(1)
    expect(fake.requestsTo('/x/web-interface/coin/add')).toHaveLength(3)
    // Coins are not a budget: Settings lists no coin meter, and the prompt's budget line names none.
    expect((await h.view()).usage.actions.map(row => row.action)).not.toContain('coin')
    // Each coin write refreshes the balance Settings and bili_me show.
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await h.view()).progress).toMatchObject({ coins: 1 })
  })

  it('takes at most 1 coin for a repost', async () => {
    const h = await harness({ bili: fake, workspace: dir })
    await h.signIn()
    expect(await h.run(h.account.coin(OWNERS, 2))).toEqual({ outcome: 'refused', detail: 'BV1oo4y1X7oo is not marked original, so Bilibili takes at most 1 coin for it' })
    expect(await h.run(h.account.coin(OWNERS))).toEqual({ outcome: 'sent', detail: 'gave 1 coin' })
    expect(fake.requestsTo('/x/web-interface/coin/add')[0]!.form).toMatchObject({ aid: '104', multiply: '1' })
  })

  it('refuses when the balance is below count, and says how coins come', async () => {
    fake.account.coins = 1
    const h = await harness({ bili: fake, workspace: dir })
    await h.signIn()
    expect(await h.run(h.account.coin(CAT))).toEqual({ outcome: 'refused', detail: 'the account has 1 coin; this needs 2 (about one comes each day from signing in)' })
    expect(fake.requestsTo('/x/web-interface/coin/add')).toEqual([])
    expect(await h.run(h.account.coin(CAT, 1))).toMatchObject({ outcome: 'sent' })
  })

  it('reads coins the account gave before the ledger knew, and reports them as already', async () => {
    fake.coined.set(101, 1)
    const h = await harness({ bili: fake, workspace: dir })
    await h.signIn()
    expect(await h.run(h.account.coin(CAT, 1))).toEqual({ outcome: 'already', detail: 'this account already gave this video 1 coin; one coin write per video' })
    expect(fake.requestsTo('/x/web-interface/coin/add')).toEqual([])
  })

  it('reports Bilibili\'s refusal code as a refusal and never retries it', async () => {
    fake.reply('/x/web-interface/coin/add', { body: { code: 34005, message: '超过投币上限啦~' } })
    const h = await harness({ bili: fake, workspace: dir })
    await h.signIn()
    expect(await h.run(h.account.coin(CAT))).toEqual({
      outcome: 'refused',
      detail: 'Bilibili refused it: code 34005 (超过投币上限啦~): this video already has the most coins this account may give',
    })
    await vi.advanceTimersByTimeAsync(600_000)
    expect(fake.requestsTo('/x/web-interface/coin/add')).toHaveLength(1)
    expect((await h.view()).pause).toBeNull()
  })

  it('rejects a count other than 1 or 2 before any request', async () => {
    const h = await harness({ bili: fake, workspace: dir })
    await h.signIn()
    const before = fake.requests.length
    expect(await h.run(h.account.coin(CAT, 3))).toEqual({ outcome: 'refused', detail: 'count must be 1 or 2' })
    expect(fake.requests.length).toBe(before)
  })
})

describe('triple (一键三连)', () => {
  it('likes, gives 2 coins, and saves to the default folder in one request, once per video ever, with the normal gap', async () => {
    const h = await harness({ bili: fake, workspace: dir })
    await h.signIn()
    const started = Date.now()
    expect(await h.run(h.account.triple(CAT))).toEqual({ outcome: 'sent', detail: 'liked, gave 2 coins, saved to the default folder' })
    expect(fake.requestsTo('/x/web-interface/archive/like/triple')[0]!.form).toMatchObject({ aid: '101', csrf: fake.session!.bili_jct })
    expect(fake.liked.has(101)).toBe(true)
    expect(fake.folders[0]!.items.has(101)).toBe(true)
    expect(fake.coined.get(101)).toBe(2)
    // The like and favorite it added count against those caps; the triple itself has none.
    const usage = (await h.view()).usage.actions
    expect(usage.find(row => row.action === 'like')?.used).toBe(1)
    expect(usage.find(row => row.action === 'favorite')?.used).toBe(1)
    expect(usage.map(row => row.action)).not.toContain('triple')
    expect(await h.run(h.account.triple(CAT))).toEqual({ outcome: 'refused', detail: 'this account already gave BV1aa4y1X7aa a triple (一键三连); one per video' })
    // The parts read as done to the single writes too.
    expect(await h.run(h.account.like(CAT))).toEqual({ outcome: 'already', detail: 'already liked' })
    expect(await h.run(h.account.coin(CAT, 1))).toMatchObject({ outcome: 'already' })
    // The next write waited out the 60-180 s gap after the triple.
    expect(await h.run(h.account.like(VIEW))).toMatchObject({ outcome: 'sent' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(60_000)
    expect(fake.requestsTo('/x/web-interface/archive/like/triple')).toHaveLength(1)
  })

  it('reports parts already done, counts only what it adds, and gives a repost 1 coin', async () => {
    fake.liked.add(104)
    const h = await harness({ bili: fake, workspace: dir })
    await h.signIn()
    expect(await h.run(h.account.triple(OWNERS))).toEqual({ outcome: 'sent', detail: 'gave 1 coin, saved to the default folder; already done before: like' })
    expect(fake.coined.get(104)).toBe(1)
    const usage = (await h.view()).usage.actions
    expect(usage.find(row => row.action === 'like')?.used).toBe(0)
    expect(usage.find(row => row.action === 'favorite')?.used).toBe(1)
  })

  it('answers already, without a request, when every part is done', async () => {
    fake.liked.add(101)
    fake.folders[1]!.items.add(101)
    fake.coined.set(101, 1)
    const h = await harness({ bili: fake, workspace: dir })
    await h.signIn()
    expect(await h.run(h.account.triple(CAT))).toEqual({ outcome: 'already', detail: 'this account already liked, coined, and saved this video' })
    expect(fake.requestsTo('/x/web-interface/archive/like/triple')).toEqual([])
  })

  it('refuses when the balance cannot cover its coins, or a part it adds would pass a daily cap', async () => {
    fake.account.coins = 1
    const h = await harness({ bili: fake, workspace: dir, config: { caps: { like: 0 } } })
    await h.signIn()
    expect(await h.run(h.account.triple(OWNERS))).toEqual({ outcome: 'refused', detail: 'today\'s like budget (0) is used up, and the triple would add a like' })
    fake.liked.add(101)
    expect(await h.run(h.account.triple(CAT))).toEqual({ outcome: 'refused', detail: 'the account has 1 coin; this needs 2 (about one comes each day from signing in)' })
    // Already liked, a repost's single coin is covered: it goes through.
    fake.liked.add(104)
    expect(await h.run(h.account.triple(OWNERS))).toMatchObject({ outcome: 'sent' })
    expect(fake.requestsTo('/x/web-interface/archive/like/triple')).toHaveLength(1)
  })

  it('never sends a triple again after an uncertain outcome, and counts what it set out to add', async () => {
    fake.reply('/x/web-interface/archive/like/triple', new TypeError('fetch failed'))
    const h = await harness({ bili: fake, workspace: dir })
    await h.signIn()
    expect(await h.run(h.account.triple(CAT))).toMatchObject({ outcome: 'uncertain' })
    expect(await h.run(h.account.triple(CAT))).toEqual({ outcome: 'refused', detail: 'an earlier triple of BV1aa4y1X7aa has an unknown outcome; it is never sent again' })
    expect(fake.requestsTo('/x/web-interface/archive/like/triple')).toHaveLength(1)
    const usage = (await h.view()).usage.actions
    expect(usage.find(row => row.action === 'like')?.used).toBe(1)
    expect(usage.find(row => row.action === 'favorite')?.used).toBe(1)
  })
})

describe('the owner\'s videos', () => {
  it('follow the same rules as any other video', async () => {
    const h = await harness({ bili: fake, workspace: dir })
    await h.signIn()
    expect(await h.run(h.account.like(OWNERS))).toMatchObject({ outcome: 'sent' })
    expect(await h.run(h.account.comment(OWNERS, '好看'))).toMatchObject({ outcome: 'sent' })
    expect(await h.run(h.account.comment(OWNERS, '再来'))).toEqual({ outcome: 'refused', detail: 'this account already commented on BV1oo4y1X7oo; one comment per video' })
    await h.run(h.account.video(OWNERS))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fake.watched.map(row => row['bvid'])).toEqual([OWNERS])
  })
})

describe('level and daily rewards', () => {
  it('shows level, EXP to the next level, coins, and today\'s rewards in bili_me and Settings', async () => {
    const h = await harness({ bili: fake, workspace: dir })
    await h.signIn()
    const me = await h.run(h.account.me())
    expect(me).toMatchObject({
      level: 2, exp: { current: 1234, min: 200, next: 1500 }, coins: 5,
      rewards: { login: true, watch: false, share: false, coinExp: 0 },
    })
    await h.run(h.account.video(CAT))
    await vi.advanceTimersByTimeAsync(10_000)
    const progress = (await h.view()).progress
    expect(progress).toMatchObject({ level: 2, exp: 1234, min: 200, next: 1500, coins: 5, rewards: { day: '2026-10-23', login: true, watch: true, share: false, coinExp: 0 } })
  })
})
