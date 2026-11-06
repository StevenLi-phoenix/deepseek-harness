/** Pieces that run without the plugin around them: time zones, Settings actions, the management client, and the hot store. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HotStore } from '../src/hot.ts'
import { ManageClient, ManageError, type ManageHooks } from '../src/manage.ts'
import { ManageSettings, type SettingsHooks } from '../src/settings.ts'
import { dayKey, formatStamp, isTimeZone } from '../src/time.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('time zones', () => {
  it('keys the local day and stamps the wall clock in the zone asked for', () => {
    const ms = Date.UTC(2026, 9, 23, 3, 41)
    expect(dayKey(ms, 'America/New_York')).toBe('2026-10-22')
    expect(dayKey(ms, 'Asia/Shanghai')).toBe('2026-10-23')
    expect(formatStamp(ms, 'Asia/Shanghai')).toBe('Fri 2026-10-23 11:41')
  })

  it('knows a zone from a name the runtime refuses', () => {
    expect(isTimeZone('Asia/Shanghai')).toBe(true)
    expect(isTimeZone('Mars/Olympus')).toBe(false)
  })
})

/** A management client double; each method is a spy the test can answer. */
function manageDouble() {
  return {
    hasToken: vi.fn(() => Promise.resolve(true)),
    status: vi.fn(() => Promise.resolve({ accounts: [], gate: null })),
    ledger: vi.fn((_limit: number) => Promise.resolve({ rows: [], summary: {} })),
    setMode: vi.fn((mode: string) => Promise.resolve({ mode, brake: null })),
    releaseBrake: vi.fn(() => Promise.resolve({ released: true, mode: 'auto' })),
    loginStart: vi.fn((_id: string) => Promise.resolve({ key: 'k', url: 'https://example.invalid/qr', expiresAt: 10_000 })),
    loginPoll: vi.fn((_id: string, _key: string) => Promise.resolve({ state: 'waiting' as const, message: null })),
    refresh: vi.fn((_id: string) => Promise.resolve({ refreshed: true })),
    check: vi.fn((_id: string) => Promise.resolve({ outcome: 'valid' as const, days: 12 })),
    logout: vi.fn((_id: string) => Promise.resolve()),
  }
}

function settingsOver(manage: ReturnType<typeof manageDouble>) {
  const lines: string[] = []
  let clock = 1000
  const hooks: SettingsHooks = {
    manage: manage as never,
    info: (message) => { lines.push(`info ${message}`) },
    warn: (message) => { lines.push(`warn ${message}`) },
    now: () => clock,
  }
  return { settings: new ManageSettings(hooks), lines, tick: (ms: number) => { clock += ms } }
}

