import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { accountFilePath, loginWithQr, LoginError, readAccountFile, runLoginCli, writeAccountFile, type LoginOptions, type WechatAccount } from '../src/login.ts'
import { FakeIlink } from './fake-ilink.ts'

const CONFIRMED = { status: 'confirmed', bot_token: 'tok-secret', ilink_bot_id: 'bot@im.bot', baseurl: 'https://idc.ilinkai.weixin.qq.com', ilink_user_id: 'owner@im.wechat' }

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lsy-wechat-login-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** Login options against the double with no pauses; records what the user saw. */
function options(ilink: FakeIlink, overrides: Partial<LoginOptions> = {}) {
  const shown: Array<[string, number]> = []
  const progress: string[] = []
  const codes = ['1234', '5678']
  const asked: boolean[] = []
  const opts: LoginOptions = {
    fetch: ilink.fetch,
    baseUrl: 'https://ilink.test',
    pollDelayMs: 0,
    showQrCode: (url, attempt) => { shown.push([url, attempt]) },
    readVerifyCode: async (retry) => {
      asked.push(retry)
      return ` ${codes.shift() ?? '0'} `
    },
    onProgress: (message) => { progress.push(message) },
    ...overrides,
  }
  return { opts, shown, progress, asked }
}

describe('loginWithQr', () => {
  it('shows the QR code, reports the scan once, and returns the confirmed credentials', async () => {
    const ilink = new FakeIlink()
    ilink.statuses({ status: 'wait' }, { status: 'scaned' }, { status: 'scaned' }, { status: 'something-new' }, CONFIRMED)
    const { opts, shown, progress } = options(ilink)
    expect(await loginWithQr(opts)).toEqual({ botToken: 'tok-secret', botId: 'bot@im.bot', baseUrl: 'https://idc.ilinkai.weixin.qq.com', ownerUserId: 'owner@im.wechat' })
    expect(shown).toEqual([['https://liteapp.weixin.qq.com/q/1?qrcode=qr-1&bot_type=3', 1]])
    expect(progress).toEqual(['已扫码，请在手机微信上确认。'])
    expect(ilink.requestsTo('ilink/bot/get_qrcode_status').map(request => request.query['qrcode'])).toEqual(['qr-1', 'qr-1', 'qr-1', 'qr-1', 'qr-1'])
  })

  it('follows a WeChat host redirect and ignores a malformed or foreign one', async () => {
    const ilink = new FakeIlink()
    ilink.statuses(
      { status: 'scaned_but_redirect', redirect_host: 'bad host/path' },
      { status: 'scaned_but_redirect', redirect_host: 'evil.example' },
      { status: 'scaned_but_redirect', redirect_host: 'weixin.qq.com.evil.example' },
      { status: 'scaned_but_redirect' },
      { status: 'scaned_but_redirect', redirect_host: 'idc2.weixin.qq.com' },
      CONFIRMED,
    )
    const { opts, progress } = options(ilink)
    await loginWithQr(opts)
    expect(ilink.requestsTo('ilink/bot/get_qrcode_status').map(request => request.origin)).toEqual([
      'https://ilink.test', 'https://ilink.test', 'https://ilink.test', 'https://ilink.test', 'https://ilink.test', 'https://idc2.weixin.qq.com',
    ])
    expect(progress).toEqual(['已扫码，切换到 idc2.weixin.qq.com 继续确认。'])
  })

  it('refuses a base URL outside WeChat or without HTTPS', async () => {
    for (const baseurl of ['https://evil.example', 'http://ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com:8443', 'https://weixin.qq.com.evil.example']) {
      const ilink = new FakeIlink()
      ilink.statuses({ ...CONFIRMED, baseurl })
      await expect(loginWithQr(options(ilink).opts)).rejects.toThrow('untrusted base URL')
    }
  })

  it('asks for the verification number, retries after a wrong one, and drops it once scanned', async () => {
    const ilink = new FakeIlink()
    ilink.statuses({ status: 'need_verifycode' }, { status: 'need_verifycode' }, { status: 'scaned' }, CONFIRMED)
    const { opts, asked } = options(ilink)
    await loginWithQr(opts)
    expect(asked).toEqual([false, true])
    expect(ilink.requestsTo('ilink/bot/get_qrcode_status').map(request => request.query['verify_code'])).toEqual([undefined, '1234', '5678', undefined])
  })

  it('refreshes an expired QR code and gives up after three', async () => {
    const ilink = new FakeIlink()
    ilink.statuses({ status: 'expired' }, { status: 'scaned' }, { status: 'expired' }, { status: 'expired' })
    const { opts, shown, progress } = options(ilink)
    await expect(loginWithQr(opts)).rejects.toThrow(new LoginError('the QR code expired 3 times; run the login again'))
    expect(shown.map(([, attempt]) => attempt)).toEqual([1, 2, 3])
    expect(progress).toEqual(['二维码已过期，已刷新。', '已扫码，请在手机微信上确认。', '二维码已过期，已刷新。'])
    expect(ilink.requestsTo('ilink/bot/get_qrcode_status').map(request => request.query['qrcode'])).toEqual(['qr-1', 'qr-2', 'qr-2', 'qr-3'])
  })

  it('refreshes after a blocked verification and gives up at the limit', async () => {
    const ilink = new FakeIlink()
    ilink.statuses({ status: 'verify_code_blocked' }, { status: 'verify_code_blocked' })
    const { opts, progress } = options(ilink, { maxQrCodes: 2 })
    await expect(loginWithQr(opts)).rejects.toThrow('too many wrong verification numbers')
    expect(progress).toEqual(['验证数字错误次数过多，已换新二维码。'])
  })

  it('fails clearly when the bot is already bound elsewhere', async () => {
    const ilink = new FakeIlink()
    ilink.statuses({ status: 'binded_redirect' })
    await expect(loginWithQr(options(ilink).opts)).rejects.toThrow('already has the bot bound to another client')
  })

  it('rejects a confirmation without credentials', async () => {
    const ilink = new FakeIlink()
    ilink.statuses({ status: 'confirmed', bot_token: 'tok' })
    await expect(loginWithQr(options(ilink).opts)).rejects.toThrow('returned no bot credentials')
  })

  it('falls back to the login origin and adds a missing scheme to the base URL', async () => {
    const ilink = new FakeIlink()
    ilink.statuses({ ...CONFIRMED, baseurl: '' }, { ...CONFIRMED, baseurl: 'idc3.wechat.com' })
    expect((await loginWithQr(options(ilink).opts)).baseUrl).toBe('https://ilink.test')
    expect((await loginWithQr(options(ilink).opts)).baseUrl).toBe('https://idc3.wechat.com')
  })

  it('retries failed status polls and gives up after maxFailures in a row', async () => {
    const ilink = new FakeIlink()
    const down = new TypeError('fetch failed')
    ilink.reply('ilink/bot/get_qrcode_status', down, { body: { status: 'wait' } }, down, down, down)
    await expect(loginWithQr(options(ilink, { maxFailures: 3 }).opts)).rejects.toThrow('checking the QR code failed 3 times in a row: iLink ilink/bot/get_qrcode_status: request failed: fetch failed')
    expect(ilink.requestsTo('ilink/bot/get_qrcode_status')).toHaveLength(5)
  })

  it('times out when nobody scans', async () => {
    vi.useFakeTimers()
    const ilink = new FakeIlink()
    const { opts } = options(ilink, { timeoutMs: 5000, pollDelayMs: 1000, statusTimeoutMs: 1000 })
    const settled = loginWithQr(opts).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(6000)
    expect(await settled).toMatchObject({ name: 'LoginError', message: 'timed out waiting for the QR code to be scanned and confirmed' })
  })

  it('stops on abort while polling and while pausing', async () => {
    vi.useFakeTimers()
    const ilink = new FakeIlink()
    const polling = new AbortController()
    const first = loginWithQr(options(ilink, { signal: polling.signal }).opts).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10)
    polling.abort(new Error('cancelled while polling'))
    expect(await first).toMatchObject({ message: 'cancelled while polling' })

    const pausing = new AbortController()
    ilink.statuses({ status: 'wait' })
    const second = loginWithQr(options(ilink, { signal: pausing.signal, pollDelayMs: 60_000 }).opts).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10)
    pausing.abort(new Error('cancelled while pausing'))
    expect(await second).toMatchObject({ message: 'cancelled while pausing' })
  })

  it('uses the public origin and global fetch by default', async () => {
    const ilink = new FakeIlink()
    vi.stubGlobal('fetch', ilink.fetch)
    ilink.statuses(CONFIRMED)
    await loginWithQr({ showQrCode: () => {}, readVerifyCode: async () => '' })
    expect(ilink.requests.map(request => request.origin)).toEqual(['https://ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com'])
  })
})

