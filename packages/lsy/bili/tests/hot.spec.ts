/** `ctx.biliHot`: hot comments and hot-search words from the account's existing reads, without any person, bounded and expiring. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOT_MAX_COMMENTS, HOT_MIN_LIKES, HOT_TTL_MS, hotText, type HotStore } from '../src/hot.ts'
import { FakeBiliSvc } from './fake-bili-svc.ts'
import { allLogs, contexts, harness } from './harness.ts'

const DAY = 86_400_000
let dir: string
let svc: FakeBiliSvc

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bili-hot-'))
  svc = new FakeBiliSvc()
  svc.addVideo({ aid: 103, bvid: 'BV1UnHN6SECP', cid: 9003, title: '海水过滤器测试', desc: '', owner: { mid: 779, name: '测试号' } })
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-01T14:00:00.000Z'))
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
  allLogs.splice(0)
})

/** Add a top-level comment under the 海水过滤器 video. */
function addComment(rpid: number, message: string, like: number, uname = '热心网友'): void {
  svc.comments.push({ rpid: String(rpid), oid: '103', root: '0', mid: 9000 + rpid, uname, message, like })
}

describe('ctx.biliHot', () => {
  it('keeps the owner-accepted meme shapes: hot comments under bili_video and a hot-search keyword', async () => {
    addComment(1, '你们慢慢玩吧，我已经打捞到海水过滤器了', 132, '网友甲')
    addComment(2, '海水过滤器已经过时了，现在是电鳗发电机[吃瓜]', 34, '网友乙')
    addComment(3, '前排', 3, '网友丙')
    const h = await harness({ svc, workspace: dir })
    expect(h.ctx.get('biliHot')).toBeDefined()
    await h.account.video('BV1UnHN6SECP')
    await vi.advanceTimersByTimeAsync(0)
    const at = Date.now()
    expect(await h.ctx.biliHot.comments({ since: 0 })).toEqual([
      { text: '你们慢慢玩吧，我已经打捞到海水过滤器了', likes: 132, bvid: 'BV1UnHN6SECP', at },
      { text: '海水过滤器已经过时了，现在是电鳗发电机[吃瓜]', likes: 34, bvid: 'BV1UnHN6SECP', at },
    ].sort((a, b) => b.likes - a.likes))

    svc.answer('hotSearch', { body: { ok: true, code: 0, message: '', data: { trending: { list: [{ keyword: '真实拍视频日常有多烧心' }, { keyword: '鱼灾', show_name: 'B站鱼灾' }] } } } })
    await h.account.hotSearches()
    await vi.advanceTimersByTimeAsync(0)
    const words = await h.ctx.biliHot.words()
    expect(words).toContain('真实拍视频日常有多烧心')
    expect(words).toContain('B站鱼灾')
    expect(h.logs.some(line => line.text.includes('bili: hot comments: kept 2 of 3 under BV1UnHN6SECP'))).toBe(true)
  })

  it('stores no UID or nickname, and drops comments that name a person', async () => {
    addComment(1, '回复 @网友乙 :海水过滤器yyds', 50, '网友甲')
    addComment(2, '@网友乙 看这个', 50, '网友甲')
    addComment(3, '电鳗发电机真的离谱', 50, '独特昵称丁')
    const h = await harness({ svc, workspace: dir })
    await h.account.comments('BV1UnHN6SECP')
    await vi.advanceTimersByTimeAsync(0)
    const rows = await h.ctx.biliHot.comments()
    expect(rows.map(row => row.text).sort()).toEqual(['电鳗发电机真的离谱', '海水过滤器yyds'].sort())
    const dump = JSON.stringify(rows)
    expect(dump).not.toContain('独特昵称丁')
    expect(dump).not.toContain('9003')
    expect(Object.keys(rows[0]!).sort()).toEqual(['at', 'bvid', 'likes', 'text'])
  })

  it('keeps the largest like count of a comment seen again, and filters by since', async () => {
    addComment(1, '海水过滤器', HOT_MIN_LIKES)
    const h = await harness({ svc, workspace: dir })
    await h.account.comments('BV1UnHN6SECP')
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(Date.now() + DAY)
    svc.comments[0]!.like = 90
    await h.account.comments('BV1UnHN6SECP')
    await vi.advanceTimersByTimeAsync(0)
    expect(await h.ctx.biliHot.comments()).toMatchObject([{ text: '海水过滤器', likes: 90 }])
    expect(await h.ctx.biliHot.comments({ since: Date.now() + 1 })).toEqual([])
  })

  it('expires rows after 14 days and never returns them', async () => {
    addComment(1, '海水过滤器', 100)
    const h = await harness({ svc, workspace: dir })
    await h.account.comments('BV1UnHN6SECP')
    await h.account.hotSearches()
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(Date.now() + HOT_TTL_MS - 1)
    expect(await h.ctx.biliHot.comments()).toHaveLength(1)
    expect((await h.ctx.biliHot.words()).length).toBeGreaterThan(0)
    vi.setSystemTime(Date.now() + 2)
    expect(await h.ctx.biliHot.comments()).toEqual([])
    expect(await h.ctx.biliHot.words()).toEqual([])
  })

  it('caps the comments, dropping the oldest read first, and survives a restart', async () => {
    const h = await harness({ svc, workspace: dir })
    // Fill past the cap through the store the reads use (the fake serves 20 comments a page).
    const view = (rpid: number) => ({ rpid: String(rpid), author: '', text: `梗${rpid}号`, likes: 50 })
    const store = h.ctx.biliHot as HotStore
    for (let batch = 0; batch < 11; batch += 1) {
      vi.setSystemTime(Date.now() + 1000)
      await store.noteComments('BV1UnHN6SECP', Array.from({ length: 200 }, (_, index) => view(batch * 200 + index)))
    }
    const rows = await h.ctx.biliHot.comments()
    expect(rows).toHaveLength(HOT_MAX_COMMENTS)
    expect(rows.some(row => row.text === '梗0号')).toBe(false)
    expect(rows.some(row => row.text === '梗2199号')).toBe(true)

    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
    const again = await harness({ svc, workspace: dir, pool: h.pool })
    expect(await again.ctx.biliHot.comments()).toHaveLength(HOT_MAX_COMMENTS)
  })

  it('reads still work when the store fails, and the failure is logged', async () => {
    addComment(1, '海水过滤器', 100)
    const h = await harness({ svc, workspace: dir })
    Reflect.set(h.ctx.biliHot, 'serialize', () => Promise.reject(new Error('disk full')))
    expect((await h.account.comments('BV1UnHN6SECP')).comments).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.logs.some(line => line.type === 'warn' && line.text.includes('hot comments not kept: disk full'))).toBe(true)
  })

  it('hotText strips the reply prefix, collapses whitespace, bounds length, and refuses mentions and one-character lines', () => {
    expect(hotText('回复 @某人 : 烧心')).toBe('烧心')
    expect(hotText('a   b')).toBe('a b')
    expect(hotText('哈')).toBeUndefined()
    expect(hotText('找 @某人')).toBeUndefined()
    expect(Array.from(hotText('梗'.repeat(500))!)).toHaveLength(200)
  })
})