describe('ManageSettings', () => {
  it('reads the status with the ledger, and keeps the status when the ledger fails with a non-Error value', async () => {
    const manage = manageDouble()
    const { settings, lines } = settingsOver(manage)
    expect(await settings.hasToken()).toBe(true)
    expect(await settings.read(5)).toEqual({ status: { accounts: [], gate: null }, ledger: { rows: [], summary: {} } })
    expect(manage.ledger).toHaveBeenCalledWith(5, undefined)
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error arm is the case under test.
    manage.ledger.mockImplementationOnce(() => Promise.reject('ledger offline'))
    expect(await settings.read()).toEqual({ status: { accounts: [], gate: null }, ledger: null })
    expect(lines).toContain('warn bili: manage ledger not read: ledger offline')
  })

  it('answers the mode bili-svc reports, or the mode asked for when it reports none', async () => {
    const manage = manageDouble()
    const { settings } = settingsOver(manage)
    expect((await settings.run({ action: 'gate.mode', mode: 'readonly' })).outcome).toBe('readonly')
    manage.setMode.mockResolvedValueOnce({ mode: '', brake: null })
    expect((await settings.run({ action: 'gate.mode', mode: 'auto' })).outcome).toBe('auto')
  })

  it('answers none for a brake that was not set, and unchanged for a session that did not renew', async () => {
    const manage = manageDouble()
    const { settings } = settingsOver(manage)
    expect((await settings.run({ action: 'brake.release' })).outcome).toBe('released')
    manage.releaseBrake.mockResolvedValueOnce({ released: false, mode: 'auto' })
    expect((await settings.run({ action: 'brake.release' })).outcome).toBe('none')
    expect((await settings.run({ action: 'session.refresh', account: 'maomao' }))).toEqual({ action: 'session.refresh', account: 'maomao', outcome: 'refreshed', days: null })
    manage.refresh.mockResolvedValueOnce({ refreshed: false })
    expect((await settings.run({ action: 'session.refresh', account: 'maomao' })).outcome).toBe('unchanged')
  })

  it('logs a failure that is not a ManageError as code error and rethrows it', async () => {
    const manage = manageDouble()
    const { settings, lines, tick } = settingsOver(manage)
    manage.check.mockImplementationOnce(() => { tick(7); return Promise.reject(new Error('boom')) })
    await expect(settings.run({ action: 'session.check', account: 'maomao' })).rejects.toThrow('boom')
    expect(lines).toContain('warn bili: manage session.check account=maomao failed: error (7 ms)')
    manage.releaseBrake.mockRejectedValueOnce(new ManageError('brake/release', 502, 'bad_answer', ''))
    await expect(settings.run({ action: 'brake.release' })).rejects.toBeInstanceOf(ManageError)
    expect(lines).toContain('warn bili: manage brake.release failed: bad_answer (0 ms)')
  })

  it('runs a ledger action as ok without calling bili-svc', async () => {
    const manage = manageDouble()
    const { settings } = settingsOver(manage)
    expect((await settings.run({ action: 'ledger', limit: 5 })).outcome).toBe('ok')
    expect(manage.ledger).not.toHaveBeenCalled()
  })

  it('follows a QR sign-in through waiting, scanned, and a finished state that is shown for eight seconds, then dropped', async () => {
    const manage = manageDouble()
    const { settings, tick } = settingsOver(manage)
    expect((await settings.run({ action: 'login.start', account: 'maomao' })).outcome).toBe('started')
    expect(settings.logins()).toMatchObject([{ account: 'maomao', state: 'waiting' }])
    manage.loginPoll.mockResolvedValueOnce({ state: 'scanned', message: null } as never)
    expect((await settings.run({ action: 'login.poll', account: 'maomao' })).outcome).toBe('scanned')
    manage.loginPoll.mockResolvedValueOnce({ state: 'done', message: '登录成功' } as never)
    expect((await settings.run({ action: 'login.poll', account: 'maomao' })).outcome).toBe('done')
    expect(settings.logins()).toMatchObject([{ account: 'maomao', state: 'done', qr: null, message: '登录成功' }])
    // A finished attempt answers its state without asking bili-svc again.
    expect((await settings.run({ action: 'login.poll', account: 'maomao' })).outcome).toBe('done')
    expect(manage.loginPoll).toHaveBeenCalledTimes(2)
    tick(8001)
    expect(settings.logins()).toEqual([])
    await expect(settings.run({ action: 'login.poll', account: 'maomao' })).rejects.toMatchObject({ code: 'no_login', status: 409 })
  })

  it('expires a sign-in locally after the code\'s lifetime, cancels one, and drops one at logout', async () => {
    const manage = manageDouble()
    const { settings, tick } = settingsOver(manage)
    await settings.run({ action: 'login.start', account: 'maomao' })
    tick(10_000)
    expect(settings.logins()).toMatchObject([{ account: 'maomao', state: 'expired', qr: null }])
    await settings.run({ action: 'login.start', account: 'maodeng' })
    expect((await settings.run({ action: 'login.cancel', account: 'maodeng' })).outcome).toBe('cancelled')
    await settings.run({ action: 'login.start', account: 'maodeng' })
    expect((await settings.run({ action: 'logout', account: 'maodeng', confirm: 'maodeng' })).outcome).toBe('logged-out')
    expect(manage.logout).toHaveBeenCalledWith('maodeng', undefined)
    expect(settings.logins().map(login => login.account)).toEqual(['maomao'])
  })
})