describe('account file', () => {
  const account: WechatAccount = { botToken: 'tok-secret', botId: 'bot@im.bot', baseUrl: 'https://idc.ilink.test', ownerUserId: 'owner@im.wechat', boundAt: '2026-10-21T00:00:00.000Z' }

  it('defaults to <DSH_HOME>/lsy-wechat/account.json', () => {
    expect(accountFilePath({ DSH_HOME: '/srv/dsh' })).toBe('/srv/dsh/lsy-wechat/account.json')
    expect(accountFilePath({})).toMatch(/\.dsh\/lsy-wechat\/account\.json$/)
    vi.stubEnv('DSH_HOME', '/env/dsh')
    expect(accountFilePath()).toBe('/env/dsh/lsy-wechat/account.json')
  })

  it('writes atomically with mode 0600 inside a 0700 directory', async () => {
    const path = join(dir, 'lsy-wechat', 'account.json')
    mkdirSync(join(dir, 'lsy-wechat'), { mode: 0o755 })
    await writeAccountFile(path, account)
    await writeAccountFile(path, { ...account, botId: 'bot2@im.bot' })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ ...account, botId: 'bot2@im.bot' })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'lsy-wechat')).mode & 0o777).toBe(0o700)
    expect(readdirSync(join(dir, 'lsy-wechat'))).toEqual(['account.json'])
    expect(readAccountFile(path)).toEqual({ kind: 'ok', account: { ...account, botId: 'bot2@im.bot' } })
  })

  it('removes the temporary file when the final rename fails', async () => {
    const path = join(dir, 'account.json')
    mkdirSync(join(path, 'occupied'), { recursive: true })
    await expect(writeAccountFile(path, account)).rejects.toThrow()
    expect(readdirSync(dir)).toEqual(['account.json'])
  })

  it('reports missing, unreadable, malformed, and incomplete files without quoting them', () => {
    const path = join(dir, 'account.json')
    expect(readAccountFile(path)).toEqual({ kind: 'missing' })
    writeFileSync(path, '{"botToken": "tok-secret", oops')
    const malformed = readAccountFile(path)
    expect(malformed).toEqual({ kind: 'invalid', reason: 'not valid JSON' })
    writeFileSync(path, JSON.stringify({ botToken: 'tok-secret', botId: 'b', baseUrl: 'not a url', ownerUserId: '' }))
    expect(readAccountFile(path)).toEqual({ kind: 'invalid', reason: 'bad fields: baseUrl, ownerUserId, boundAt' })
    writeFileSync(path, '"tok-secret"')
    expect(readAccountFile(path)).toEqual({ kind: 'invalid', reason: 'bad fields: (root)' })
    expect(readAccountFile(dir)).toEqual({ kind: 'invalid', reason: 'cannot read (EISDIR)' })
  })
})

