/** Actions through bili-svc's door: pre-reads, what each sends, and how bili-svc's outcome reaches the model. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeBiliSvc } from './fake-bili-svc.ts'
import { allLogs, contexts, harness } from './harness.ts'

const OWNER = 200000001
let dir: string
let svc: FakeBiliSvc

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bili-writes-'))
  svc = new FakeBiliSvc()
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

describe('actions', () => {
  it('likes, follows, favorites, and puts on watch later through the door, each idempotent with a pre-read', async () => {
    const h = await harness({ svc, workspace: dir })
    expect(await h.account.like('BV1aa4y1X7aa')).toEqual({ outcome: 'sent', detail: 'like sent' })
    expect(svc.callsTo('like')[0]).toMatchObject({ account: 'maomao', form: { aid: '101', like: 1 }, referer: 'https://www.bilibili.com/en/video/BV1aa4y1X7aa/' })
    expect(await h.account.like('BV1aa4y1X7aa')).toEqual({ outcome: 'already', detail: 'already liked' })
    expect(svc.callsTo('like')).toHaveLength(1)

    expect(await h.account.follow(777)).toMatchObject({ outcome: 'sent' })
    expect(svc.callsTo('relationModify')[0]!.form).toMatchObject({ fid: 777, act: 1 })
    expect(await h.account.follow(777)).toEqual({ outcome: 'already', detail: 'already following' })
    expect(await h.account.follow(3_000_001)).toEqual({ outcome: 'refused', detail: 'this is the account itself' })
    expect(await h.account.follow(-1)).toEqual({ outcome: 'refused', detail: 'mid must be a positive user id' })
    expect(await h.account.unfollow(777)).toMatchObject({ outcome: 'sent' })
    expect(await h.account.unfollow(777)).toEqual({ outcome: 'already', detail: 'not following' })
    expect(await h.account.unfollow(OWNER)).toEqual({ outcome: 'refused', detail: 'the owner\'s account stays followed' })

    expect(await h.account.favorite('BV1aa4y1X7aa')).toMatchObject({ outcome: 'sent' })
    expect(svc.callsTo('favDeal')[0]!.form).toMatchObject({ rid: '101', add_media_ids: '1001', del_media_ids: '' })
    expect(await h.account.favorite('BV1aa4y1X7aa')).toEqual({ outcome: 'already', detail: 'already in folder 默认收藏夹' })
    expect(await h.account.favorite('BV1aa4y1X7aa', { folderId: 9 })).toEqual({ outcome: 'refused', detail: 'no favorite folder with id 9' })
    expect(await h.account.favorite('BV1aa4y1X7aa', { remove: true })).toMatchObject({ outcome: 'sent' })

    expect(await h.account.watchLater('BV1aa4y1X7aa')).toMatchObject({ outcome: 'sent' })
    expect(await h.account.watchLater('BV1aa4y1X7aa')).toEqual({ outcome: 'already', detail: 'already on watch later' })
    expect(await h.account.watchLater('BV1aa4y1X7aa', true)).toMatchObject({ outcome: 'sent' })
    expect(await h.account.watchLater('BV1aa4y1X7aa', true)).toEqual({ outcome: 'already', detail: 'not on watch later' })
    expect(await h.account.like('nope')).toEqual({ outcome: 'refused', detail: '"nope" is not a BV id' })
    expect(h.logs.some(line => line.text === 'bili: like BV1aa4y1X7aa sent')).toBe(true)
  })

  it('passes bili-svc\'s caps, holds, once-rules, and unknown outcomes to the model, and never retries', async () => {
    const h = await harness({ svc, workspace: dir })
    svc.answer('like', { body: { ok: false, outcome: 'refused', reason: 'daily cap of like reached (30)' } })
    expect(await h.account.like('BV1aa4y1X7aa')).toEqual({ outcome: 'refused', detail: 'bili-svc refused it (daily cap of like reached (30))' })
    svc.answer('like', { body: { ok: false, outcome: 'held', reason: 'brake: risk -352' } })
    expect(await h.account.like('BV1aa4y1X7aa')).toEqual({ outcome: 'refused', detail: 'bili-svc held it (brake: risk -352); actions wait until bili-svc lets them through again' })
    svc.answer('like', { body: { ok: false, outcome: 'uncertain', reason: 'the request may or may not have reached Bilibili; it is never retried' } })
    expect(await h.account.like('BV1aa4y1X7aa')).toMatchObject({ outcome: 'uncertain' })
    svc.answer('like', { body: { ok: false, outcome: 'already', reason: 'like on 101 was already done' } })
    expect(await h.account.like('BV1aa4y1X7aa')).toEqual({ outcome: 'already', detail: 'bili-svc says it is already done (like on 101 was already done)' })
    svc.answer('like', { body: { ok: false, outcome: 'risk', code: -352, message: '风控校验失败' } })
    expect(await h.account.like('BV1aa4y1X7aa')).toEqual({ outcome: 'refused', detail: 'Bilibili\'s risk control stopped it (code -352: 风控校验失败); bili-svc holds actions until the owner releases its brake' })
    svc.answer('like', { body: { ok: false, outcome: 'verify', code: -110, message: '请先绑定手机号' } })
    expect(await h.account.like('BV1aa4y1X7aa')).toEqual({ outcome: 'refused', detail: 'Bilibili refused it until the account verifies a phone number: code -110 (请先绑定手机号)', verification: '请先绑定手机号' })
    svc.answer('like', { body: { ok: false, outcome: 'session_expired', code: -101 } })
    expect((await h.account.like('BV1aa4y1X7aa')).detail).toContain('the Bilibili session in bili-svc is not usable (session_expired)')
    // No answer by the deadline: the outcome is unknown, and nothing sends it again.
    svc.answer('like', new TypeError('fetch failed'))
    expect(await h.account.like('BV1aa4y1X7aa')).toEqual({ outcome: 'uncertain', detail: 'the outcome is unknown (like: bili-svc is unreachable (TypeError)); it is never sent again' })
    expect(svc.callsTo('like')).toHaveLength(8)
    // A failed pre-read sends nothing.
    svc.answer('hasLike', { body: { ok: false, outcome: 'api_error', code: -500, message: '服务器错误' } })
    expect(await h.account.like('BV1aa4y1X7aa')).toEqual({ outcome: 'refused', detail: 'could not check before writing: hasLike: code -500 (服务器错误)' })
    expect(svc.callsTo('like')).toHaveLength(8)
  })

  it('gives an original 2 coins by default and a repost 1, refuses past the balance, and reports coins given before as already', async () => {
    const h = await harness({ svc, workspace: dir })
    expect(await h.account.coin('BV1aa4y1X7aa', 3)).toEqual({ outcome: 'refused', detail: 'count must be 1 or 2' })
    expect(await h.account.coin('BV1oo4y1X7oo', 2)).toEqual({ outcome: 'refused', detail: 'BV1oo4y1X7oo is not marked original, so Bilibili takes at most 1 coin for it' })
    expect(await h.account.coin('BV1aa4y1X7aa')).toEqual({ outcome: 'sent', detail: 'gave 2 coins' })
    expect(svc.callsTo('coin')[0]!.form).toMatchObject({ aid: '101', multiply: 2, select_like: 0 })
    expect(await h.account.coin('BV1aa4y1X7aa')).toEqual({ outcome: 'already', detail: 'this account already gave this video 2 coins; one coin write per video' })
    svc.account.coins = 0
    expect(await h.account.coin('BV1bb4y1X7bb')).toEqual({ outcome: 'refused', detail: 'the account has 0 coins; this needs 2 (about one comes each day from signing in)' })
    expect(svc.callsTo('coin')).toHaveLength(1)
    svc.account.coins = 5
    svc.answer('coin', { body: { ok: false, outcome: 'api_error', code: 34004, message: '操作太快' } })
    expect(await h.account.coin('BV1bb4y1X7bb')).toEqual({ outcome: 'refused', detail: 'Bilibili refused it: code 34004 (操作太快): coins were given too quickly' })
  })

  it('triples in one call, reports parts done before, answers already when all are done, and leaves once-ever to bili-svc', async () => {
    const h = await harness({ svc, workspace: dir })
    svc.liked.add(102)
    expect(await h.account.triple('BV1bb4y1X7bb')).toEqual({ outcome: 'sent', detail: 'gave 2 coins, saved to the default folder; already done before: like' })
    expect(svc.callsTo('triple')[0]!.form).toMatchObject({ aid: '102' })
    expect(await h.account.triple('BV1bb4y1X7bb')).toEqual({ outcome: 'already', detail: 'this account already liked, coined, and saved this video' })
    expect(svc.callsTo('triple')).toHaveLength(1)
    // bili-svc keeps a triple to once per video ever, even when the pre-read finds something left.
    svc.liked.delete(102)
    expect(await h.account.triple('BV1bb4y1X7bb')).toEqual({ outcome: 'already', detail: 'bili-svc says it is already done (triple on 102 was already done)' })
    svc.account.coins = 1
    expect(await h.account.triple('BV1aa4y1X7aa')).toEqual({ outcome: 'refused', detail: 'the account has 1 coin; this needs 2 (about one comes each day from signing in)' })
  })

  it('reports one watch of a video whose subtitles it read, as far as it read, and leaves once a day to bili-svc', async () => {
    const h = await harness({ svc, workspace: dir })
    await h.account.video('BV1aa4y1X7aa')
    await vi.advanceTimersByTimeAsync(0)
    expect(svc.watched).toEqual([expect.objectContaining({ aid: '101', bvid: 'BV1aa4y1X7aa', cid: 9001, mid: 3_000_001, played_time: 4, video_duration: 125, dt: 2 })])
    await h.account.video('BV1aa4y1X7aa')
    await vi.advanceTimersByTimeAsync(0)
    expect(svc.callsTo('watchReport')).toHaveLength(2)
    expect(svc.watched).toHaveLength(1)
    expect(h.logs.some(line => line.text.startsWith('bili: watch BV1aa4y1X7aa already: bili-svc says it is already done'))).toBe(true)
    // No subtitles read, no report.
    await h.account.video('BV1bb4y1X7bb')
    await vi.advanceTimersByTimeAsync(0)
    expect(svc.callsTo('watchReport')).toHaveLength(2)
  })
})