/** A management client over a stubbed fetch answering `answer`. */
function clientOver(answer: (url: string, init: RequestInit) => Promise<Response>, token: string | null = 'manage-token') {
  const debug: string[] = []
  const fetchStub = vi.fn(answer)
  vi.stubGlobal('fetch', fetchStub)
  const hooks: ManageHooks = { baseUrl: 'http://svc.test', token: () => Promise.resolve(token ?? undefined), debug: (message) => { debug.push(message) } }
  return { client: new ManageClient(hooks), debug, fetchStub }
}

const json = (body: unknown, status = 200): Promise<Response> => Promise.resolve(new Response(JSON.stringify(body), { status }))

describe('ManageClient', () => {
  it('has a token only when the credential holds a non-empty value', async () => {
    expect(await clientOver(() => json({}), 'x').client.hasToken()).toBe(true)
    expect(await clientOver(() => json({}), '').client.hasToken()).toBe(false)
    expect(await clientOver(() => json({}), null).client.hasToken()).toBe(false)
  })

  it('refuses every request without a token before any fetch', async () => {
    const { client, fetchStub } = clientOver(() => json({}), null)
    await expect(client.status()).rejects.toMatchObject({ code: 'no_token', status: 0, route: 'status' })
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('reads a QR start whose key, URL, or expiry is missing as bad_answer, and a non-string field as missing', async () => {
    for (const body of [{}, { key: 'k', url: 'u' }, { key: 'k', expires_at: 1_790_000_000 }, { key: 7, url: 'u', expires_at: 1_790_000_000 }]) {
      const { client } = clientOver(() => json(body))
      await expect(client.loginStart('maomao')).rejects.toMatchObject({ code: 'bad_answer', status: 502, detail: 'bili-svc answered no QR code' })
    }
    const { client } = clientOver(() => json({ key: 'k', url: 'u', expires_at: 1_790_000_000 }))
    expect(await client.loginStart('maomao')).toEqual({ key: 'k', url: 'u', expiresAt: 1_790_000_000_000 })
  })

  it('refuses a QR state it does not know and passes the words of one it does', async () => {
    const { client } = clientOver(() => json({ state: 'teleported' }))
    await expect(client.loginPoll('maomao', 'k')).rejects.toMatchObject({ code: 'bad_answer', detail: 'bili-svc answered an unknown QR state' })
    const known = clientOver(() => json({ state: 'failed', message: '二维码已失效' }))
    expect(await known.client.loginPoll('maomao', 'k')).toEqual({ state: 'failed', message: '二维码已失效' })
    const quiet = clientOver(() => json({ state: 'scanned' }))
    expect(await quiet.client.loginPoll('maomao', 'k')).toEqual({ state: 'scanned', message: null })
  })

  it('reports a session as invalid only when Bilibili says it is not logged in, with the days left when known', async () => {
    expect(await clientOver(() => json({ isLogin: false })).client.check('maomao')).toEqual({ outcome: 'invalid', days: null })
    expect(await clientOver(() => json({ isLogin: true, expires_in_days: 12 })).client.check('maomao')).toEqual({ outcome: 'valid', days: 12 })
  })

  it('refuses an answer that is too large, and one that is not JSON, keeping the HTTP status of a refusal', async () => {
    const large = clientOver(() => Promise.resolve(new Response('x'.repeat(4 * 1024 * 1024 + 1))))
    await expect(large.client.status()).rejects.toMatchObject({ code: 'bad_answer', status: 502, detail: 'bili-svc answer too large' })
    const html = clientOver(() => Promise.resolve(new Response('<html>', { status: 200 })))
    await expect(html.client.status()).rejects.toMatchObject({ code: 'bad_answer', status: 502, detail: 'bili-svc answer is not JSON (HTTP 200)' })
    const refused = clientOver(() => Promise.resolve(new Response('<html>', { status: 403 })))
    await expect(refused.client.status()).rejects.toMatchObject({ code: 'bad_answer', status: 403, detail: 'bili-svc answer is not JSON (HTTP 403)' })
  })

  it('names bili-svc\'s error code and message for a refusal, or the HTTP status when it names none, and treats an empty body as an empty answer', async () => {
    const named = clientOver(() => json({ error: 'mode_refused', message: 'a brake is active' }, 409))
    await expect(named.client.setMode('auto')).rejects.toMatchObject({ code: 'mode_refused', status: 409, detail: 'a brake is active' })
    const bare = clientOver(() => json({}, 500))
    await expect(bare.client.status()).rejects.toMatchObject({ code: 'http_500', detail: '' })
    const empty = clientOver(() => Promise.resolve(new Response('', { status: 200 })))
    expect(await empty.client.status()).toEqual({ accounts: [], gate: null })
    expect(empty.debug).toEqual([expect.stringContaining('manage status → bili-svc HTTP 200')])
  })

  it('answers a transport failure with the error name, and a silent bili-svc with the deadline after 30 seconds', async () => {
    const down = clientOver(() => Promise.reject(new TypeError('fetch failed')))
    await expect(down.client.status()).rejects.toMatchObject({ code: 'transport', detail: 'bili-svc is unreachable (TypeError)' })
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error arm is the case under test.
    const odd = clientOver(() => Promise.reject('refused'))
    await expect(odd.client.status()).rejects.toMatchObject({ code: 'transport', detail: 'bili-svc is unreachable (unknown)' })
    vi.useFakeTimers()
    const silent = clientOver((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
    }))
    const pending = silent.client.status()
    const settled = expect(pending).rejects.toMatchObject({ code: 'transport', detail: 'no answer from bili-svc within 30000 ms' })
    await vi.advanceTimersByTimeAsync(30_000)
    await settled
  })

  it('stops with the caller\'s own abort instead of reporting a transport failure', async () => {
    const controller = new AbortController()
    const aborted = clientOver((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new Error('caller stopped')) })
    }))
    const pending = aborted.client.status(controller.signal)
    const settled = expect(pending).rejects.toThrow()
    controller.abort(new Error('caller stopped'))
    await settled
    const before = clientOver(() => json({}))
    await expect(before.client.status(controller.signal)).rejects.toThrow('caller stopped')
    expect(before.fetchStub).not.toHaveBeenCalled()
  })

  it('keeps at most 24 ledger summary counters', async () => {
    const summary = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`k${index}`, index]))
    const { client } = clientOver(() => json({ ledger: [], summary }))
    expect(Object.keys((await client.ledger(5)).summary)).toHaveLength(24)
  })
})