describe('runLoginCli', () => {
  /** Captures one stream's writes. */
  function sink() {
    const chunks: string[] = []
    return { chunks, text: () => chunks.join(''), write: (chunk: string) => { chunks.push(chunk) } }
  }

  it('renders the QR code, reads the verification number, and saves the account without printing the token', async () => {
    const ilink = new FakeIlink()
    ilink.statuses({ status: 'need_verifycode' }, { status: 'expired' }, CONFIRMED)
    const stdout = sink()
    const stderr = sink()
    const stdin = new PassThrough()
    stdin.end('2468\n')
    const code = await runLoginCli({ stdout, stderr, stdin, env: { DSH_HOME: dir }, login: { fetch: ilink.fetch, baseUrl: 'https://ilink.test', pollDelayMs: 0 } })
    expect(code).toBe(0)
    const out = stdout.text()
    expect(out).toContain('https://liteapp.weixin.qq.com/q/1?qrcode=qr-1&bot_type=3')
    expect(out).toContain('（第 2 张）')
    expect(out).toMatch(/[▀▄█]/)
    expect(out).toContain('输入手机微信上显示的数字：')
    expect(out).toContain('已绑定 bot bot@im.bot，owner owner@im.wechat。')
    expect(out).not.toContain('tok-secret')
    expect(stderr.text()).toBe('')
    expect(ilink.requestsTo('ilink/bot/get_qrcode_status')[1]!.query['verify_code']).toBe('2468')
    const saved = readAccountFile(join(dir, 'lsy-wechat', 'account.json'))
    expect(saved).toMatchObject({ kind: 'ok', account: { botToken: 'tok-secret', botId: 'bot@im.bot', ownerUserId: 'owner@im.wechat' } })
  })

  it('prompts again after a wrong number and fails when input ends', async () => {
    const ilink = new FakeIlink()
    ilink.statuses({ status: 'need_verifycode' }, { status: 'need_verifycode' })
    const stdout = sink()
    const stderr = sink()
    const stdin = new PassThrough()
    stdin.end('1111\n')
    const path = join(dir, 'account.json')
    const code = await runLoginCli({ stdout, stderr, stdin, accountFile: path, login: { fetch: ilink.fetch, pollDelayMs: 0 } })
    expect(code).toBe(1)
    expect(stdout.text()).toContain('数字不匹配，请重新输入手机微信上显示的数字：')
    expect(stderr.text()).toBe('\n微信登录失败：input ended before the verification number was entered\n')
    expect(readAccountFile(path)).toEqual({ kind: 'missing' })
  })

  it('reports a cancelled login', async () => {
    const stderr = sink()
    const controller = new AbortController()
    controller.abort('cancelled by the operator')
    const code = await runLoginCli({ stdout: sink(), stderr, accountFile: join(dir, 'account.json'), login: { fetch: new FakeIlink().fetch, signal: controller.signal } })
    expect(code).toBe(1)
    expect(stderr.text()).toBe('\n微信登录失败：cancelled by the operator\n')
  })

  it('defaults to the process streams and DSH_HOME', async () => {
    const ilink = new FakeIlink()
    vi.stubGlobal('fetch', ilink.fetch)
    vi.stubEnv('DSH_HOME', dir)
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    ilink.statuses(CONFIRMED)
    expect(await runLoginCli()).toBe(0)
    expect(stdout).toHaveBeenCalled()
    expect(readAccountFile(join(dir, 'lsy-wechat', 'account.json')).kind).toBe('ok')
    ilink.statuses({ status: 'binded_redirect' })
    expect(await runLoginCli()).toBe(1)
    expect(String(stderr.mock.calls.at(-1)?.[0])).toContain('already has the bot bound')
  })
})
