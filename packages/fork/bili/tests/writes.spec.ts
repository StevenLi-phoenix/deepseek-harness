import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BILI_NOTICE_ORIGIN } from '../src/dm.ts'
import { FakeBili, replyItem } from './fake-bili.ts'
import { allLogs, contexts, credentialStore, harness } from './harness.ts'

const CAT = 'BV1aa4y1X7aa'
const VIEW = 'BV1bb4y1X7bb'
let dir: string
let fake: FakeBili

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bili-writes-'))
  fake = new FakeBili()
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
  expect(allLogs.splice(0).filter(line => /sess\d|csrf\d|refresh-token-/.test(line.text))).toEqual([])
})

/** A signed-in mount. */
async function signedIn(config: Record<string, unknown> = {}, credentials = credentialStore()) {
  const h = await harness({ bili: fake, credentials, workspace: dir, config })
  await h.signIn()
  return h
}

describe('write guard', () => {
  it('spaces writes by a random 60-180 s gap, checks identity before each, and keeps a ledger', async () => {
    const h = await signedIn()
    const first = await h.run(h.account.like(CAT))
    expect(first).toEqual({ outcome: 'sent', detail: 'like sent' })
    const likedAt = fake.requestsTo('/x/web-interface/archive/like').length
    expect(likedAt).toBe(1)
    const start = Date.now()
    expect(await h.run(h.account.watchLater(CAT))).toEqual({ outcome: 'sent', detail: 'watchlater sent' })
    // random() is 0.5: the gap is 60 s + 0.5 × 120 s.
    expect(Date.now() - start).toBeGreaterThanOrEqual(120_000)
    expect(fake.toview.has(101)).toBe(true)
    // Each write was preceded by nav (identity), and the like carried the account's csrf and buvid3.
    const like = fake.requestsTo('/x/web-interface/archive/like')[0]!
    expect(like.form).toMatchObject({ aid: '101', like: '1', csrf: fake.session!.bili_jct })
    expect(like.headers['cookie']).toContain('buvid3=BUVID3-FAKE-infoc')
    expect(like.headers['referer']).toBe(`https://www.bilibili.com/video/${CAT}/`)
    expect(like.headers['origin']).toBe('https://www.bilibili.com')
    const recent = (await h.view()).recent
    expect(recent.map(row => [row.action, row.target, row.state])).toEqual([['watchlater', CAT, 'accepted'], ['like', CAT, 'accepted']])
    expect((await h.view()).usage.actions.find(row => row.action === 'like')).toEqual({ action: 'like', used: 1, cap: 30 })
  })

  it('answers "try later" when the slot is further away than the wait bound', async () => {
    const h = await signedIn({ writeWaitMs: 10_000 })
    await h.run(h.account.like(CAT))
    const later = await h.run(h.account.follow(777))
    // The like set the slot 120 s ahead; the follow's checks took a few seconds of it.
    expect(later.outcome).toBe('refused')
    expect(later.detail).toMatch(/^the next write slot opens in 1 min; try later$/)
    expect(fake.requestsTo('/x/relation/modify')).toEqual([])
  })

  it('enforces daily caps, counts uncertain writes, and never resends an uncertain one', async () => {
    const h = await signedIn({ caps: { like: 2 } })
    fake.reply('/x/web-interface/archive/like', new TypeError('fetch failed'))
    const lost = await h.run(h.account.like(CAT))
    expect(lost).toEqual({ outcome: 'uncertain', detail: 'the outcome is unknown (like: network error (TypeError)); it counts against today\'s budget and will not be sent again' })
    // Same target again: refused without a request.
    expect(await h.run(h.account.like(CAT))).toEqual({ outcome: 'refused', detail: 'an earlier like of BV1aa4y1X7aa has an unknown outcome; it is never sent again' })
    expect(await h.run(h.account.like(VIEW))).toMatchObject({ outcome: 'sent' })
    // Two counted (one uncertain, one accepted): the cap of 2 is reached.
    expect(await h.run(h.account.like('BV1cc4y1X7cc'))).toEqual({ outcome: 'refused', detail: 'today\'s like budget (2) is used up' })
    expect(fake.requestsTo('/x/web-interface/archive/like')).toHaveLength(2)
    // The next local day has a fresh budget.
    vi.setSystemTime(new Date('2026-10-24T14:00:00.000Z'))
    fake.addVideo({ aid: 103, bvid: 'BV1cc4y1X7cc', cid: 9003, title: 'c', desc: '', owner: { mid: 1, name: 'c' } })
    expect(await h.run(h.account.like('BV1cc4y1X7cc'))).toMatchObject({ outcome: 'sent' })
  })

  it('records a write in flight at shutdown as uncertain after a restart', async () => {
    const credentials = credentialStore()
    const h = await signedIn({}, credentials)
    // Hold the like request open, then stop the host.
    let release: (() => void) | undefined
    fake.reply('/x/web-interface/archive/like', new Error('placeholder'))
    const original = fake.fetch
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      if (input.includes('/archive/like')) {
        await new Promise<void>((resolve) => { release = resolve })
        throw new Error('host stopped')
      }
      return original(input, init)
    })
    const pending = h.account.like(CAT)
    pending.catch(() => undefined)
    for (let step = 0; step < 20 && release === undefined; step += 1) await vi.advanceTimersByTimeAsync(500)
    expect(release).toBeDefined()
    // Simulate a crash: the stored row stays reserved; a new mount on the same storage settles it.
    const again = await harness({ bili: fake, credentials, pool: h.pool, workspace: dir })
    vi.stubGlobal('fetch', fake.fetch)
    release!()
    const rows = (await again.view()).recent
    expect(rows[0]).toMatchObject({ action: 'like', target: CAT, state: 'uncertain', detail: 'the host stopped while the request was in flight' })
    expect(again.logs.some(line => line.text === 'bili: 1 write(s) were in flight when the host stopped; recorded as uncertain and never retried')).toBe(true)
  })

  it('refuses a write when the cookies belong to another account', async () => {
    const h = await signedIn()
    fake.account = { ...fake.account, mid: 9 }
    expect(await h.run(h.account.like(CAT))).toEqual({ outcome: 'refused', detail: 'the cookies belong to account 9, not 3000001' })
    expect(fake.requestsTo('/x/web-interface/archive/like')).toEqual([])
  })

  it('makes like, follow, favorite, and watch later idempotent with a pre-read', async () => {
    const h = await signedIn()
    fake.liked.add(101)
    fake.relations.set(777, 2)
    fake.folders[0]!.items.add(101)
    fake.toview.add(101)
    expect(await h.run(h.account.like(CAT))).toEqual({ outcome: 'already', detail: 'already liked' })
    expect(await h.run(h.account.follow(777))).toEqual({ outcome: 'already', detail: 'already following' })
    expect(await h.run(h.account.favorite(CAT))).toEqual({ outcome: 'already', detail: 'already in folder 默认收藏夹' })
    expect(await h.run(h.account.watchLater(CAT))).toEqual({ outcome: 'already', detail: 'already on watch later' })
    expect(await h.run(h.account.unfollow(778))).toEqual({ outcome: 'already', detail: 'not following' })
    // Nothing was written (beyond the sign-in's device enrollment) and nothing counted.
    expect(fake.requests.filter(request => request.method === 'POST' && request.path !== '/x/internal/gaia-gateway/ExClimbWuzhi')).toEqual([])
    expect((await h.view()).usage.actions.every(row => row.used === 0)).toBe(true)
    // A named folder and removal.
    expect(await h.run(h.account.favorite(CAT, { folderId: 1002 }))).toMatchObject({ outcome: 'sent' })
    expect(fake.folders[1]!.items.has(101)).toBe(true)
    expect(await h.run(h.account.favorite(CAT, { remove: true }))).toMatchObject({ outcome: 'sent' })
    expect(fake.folders[0]!.items.has(101)).toBe(false)
    expect(await h.run(h.account.unfollow(200000001))).toEqual({ outcome: 'refused', detail: 'the owner\'s account stays followed' })
  })
})

