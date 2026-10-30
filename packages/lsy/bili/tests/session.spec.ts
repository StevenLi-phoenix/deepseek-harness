import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BILI_NOTICE_ORIGIN } from '../src/dm.ts'
import { GRANT_KEY } from '../src/index.ts'
import { FakeBili } from './fake-bili.ts'
import { allLogs, contexts, credentialStore, harness } from './harness.ts'

let dir: string
let fake: FakeBili

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bili-session-'))
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
  expect(allLogs.splice(0).filter(line => /sess\d|csrf\d|refresh-token-|rcsrf/.test(line.text))).toEqual([])
})

/** The fields of a stored grant the tests read. */
interface StoredGrant {
  cookies: Record<string, string>
  refreshToken: string
  refreshedAt: number
}

/** The stored grant's payload. */
function grantOf(credentials: ReturnType<typeof credentialStore>): StoredGrant {
  return (credentials.records.get(GRANT_KEY) as { payload: StoredGrant }).payload
}

describe('cookie refresh', () => {
  it('refreshes when Bilibili asks, stores the new session, then retires the old token', async () => {
    const credentials = credentialStore()
    const h = await harness({ bili: fake, credentials, workspace: dir })
    await h.signIn()
    const before = grantOf(credentials)
    fake.refreshDue = true
    // The first check runs a minute after start.
    await vi.advanceTimersByTimeAsync(70_000)

    const after = grantOf(credentials)
    expect(after.cookies['SESSDATA']).toBe(fake.session!.SESSDATA)
    expect(after.cookies['SESSDATA']).not.toBe(before.cookies['SESSDATA'])
    expect(after.cookies['bili_jct']).toBe(fake.session!.bili_jct)
    expect(after.cookies['buvid3']).toBe('BUVID3-FAKE-infoc')
    expect(after.refreshToken).toBe('refresh-token-2')
    expect(after.refreshedAt).toBeGreaterThan(before.refreshedAt)
    // The correspond path decrypted to refresh_<timestamp> with the injected key, and confirm used the OLD token with the NEW csrf.
    expect(fake.requests.some(request => request.path.startsWith('/correspond/1/') && request.headers['cookie']?.includes(before.cookies['SESSDATA']!))).toBe(true)
    expect(fake.confirmed).toEqual([before.refreshToken])
    expect(fake.requestsTo('/x/passport-login/web/confirm/refresh')[0]!.form['csrf']).toBe(after.cookies['bili_jct'])
    // Every step goes out as the international web version, like the QR login that made the session.
    const steps = [
      ...['/x/passport-login/web/cookie/info', '/x/passport-login/web/cookie/refresh', '/x/passport-login/web/confirm/refresh'].map(path => fake.requestsTo(path)[0]!),
      fake.requests.find(request => request.path.startsWith('/correspond/1/'))!,
    ]
    for (const step of steps) expect(step.headers['referer']).toBe('https://www.bilibili.com/en/')
    for (const step of steps.slice(0, 3)) {
      expect(JSON.parse(step.query['x-bili-device-req-json']!)).toEqual({ platform: 'web', device: 'pc', spmid: '333.42', mobi_app: 'web_i' })
      expect(JSON.parse(step.query['x-bili-locale-json']!)).toEqual({ c_locale: { language: 'en' } })
    }
    expect(h.notes).toEqual([])
    expect((await h.view()).account.state).toBe('active')
    expect(h.logs.some(line => line.text === 'bili: refreshed the cookies of dsh-看客 (3000001)')).toBe(true)
  })

  it('only records the check when no refresh is due', async () => {
    const h = await harness({ bili: fake, workspace: dir })
    await h.signIn()
    await vi.advanceTimersByTimeAsync(70_000)
    expect(fake.requests.filter(request => request.path.startsWith('/correspond'))).toEqual([])
    expect((await h.view()).account.checkedAt).toBeGreaterThan(0)
  })

  it('keeps the session when Bilibili refuses the refresh but nav still accepts the cookies, and tries again at the next check', async () => {
    const credentials = credentialStore()
    const h = await harness({ bili: fake, credentials, workspace: dir })
    await h.signIn()
    const before = grantOf(credentials)
    fake.refreshDue = true
    // What the overseas account met on 2026-10-26 and 2026-10-29: the refresh answers 48007 while the session still works.
    fake.reply('/x/passport-login/web/cookie/refresh', { body: { code: 48007, message: '当前账号暂不支持在本APP登录' } })
    await vi.advanceTimersByTimeAsync(70_000)

    const view = await h.view()
    expect(view.account).toMatchObject({ state: 'active' })
    expect(view.account.checkedAt).toBeGreaterThan(0)
    expect(h.notes).toEqual([])
    expect(grantOf(credentials)).toEqual(before)
    expect(h.logs.some(line => line.text === 'bili: cookie refresh (start) was refused (cookieRefresh: code 48007 (当前账号暂不支持在本APP登录)); the session still works, so it stays in use and the next check tries again')).toBe(true)
    expect(await h.run(h.account.like('BV1aa4y1X7aa'))).toMatchObject({ outcome: 'sent' })

    // The daily check asks again; this time the refresh goes through.
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(fake.requestsTo('/x/passport-login/web/cookie/refresh')).toHaveLength(2)
    expect(grantOf(credentials).refreshToken).toBe('refresh-token-2')
    expect((await h.view()).account.state).toBe('active')
  })

  it('keeps the account as it is when the refresh is refused and nav cannot be reached', async () => {
    const h = await harness({ bili: fake, workspace: dir })
    await h.signIn()
    fake.refreshDue = true
    fake.reply('/x/passport-login/web/cookie/refresh', { body: { code: 48007, message: '当前账号暂不支持在本APP登录' } })
    fake.reply('/x/web-interface/nav', new TypeError('fetch failed'))
    await vi.advanceTimersByTimeAsync(70_000)
    expect((await h.view()).account.state).toBe('active')
    expect(h.notes).toEqual([])
    expect(h.logs.some(line => line.text.startsWith('bili: cookie refresh (start) was refused (cookieRefresh: code 48007 (当前账号暂不支持在本APP登录)) and nav could not confirm the session: '))).toBe(true)
  })

  it('marks the account login-needed, stops writes, and tells the owner once when the refresh fails and nav says signed out', async () => {
    const h = await harness({ bili: fake, workspace: dir })
    await h.signIn()
    fake.refreshDue = true
    fake.reply('/x/passport-login/web/cookie/refresh', { body: { code: 86095, message: 'refresh_csrf 错误' } })
    fake.reply('/x/web-interface/nav', { body: { code: -101, message: '账号未登录', data: { isLogin: false } } })
    await vi.advanceTimersByTimeAsync(70_000)
    const reason = 'the cookie refresh failed (cookieRefresh: code 86095 (refresh_csrf 错误)) and Bilibili says the session is signed out'
    expect((await h.view()).account).toMatchObject({ state: 'login-needed', reason })
    expect(h.notes).toEqual([{ title: 'dsh 的 B站登录失效了：设置 → B站账号 扫码', origin: BILI_NOTICE_ORIGIN }])

    const like = await h.run(h.account.like('BV1aa4y1X7aa'))
    expect(like).toEqual({ outcome: 'refused', detail: `the Bilibili login needs renewing (${reason}); the owner has been told` })
    expect(fake.requestsTo('/x/web-interface/archive/like')).toEqual([])

    // Another expired session later does not repeat the notice.
    fake.session = undefined
    await expect(h.run(h.account.popular())).rejects.toThrow('the Bilibili login needs renewing')
    expect(h.notes).toHaveLength(1)

    // A new QR login clears the state.
    await h.signIn()
    expect((await h.view()).account.state).toBe('active')
  })

  it('treats code -101 on cookie/info as a dead session', async () => {
    const h = await harness({ bili: fake, workspace: dir })
    await h.signIn()
    fake.session = undefined
    await vi.advanceTimersByTimeAsync(70_000)
    expect((await h.view()).account.state).toBe('login-needed')
    expect(h.notes).toEqual([{ title: 'dsh 的 B站登录失效了：设置 → B站账号 扫码', origin: BILI_NOTICE_ORIGIN }])
  })
})

