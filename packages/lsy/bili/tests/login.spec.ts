import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GRANT_KEY } from '../src/index.ts'
import { FakeBili } from './fake-bili.ts'
import { allLogs, contexts, credentialStore, harness } from './harness.ts'

let dir: string
let fake: FakeBili

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bili-login-'))
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
  // No cookie value or refresh token ever reaches a log line.
  const secrets = /sess\d|csrf\d|refresh-token-|BUVID|ck\d|sid\d|qrkey/
  expect(allLogs.splice(0).filter(line => secrets.test(line.text))).toEqual([])
})

describe('QR login', () => {
  it('signs in by web QR and stores one credential record, never in logs or the view', async () => {
    const credentials = credentialStore()
    const h = await harness({ bili: fake, credentials, workspace: dir })
    expect((await h.view()).account).toEqual({ state: 'signed-out' })

    const started = await (await h.post({ action: 'login' })).json() as { login: { state: string; qr?: { modules: string[]; expiresAt: number } } }
    expect(started.login.state).toBe('waiting')
    expect(started.login.qr!.modules.length).toBeGreaterThan(20)
    expect(started.login.qr!.modules.every(row => /^[01]+$/.test(row))).toBe(true)
    // The key rides only inside the QR picture.
    expect(JSON.stringify(started)).not.toContain('qrkey')

    await vi.advanceTimersByTimeAsync(5000)
    expect((await h.view()).login.state).toBe('scanned')
    for (let step = 0; step < 30 && (await h.view()).account.state !== 'active'; step += 1) await vi.advanceTimersByTimeAsync(1000)

    const view = await h.view()
    expect(view.login.state).toBe('done')
    expect(view.account).toMatchObject({ state: 'active', mid: 3_000_001, uname: 'dsh-看客', level: 2 })

    const record = credentials.records.get(GRANT_KEY)
    expect(record?.kind).toBe('grant')
    const payload = (record as { payload: { mid: number; cookies: Record<string, string>; refreshToken: string } }).payload
    expect(payload.mid).toBe(3_000_001)
    expect(payload.refreshToken).toBe('refresh-token-1')
    expect(Object.keys(payload.cookies).sort()).toEqual(['DedeUserID', 'DedeUserID__ckMd5', 'SESSDATA', '_uuid', 'b_nut', 'bili_jct', 'buvid3', 'buvid4', 'buvid_fp', 'sid'])

    // Login endpoints get no cookies and never follow redirects.
    for (const path of ['/x/passport-login/web/qrcode/generate', '/x/passport-login/web/qrcode/poll']) {
      for (const request of fake.requestsTo(path)) {
        expect(request.headers['cookie']).toBeUndefined()
        expect(request.redirect).toBe('manual')
      }
    }
    // The view never carries a cookie or token value (DedeUserID is the public mid).
    const text = JSON.stringify(await h.view())
    // The mid and b_nut (the sign-in time in Unix seconds) are not secret; the view shows both.
    const { DedeUserID: _mid, b_nut: _signedIn, ...secret } = payload.cookies
    for (const value of [...Object.values(secret), payload.refreshToken]) expect(text).not.toContain(value)
    expect(h.logs.some(line => line.text === 'bili: signed in as dsh-看客 (3000001)')).toBe(true)
  })

  it('signs in as the international web version, which overseas accounts need', async () => {
    const h = await harness({ bili: fake, workspace: dir })
    await h.signIn()
    expect((await h.view()).account.state).toBe('active')
    for (const path of ['/x/passport-login/web/qrcode/generate', '/x/passport-login/web/qrcode/poll']) {
      for (const request of fake.requestsTo(path)) {
        expect(JSON.parse(request.query['x-bili-device-req-json']!)).toEqual({ platform: 'web', device: 'pc', spmid: '333.42', mobi_app: 'web_i' })
        expect(JSON.parse(request.query['x-bili-locale-json']!)).toEqual({ c_locale: { language: 'en' } })
        expect(request.query['source']).toBe('main-fe-header')
        expect(request.headers['referer']).toBe('https://www.bilibili.com/en/')
      }
    }
    expect(fake.requestsTo('/x/passport-login/web/qrcode/generate')[0]!.query['go_url']).toBe('https://www.bilibili.com/en/')
  })

  it('stops at a refusal from Bilibili and shows its message instead of polling on', async () => {
    fake.qrCodes = [86090, 0]
    const h = await harness({ bili: fake, workspace: dir })
    vi.spyOn(fake, 'overseasRefusal').mockReturnValue(true)
    await h.post({ action: 'login' })
    await vi.advanceTimersByTimeAsync(10_000)
    const polls = fake.requestsTo('/x/passport-login/web/qrcode/poll').length
    expect((await h.view()).login).toEqual({ state: 'failed', error: 'B站拒绝了这次登录：当前账号暂不支持在本APP登录（48007）' })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(fake.requestsTo('/x/passport-login/web/qrcode/poll')).toHaveLength(polls)
    expect(h.logs.filter(line => line.text.startsWith('bili: Bilibili refused the QR login: code 48007'))).toHaveLength(1)
  })

  it('reports an expired QR code and starts a fresh one on request', async () => {
    fake.qrCodes = [86101, 86038]
    const h = await harness({ bili: fake, workspace: dir })
    await h.post({ action: 'login' })
    await vi.advanceTimersByTimeAsync(8000)
    expect((await h.view()).login).toEqual({ state: 'expired' })
    fake.qrCodes = [0]
    await h.signIn()
    expect((await h.view()).account.state).toBe('active')
  })

  it('keeps the account across a re-mount', async () => {
    const credentials = credentialStore()
    const first = await harness({ bili: fake, credentials, workspace: dir })
    await first.signIn()
    await first.ctx.fiber.dispose()
    const second = await harness({ bili: fake, credentials, pool: first.pool, workspace: dir })
    expect((await second.view()).account).toMatchObject({ state: 'active', mid: 3_000_001 })
    expect(second.logs.some(line => line.text === 'bili: account dsh-看客 (3000001) is active')).toBe(true)
  })
})

describe('Settings route', () => {
  it('registers GET and POST at /api/bili, under the signed-in /api channel, and nothing else', async () => {
    const h = await harness({ bili: fake, workspace: dir })
    expect(h.routes.map(route => [route.path, route.methods, route.requestBody])).toEqual([['/api/bili', ['GET', 'POST'], 'buffered']])
    const response = await h.routes[0]!.fetch(new Request('http://127.0.0.1/api/bili'))
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('stores the interests text and refuses bad bodies', async () => {
    const h = await harness({ bili: fake, workspace: dir, config: { interests: '猫和纪录片' } })
    expect((await h.view()).interests).toEqual({ text: '猫和纪录片', updatedAt: null })
    const saved = await (await h.post({ action: 'interests', text: ' 天文、猫、老电影 ' })).json() as { interests: { text: string; updatedAt: number } }
    expect(saved.interests).toEqual({ text: '天文、猫、老电影', updatedAt: expect.any(Number) as unknown })
    expect((await h.post({ action: 'interests', text: 'x'.repeat(2001) })).status).toBe(400)
    expect((await h.post({ action: 'delete-everything' })).status).toBe(400)
    expect((await h.post('{', 'application/json')).status).toBe(400)
    expect((await h.post({ action: 'resume' }, 'text/plain')).status).toBe(415)
  })
})