describe('public speech', () => {
  it('comments once per video, within 500 characters, and checks visibility as a signed-out visitor', async () => {
    const h = await signedIn()
    expect(await h.run(h.account.comment(CAT, 'x'.repeat(501)))).toEqual({ outcome: 'refused', detail: 'the text is 501 characters; the limit is 500' })
    expect(await h.run(h.account.comment(CAT, '   '))).toEqual({ outcome: 'refused', detail: 'the text is empty' })
    const sent = await h.run(h.account.comment(CAT, '它开门的样子好认真'))
    expect(sent).toEqual({ outcome: 'sent', detail: 'comment sent', receipt: '500000000001' })
    expect(fake.requestsTo('/x/v2/reply/add')[0]!.form).toMatchObject({ type: '1', oid: '101', message: '它开门的样子好认真', plat: '1' })
    expect(await h.run(h.account.comment(CAT, '再说一句'))).toEqual({ outcome: 'refused', detail: 'this account already commented on BV1aa4y1X7aa; one comment per video' })
    expect(fake.requestsTo('/x/v2/reply/add')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(320_000)
    const check = fake.requestsTo('/x/v2/reply/wbi/main').at(-1)!
    expect(check.headers['cookie']).toBeUndefined()
    expect(check.query).toMatchObject({ oid: '101', type: '1', mode: '2' })
    expect((await h.view()).recent[0]).toMatchObject({ action: 'comment', state: 'accepted', visibility: 'visible' })
    expect(h.notes).toEqual([])
  })

  it('pauses public speech when an accepted comment is invisible to others, and the owner resumes it', async () => {
    const h = await signedIn()
    fake.hideNewComments = true
    await h.run(h.account.comment(CAT, '好看'))
    await vi.advanceTimersByTimeAsync(320_000)
    expect((await h.view()).recent[0]).toMatchObject({ visibility: 'hidden' })
    expect((await h.view()).pause).toMatchObject({ scope: 'speech', reason: 'comment 500000000001 possibly hidden' })
    expect(h.notes).toEqual([{ title: 'dsh 在 B站的评论可能被隐藏了（BV1aa4y1X7aa），公开发言已暂停：设置 → B站账号 检查后点「恢复」', origin: BILI_NOTICE_ORIGIN }])
    expect(await h.run(h.account.dynamic('今天看到一只会开门的猫'))).toEqual({ outcome: 'refused', detail: 'public speech is paused (comment 500000000001 possibly hidden) until the owner resumes it in Settings' })
    // Quiet writes go on.
    expect(await h.run(h.account.like(CAT))).toMatchObject({ outcome: 'sent' })
    await h.post({ action: 'resume' })
    expect(await h.run(h.account.dynamic('今天看到一只会开门的猫'))).toEqual({ outcome: 'sent', detail: 'dynamic sent', receipt: '1150000000000000123' })
    expect(fake.dynamics).toEqual(['今天看到一只会开门的猫'])
  })

  it('re-arms a pending visibility check after a restart', async () => {
    const credentials = credentialStore()
    const h = await signedIn({}, credentials)
    fake.hideNewComments = true
    await h.run(h.account.comment(CAT, '好看'))
    await h.ctx.fiber.dispose()
    const again = await harness({ bili: fake, credentials, pool: h.pool, notes: h.notes, workspace: dir })
    await vi.advanceTimersByTimeAsync(320_000)
    expect((await again.view()).recent[0]).toMatchObject({ visibility: 'hidden' })
    expect(h.notes).toHaveLength(1)
  })

  it('replies only to comments that replied to or mentioned the account', async () => {
    const h = await signedIn()
    expect(await h.run(h.account.reply('600000000001', '谢谢'))).toEqual({ outcome: 'refused', detail: 'comment 600000000001 is not one that replied to or mentioned this account; read bili_inbox first' })
    fake.unread.reply = 1
    fake.comments.push({ rpid: '600000000001', oid: '101', type: 1, root: '0', mid: 888, uname: '热心网友', message: '你也喜欢猫？' })
    fake.replyItems = [replyItem(1, '600000000001', '你也喜欢猫？')]
    const inbox = await h.run(h.account.inbox())
    expect(inbox.replies).toEqual([{ id: '1', at: 1_790_000_000_000, from: '热心网友', fromMid: 888, text: '你也喜欢猫？', about: '一只猫学会了开门', rpid: '600000000001' }])
    expect(await h.run(h.account.reply('600000000001', '喜欢！'))).toMatchObject({ outcome: 'sent' })
    expect(fake.requestsTo('/x/v2/reply/add')[0]!.form).toMatchObject({ type: '1', oid: '101', root: '600000000001', parent: '600000000001', message: '喜欢！' })
    expect(await h.run(h.account.reply('600000000001', '再说一句'))).toEqual({ outcome: 'refused', detail: 'this account already replied to comment 600000000001' })
    // The reply is checked inside its thread.
    await vi.advanceTimersByTimeAsync(320_000)
    expect(fake.requestsTo('/x/v2/reply/reply').at(-1)!.query).toMatchObject({ root: '600000000001', oid: '101' })
    expect((await h.view()).recent[0]).toMatchObject({ action: 'reply', visibility: 'visible' })
  })
})

describe('messages to the owner', () => {
  it('messages only the configured owner, and only as mutual followers', async () => {
    const h = await signedIn()
    expect(await h.run(h.account.dmOwner('看到一个你会喜欢的视频'))).toEqual({
      outcome: 'refused',
      detail: 'this account does not follow the owner\'s account and they are not mutual followers; Bilibili delivers messages only between mutual followers (bili_follow the owner, then the owner follows back)',
    })
    fake.relations.set(200000001, 2)
    expect((await h.run(h.account.dmOwner('看到一个你会喜欢的视频'))).detail).toMatch(/^the owner's account does not follow this account back/)
    fake.relations.set(200000001, 6)
    expect(await h.run(h.account.dmOwner('看到一个你会喜欢的视频'))).toEqual({ outcome: 'sent', detail: 'dmOwner sent', receipt: '6984393491767669026' })
    expect(fake.sentMessages).toEqual([{ receiver: 200000001, text: '看到一个你会喜欢的视频' }])
    const send = fake.requestsTo('/web_im/v1/web_im/send_msg')[0]!
    expect(send.form).toMatchObject({ 'msg[sender_uid]': '3000001', 'msg[receiver_id]': '200000001', 'msg[msg_type]': '1', csrf: fake.session!.bili_jct, csrf_token: fake.session!.bili_jct })
    expect(send.query).toMatchObject({ w_sender_uid: '3000001', w_receiver_id: '200000001' })
    // The service has no way to name another recipient.
    expect(h.account.dmOwner.length).toBe(1)
  })

  it('refuses messages when no owner account is configured', async () => {
    const h = await harness({ bili: fake, workspace: dir, config: { ownerMid: undefined } })
    expect(await h.run(h.account.dmOwner('hi'))).toEqual({ outcome: 'refused', detail: 'no owner account is configured' })
  })

  it('messages the main account set in Settings, which wins over the configured one, and refuses bad UIDs', async () => {
    const h = await signedIn({ ownerMid: undefined })
    expect(await h.view()).toMatchObject({ ownerMid: 0, ownerUpdatedAt: null })
    for (const mid of [0, -5, 1.5, '200000002', 2 ** 53]) expect((await h.post({ action: 'owner', mid })).status).toBe(400)
    // The account's own UID is not the owner's main account.
    expect((await h.post({ action: 'owner', mid: 3000001 })).status).toBe(400)
    const saved = await (await h.post({ action: 'owner', mid: 200000002 })).json() as { ownerMid: number; ownerUpdatedAt: number | null }
    expect(saved).toMatchObject({ ownerMid: 200000002, ownerUpdatedAt: expect.any(Number) as unknown })
    fake.relations.set(200000002, 6)
    expect(await h.run(h.account.dmOwner('找到你了'))).toMatchObject({ outcome: 'sent' })
    expect(fake.sentMessages).toEqual([{ receiver: 200000002, text: '找到你了' }])

    const configured = await signedIn()
    await configured.post({ action: 'owner', mid: 200000002 })
    expect((await configured.view()).ownerMid).toBe(200000002)
  })
})