describe('risk brake', () => {
  it('pauses writes persistently on HTTP 412, backs reads off, tells the owner once, and only the Settings route resumes', async () => {
    const credentials = credentialStore()
    const h = await harness({ bili: fake, credentials, workspace: dir })
    await h.signIn()
    // Risk control on a read pauses every write and backs reads off.
    fake.reply('/x/web-interface/popular', { status: 412, raw: 'blocked' })
    await expect(h.run(h.account.popular())).rejects.toThrow('risk control (HTTP 412)')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.notes).toEqual([{ title: 'dsh 的 B站账号触发了风控（HTTP 412），所有写操作已暂停：设置 → B站账号 检查后点「恢复」', origin: BILI_NOTICE_ORIGIN }])
    const paused = await h.view()
    expect(paused.pause).toMatchObject({ scope: 'all', reason: 'HTTP 412' })
    expect(paused.readsResumeAt).toBe(Date.now() + 1_800_000 - (Date.now() - paused.pause!.since))
    await expect(h.run(h.account.popular())).rejects.toThrow(/reads are backing off/)

    // The pause survives a restart; nothing the model can call lifts it.
    await h.ctx.fiber.dispose()
    const again = await harness({ bili: fake, credentials, pool: h.pool, notes: h.notes, workspace: dir })
    expect((await again.view()).pause).toMatchObject({ scope: 'all' })
    expect(await again.run(again.account.follow(777))).toEqual({ outcome: 'refused', detail: 'writes are paused (HTTP 412) until the owner resumes them in Settings' })

    // While reads back off, the account card comes from storage; after the back-off a second risk answer sends no second notice.
    expect(await again.run(again.account.me())).toMatchObject({ signedIn: true, mid: 3_000_001, pause: 'all writes paused (HTTP 412) until the owner resumes them' })
    await vi.advanceTimersByTimeAsync(1_800_000)
    fake.reply('/x/web-interface/popular', { body: { code: -412, message: '请求被拦截' } })
    await expect(again.run(again.account.popular())).rejects.toThrow('risk control (code -412: 请求被拦截)')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.notes).toHaveLength(1)

    const resumed = await (await again.post({ action: 'resume' })).json() as { pause: unknown; readsResumeAt: unknown }
    expect(resumed).toMatchObject({ pause: null, readsResumeAt: null })
    expect(await again.run(again.account.follow(777))).toMatchObject({ outcome: 'sent' })
  })

  it('pauses only public writes after risk control on a like: reading and messages to the owner go on', async () => {
    fake.relations.set(200000001, 6)
    const h = await harness({ bili: fake, workspace: dir })
    await h.signIn()
    fake.reply('/x/web-interface/archive/like', { status: 412, raw: 'blocked' })
    expect(await h.run(h.account.like('BV1aa4y1X7aa'))).toEqual({
      outcome: 'refused', detail: 'Bilibili\'s risk control stopped it (HTTP 412); public writes are paused (messages to the owner still go) until the owner resumes them',
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.notes).toEqual([{ title: 'dsh 的 B站账号点赞、收藏、关注这类操作被风控拦了（HTTP 412），这类操作已暂停，给你的私信照常：设置 → B站账号 检查后点「恢复」', origin: BILI_NOTICE_ORIGIN }])
    const view = await h.view()
    expect(view.pause).toMatchObject({ scope: 'public', reason: 'HTTP 412' })
    expect(view.readsResumeAt).toBeNull()
    expect((await h.run(h.account.popular())).length).toBeGreaterThan(0)
    expect(await h.run(h.account.follow(777))).toEqual({ outcome: 'refused', detail: 'public writes are paused (HTTP 412) until the owner resumes them in Settings; messages to the owner still go' })
    expect(await h.run(h.account.dmOwner('魔女大人，看这个'))).toMatchObject({ outcome: 'sent' })
    // A later risk answer on a read widens the pause to every write.
    fake.reply('/x/web-interface/popular', { body: { code: -412, message: '请求被拦截' } })
    await expect(h.run(h.account.popular())).rejects.toThrow('risk control (code -412: 请求被拦截)')
    await vi.advanceTimersByTimeAsync(0)
    expect((await h.view()).pause).toMatchObject({ scope: 'all' })
    expect(h.notes).toHaveLength(2)
  })

  it('treats code -352 with a voucher as risk control', async () => {
    const h = await harness({ bili: fake, workspace: dir })
    await h.signIn()
    fake.reply('/x/web-interface/popular', { body: { code: -352, message: '风控校验失败', data: { v_voucher: 'voucher_abc' } } })
    await expect(h.run(h.account.popular())).rejects.toThrow('popular: risk control (captcha (code -352: 风控校验失败))')
    await vi.advanceTimersByTimeAsync(0)
    expect((await h.view()).pause).toMatchObject({ scope: 'all', reason: 'captcha (code -352: 风控校验失败)' })
  })

  it('keeps Bilibili\'s own words of a risk answer in the ledger, the pause, and the owner\'s notice', async () => {
    const h = await harness({ bili: fake, workspace: dir })
    await h.signIn()
    fake.reply('/x/web-interface/archive/like', { body: { code: -403, message: '账号异常,操作失败' } })
    const like = await h.run(h.account.like('BV1aa4y1X7aa'))
    expect(like).toEqual({ outcome: 'refused', detail: 'Bilibili\'s risk control stopped it (code -403: 账号异常,操作失败); public writes are paused (messages to the owner still go) until the owner resumes them' })
    await vi.advanceTimersByTimeAsync(0)
    expect((await h.view()).pause).toMatchObject({ scope: 'public', reason: 'code -403: 账号异常,操作失败' })
    expect(h.notes).toEqual([{ title: 'dsh 的 B站账号点赞、收藏、关注这类操作被风控拦了（code -403: 账号异常,操作失败），这类操作已暂停，给你的私信照常：设置 → B站账号 检查后点「恢复」', origin: BILI_NOTICE_ORIGIN }])
  })
})
