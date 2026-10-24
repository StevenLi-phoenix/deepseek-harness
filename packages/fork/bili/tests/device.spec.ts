/** The device enrollment a browser's first page makes: without it Bilibili answers likes with -403 账号异常. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buvidFp } from '../src/auth.ts'
import { USER_AGENT } from '../src/client.ts'
import { GRANT_KEY } from '../src/index.ts'
import { FakeBili } from './fake-bili.ts'
import { allLogs, contexts, credentialStore, harness } from './harness.ts'

let dir: string
let fake: FakeBili

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bili-device-'))
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

const ENROLL = '/x/internal/gaia-gateway/ExClimbWuzhi'

/** Whether a mount logged this exact line. */
function logged(h: { logs: Array<{ type: string; text: string }> }, type: string, text: string): boolean {
  return h.logs.some(line => line.type === type && line.text === text)
}

/** The stored jar. */
function cookiesOf(credentials: ReturnType<typeof credentialStore>): Record<string, string> {
  return (credentials.records.get(GRANT_KEY) as { payload: { cookies: Record<string, string> } }).payload.cookies
}

describe('device enrollment', () => {
  it('enrolls the device at sign-in with the browser ids, so a like goes through', async () => {
    const credentials = credentialStore()
    const h = await harness({ bili: fake, credentials, workspace: dir })
    await h.signIn()
    const cookies = cookiesOf(credentials)
    expect(cookies['_uuid']).toMatch(/^[0-9A-F]+(-[0-9A-F]+){4}\d{5}infoc$/)
    // b_nut is the sign-in time in Unix seconds.
    expect(Math.floor(Date.now() / 1000) - Number(cookies['b_nut'])).toBeLessThan(120)
    const [enroll, ...again] = fake.requestsTo(ENROLL)
    expect(again).toEqual([])
    expect(enroll!.headers['cookie']).toContain('buvid3=BUVID3-FAKE-infoc')
    expect(enroll!.headers['cookie']).toContain(`_uuid=${cookies['_uuid']}`)
    expect(enroll!.headers['cookie']).toContain(`b_nut=${cookies['b_nut']}`)
    expect(enroll!.headers['content-type']).toBe('application/json')
    const payload = JSON.parse((enroll!.json as { payload: string }).payload) as Record<string, unknown>
    expect(payload).toMatchObject({ '3064': 1, '39c8': '333.788.fp.risk', 'df35': cookies['_uuid'], '07a4': 'zh-CN', '3c43': { adca: 'MacIntel', b8ce: USER_AGENT, '07a4': 'zh-CN' } })
    expect((payload['3c43'] as { bfe9: string }).bfe9).toMatch(/^[A-Za-z0-9+/]{34}AAAAAElFTkSuQmCC$/)
    expect((payload['3c43'] as { '80c9': unknown[] })['80c9']).toHaveLength(5)
    // buvid_fp is the hash of this very body, and goes with it, as bilibili-api-python does it.
    expect(cookies['buvid_fp']).toBe(buvidFp(JSON.stringify(enroll!.json)))
    expect(enroll!.headers['cookie']).toContain(`buvid_fp=${cookies['buvid_fp']}`)
    expect(logged(h, 'info', 'bili: enrolled the device with Bilibili (sign-in)')).toBe(true)
    expect(await h.run(h.account.like('BV1aa4y1X7aa'))).toMatchObject({ outcome: 'sent' })
    // The like form bilibili-api-python sends: aid and bvid, with csrf and csrf_token.
    expect(fake.requestsTo('/x/web-interface/archive/like').at(-1)!.form).toMatchObject({ aid: '101', bvid: 'BV1aa4y1X7aa', like: '1', csrf: expect.any(String) as string, csrf_token: expect.any(String) as string })
  })

  it('derives buvid_fp with MurmurHash3 x64 128, seed 31, like the reference implementation', () => {
    // Vectors computed with bilibili-api-python 17.4.2's own murmur3_x64_128 and gen_buvid_fp.
    expect(buvidFp('hello')).toBe('e4c67dbb6870107c1129fe575d609dfb')
    expect(buvidFp('The quick brown fox jumps over the lazy dog')).toBe('be0b79c4b0742dc6f542fbba04a21a1')
    expect(buvidFp('{"payload":"{\\"3064\\":1}"}')).toBe('55423e6a3d365d003e90e0586528ab0c')
    expect(buvidFp('x'.repeat(31))).toBe('29d7d0f3738ab94825df912129529afe')
  })

  it('enrolls again, with the full report and buvid_fp, a device enrolled before buvid_fp existed', async () => {
    const credentials = credentialStore()
    const h = await harness({ bili: fake, credentials, workspace: dir })
    await h.signIn()
    const record = credentials.records.get(GRANT_KEY) as { payload: { cookies: Record<string, string> } }
    const uuid = record.payload.cookies['_uuid']
    delete record.payload.cookies['buvid_fp']
    await h.ctx.fiber.dispose()
    const again = await harness({ bili: fake, credentials, pool: h.pool, notes: h.notes, workspace: dir })
    await vi.advanceTimersByTimeAsync(70_000)
    expect(fake.requestsTo(ENROLL)).toHaveLength(2)
    // Same browser ids, a new fingerprint.
    expect(cookiesOf(credentials)['_uuid']).toBe(uuid)
    expect(cookiesOf(credentials)['buvid_fp']).toBe(buvidFp(JSON.stringify(fake.requestsTo(ENROLL).at(-1)!.json)))
    expect(logged(again, 'info', 'bili: enrolled the device with Bilibili (start)')).toBe(true)
  })

  it('logs a failed enrollment, and enrolls an account at the next start, once', async () => {
    const credentials = credentialStore()
    fake.reply(ENROLL, { body: { code: -500, message: '服务器错误' } })
    const h = await harness({ bili: fake, credentials, workspace: dir })
    await h.signIn()
    expect(logged(h, 'warn', 'bili: could not enroll the device (sign-in): exClimbWuzhi: code -500 (服务器错误); likes may be refused until it is enrolled at the next start')).toBe(true)
    // Bilibili refuses a device it has no profile of, in its own words.
    expect(await h.run(h.account.like('BV1aa4y1X7aa'))).toEqual({
      outcome: 'refused',
      detail: 'Bilibili\'s risk control stopped it (code -403: 账号异常,操作失败); public writes are paused (messages to the owner still go) until the owner resumes them',
    })
    await h.post({ action: 'resume' })

    // The next start enrolls the same ids once its session check is done; the start after that does not.
    await h.ctx.fiber.dispose()
    const again = await harness({ bili: fake, credentials, pool: h.pool, notes: h.notes, workspace: dir })
    await vi.advanceTimersByTimeAsync(70_000)
    expect(fake.requestsTo(ENROLL)).toHaveLength(2)
    expect(logged(again, 'info', 'bili: enrolled the device with Bilibili (start)')).toBe(true)
    expect(await again.run(again.account.like('BV1aa4y1X7aa'))).toMatchObject({ outcome: 'sent' })
    await again.ctx.fiber.dispose()
    await harness({ bili: fake, credentials, pool: h.pool, notes: h.notes, workspace: dir })
    await vi.advanceTimersByTimeAsync(70_000)
    expect(fake.requestsTo(ENROLL)).toHaveLength(2)
  })

  it('gives an account signed in before enrollment existed its browser ids at the start, keeping its buvid3', async () => {
    const credentials = credentialStore()
    const h = await harness({ bili: fake, credentials, workspace: dir })
    await h.signIn()
    // An older grant: no _uuid or b_nut.
    const record = credentials.records.get(GRANT_KEY) as { payload: { cookies: Record<string, string> } }
    delete record.payload.cookies['_uuid']
    delete record.payload.cookies['b_nut']
    await h.ctx.fiber.dispose()
    const again = await harness({ bili: fake, credentials, pool: h.pool, notes: h.notes, workspace: dir })
    await vi.advanceTimersByTimeAsync(70_000)
    const cookies = cookiesOf(credentials)
    expect(cookies['buvid3']).toBe('BUVID3-FAKE-infoc')
    expect(cookies['_uuid']).toMatch(/infoc$/)
    expect(fake.requestsTo(ENROLL)).toHaveLength(2)
    expect(fake.requestsTo(ENROLL).at(-1)!.headers['cookie']).toContain(`_uuid=${cookies['_uuid']}`)
    expect(logged(again, 'info', 'bili: enrolled the device with Bilibili (start)')).toBe(true)
  })
})