/** The hot store over a domain promise that rejects. */
function brokenStore(reason: unknown) {
  // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the reason is whatever the case under test throws.
  const ready = Promise.reject(reason)
  ready.catch(() => undefined)
  const lines: string[] = []
  const store = new HotStore({
    ready,
    now: () => 1_790_000_000_000,
    logger: { info: (message) => { lines.push(`info ${message}`) }, warn: (message) => { lines.push(`warn ${message}`) } },
  })
  return { store, lines }
}

describe('HotStore over a failing domain', () => {
  it('logs a failed write of comments and of words, whatever was thrown, and keeps serving later calls', async () => {
    const error = brokenStore(new Error('disk full'))
    await error.store.noteComments('BV1aa4y1X7aa', [{ rpid: '1', author: '', text: '红石好看', likes: 50 }])
    await error.store.noteWords([{ keyword: '鱼灾' }])
    expect(error.lines).toEqual(['warn bili: hot comments not kept: disk full', 'warn bili: hot words not kept: disk full'])
    await expect(error.store.words()).rejects.toThrow('disk full')

    const plain = brokenStore('plain reason')
    await plain.store.noteComments('BV1aa4y1X7aa', [{ rpid: '1', author: '', text: '红石好看', likes: 50 }])
    await plain.store.noteWords([{ keyword: '鱼灾' }])
    expect(plain.lines).toEqual(['warn bili: hot comments not kept: plain reason', 'warn bili: hot words not kept: plain reason'])
  })

  it('does not touch the store for comments without likes or words that are blank or name someone', async () => {
    const { store, lines } = brokenStore(new Error('must not be asked'))
    await store.noteComments('BV1aa4y1X7aa', [{ rpid: '1', author: '', text: '红石好看' }])
    await store.noteWords([{ keyword: ' ' }, { keyword: '找@某人' }, { keyword: '', label: '' }])
    expect(lines).toEqual([])
  })
})
