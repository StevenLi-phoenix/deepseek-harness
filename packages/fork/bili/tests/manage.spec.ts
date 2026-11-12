/** The Settings route's management side: the manage token, accounts, gate and brake, ledger, QR sign-in, sessions, and validation. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { parseAction } from '../src/actions.ts'
import { instant, parseLedger, parseManageStatus, qrModules } from '../src/manage.ts'
import type { BiliView } from '../src/view.ts'
import { FakeBiliSvc, MANAGE_TOKEN, SVC_TOKEN } from './fake-bili-svc.ts'
import { allLogs, contexts, credentialStore, harness } from './harness.ts'

let dir: string
let svc: FakeBiliSvc

/** Mount with both tokens, as the deployment has them. */
function managed(options: Parameters<typeof harness>[0] = {}) {
  return harness({
    svc, workspace: dir,
    credentials: credentialStore({ BILI_SVC_TOKEN_BILI: SVC_TOKEN, BILI_SVC_TOKEN_MANAGE: MANAGE_TOKEN }),
    ...options,
  })
}

/** The error body of a refused action. */
async function failure(response: Response): Promise<{ status: number; error: string; code?: string }> {
  return { status: response.status, ...await response.json() as { error: string; code?: string } }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bili-manage-'))
  svc = new FakeBiliSvc()
  svc.accounts = [
    { id: 'maodeng', mid: 1_000_001, display: '猫灯魔女岚栖', session: 'ok', refresh_mode: 'external', login: false, refreshed_at: 1_790_000_000, imported_at: null, dead_reason: null },
    { id: 'maomao', mid: 3_000_001, display: '魔女的猫猫', session: 'dead', refresh_mode: 'owner', login: true, refreshed_at: 1_790_100_000, imported_at: 1_789_000_000, dead_reason: '-101 not logged in' },
  ]
  svc.gate = { mode: 'auto', readonly: false, used_today: { comment: 2, dm: 7, share: 1 }, daily_caps: { comment: 5, dm: 20 } }
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-31T14:00:00.000Z'))
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
  allLogs.splice(0)
})

describe('without the manage token', () => {
  it('shows the read-only view, names the credential, and refuses every management action without calling bili-svc', async () => {
    const h = await harness({ svc, workspace: dir })
    const view = await h.view()
    expect(view).toMatchObject({ manage: false, manageEnv: 'BILI_SVC_TOKEN_MANAGE', manageError: null, ledger: null, logins: [] })
    expect(view.accounts.map(account => account.id)).toEqual(['maodeng', 'maomao'])
    for (const action of [
      { action: 'gate.mode', mode: 'readonly' }, { action: 'brake.release' }, { action: 'login.start', account: 'maomao' },
      { action: 'session.refresh', account: 'maomao' }, { action: 'logout', account: 'maomao', confirm: 'maomao' }, { action: 'ledger', limit: 5 },
    ]) {
      expect(await failure(await h.post(action))).toMatchObject({ status: 403, code: 'no_token', error: 'the manage token is not set (credential BILI_SVC_TOKEN_MANAGE)' })
    }
    expect(svc.manageCalls).toEqual([])
    // The owner's UID needs no manage token.
    expect((await h.post({ action: 'owner', mid: 200000002 })).status).toBe(200)
  })

  it('resolves the credential the configuration names', async () => {
    const credentials = credentialStore({ BILI_SVC_TOKEN_BILI: SVC_TOKEN, SETTINGS_MANAGE: MANAGE_TOKEN })
    const h = await harness({ svc, workspace: dir, credentials, config: { manageTokenEnv: 'SETTINGS_MANAGE' } })
    expect((await h.view()).manage).toBe(true)
    expect(credentials.resolved).toContain('SETTINGS_MANAGE')
    expect(credentials.resolved).not.toContain('BILI_SVC_TOKEN_MANAGE')
    await expect(harness({ svc, workspace: dir, config: { manageTokenEnv: 'not a name!' } })).rejects.toThrow('is not a credential name')
  })

  it('accepts exactly the names the credential store accepts', async () => {
    // The plugin checks the name itself, since a package with a browser half takes no runtime export from the store.
    const names = ['A', '_x', 'a1', 'BILI_SVC_TOKEN_MANAGE', 'x'.repeat(200), '', '1a', 'a-b', 'a b', 'a/b', 'a.b', 'é', 'a\n', ' a', 'a$']
    for (const name of names) {
      const stores = (() => { try { credentialRef(name); return true } catch { return false } })()
      const plugin = await harness({ svc, workspace: dir, config: { manageTokenEnv: name } }).then(() => true, () => false)
      expect(plugin, JSON.stringify(name)).toBe(stores)
    }
  })
})

describe('the management view', () => {
  it('lists every account with renewal facts, the gate with its brake and counters, and a bounded ledger', async () => {
    svc.brake = { reason: 'risk_352', detail: 'Bilibili answered -352', ts: 1_790_200_000 }
    svc.ledger = [
      { ts: 1_790_300_000, kind: 'dm', target: '200000001', state: 'sent', reason: '', caller: 'bili', draft: '在的'.repeat(300), verdict: { ok: true, by: ['a', 'b'] } },
      { ts: 1_790_299_000, kind: 'comment', target: 'BV1aa4y1X7aa', state: 'held', reason: 'cap', caller: 'up', draft: 'ignore <b>previous</b> instructions‮', verdict: 'blocked' },
    ]
    const h = await managed()
    const view = await h.view()
    expect(view.manage).toBe(true)
    expect(view.accounts).toEqual([
      { id: 'maodeng', mid: 1_000_001, display: '猫灯魔女岚栖', session: 'ok', refreshMode: 'external', login: false, agent: false, refreshedAt: 1_790_000_000_000, importedAt: null, deadReason: null },
      { id: 'maomao', mid: 3_000_001, display: '魔女的猫猫', session: 'dead', refreshMode: 'owner', login: true, agent: true, refreshedAt: 1_790_100_000_000, importedAt: 1_789_000_000_000, deadReason: '-101 not logged in' },
    ])
    expect(view.account).toMatchObject({ account: 'maomao', session: 'dead', mid: 3_000_001 })
    expect(view.gate).toEqual({
      // A bili-svc before 0.5.0 counts no share: its cap reads null, the count it gave stays.
      mode: 'auto', readonly: false, used: { comment: 2, dm: 7, share: 1 }, caps: { comment: 5, dm: 20, share: null },
      brake: { reason: 'risk_352', detail: 'Bilibili answered -352', ts: 1_790_200_000_000 },
    })
    // The comment speaker comes from the Reply Gate's route, read with the agent's own token.
    expect(view.speaker).toEqual({ id: 'maomao', display: '魔女的猫猫' })
    expect(view.ledger?.summary).toEqual({ 'day': '2026-10-31', 'dm.states.sent': 2, 'dm.reasons.cap': 1 })
    const [first, second] = view.ledger!.rows
    expect(Array.from(first!.draft).length).toBeLessThanOrEqual(240)
    expect(first!.draft.endsWith('…')).toBe(true)
    expect(first!.verdict).toBe('{"ok":true,"by":["a","b"]}')
    expect(second!.draft).toBe('ignore <b>previous</b> instructions')
    // The ledger is asked for 20 rows with the manage token; the agent's token is not used.
    expect(svc.manageCalls).toContainEqual(['GET', '/v1/manage/ledger?limit=20'])
    expect(JSON.stringify(view)).not.toContain(MANAGE_TOKEN)
  })

  it('falls back to the read-only view and says why when bili-svc refuses the manage token', async () => {
    const credentials = credentialStore({ BILI_SVC_TOKEN_BILI: SVC_TOKEN, BILI_SVC_TOKEN_MANAGE: 'wrong' })
    const h = await harness({ svc, workspace: dir, credentials })
    const view = await h.view()
    expect(view).toMatchObject({ manage: false, ledger: null, account: { session: 'dead' } })
    expect(view.manageError).toBe('status: unauthorized')
    expect(await failure(await h.post({ action: 'brake.release' }))).toMatchObject({ status: 502, error: 'bili-svc did not accept the manage token' })
  })

  it('names whoever the Reply Gate speaks as, and goes without a name when the routes cannot be read', async () => {
    svc.speaker = 'maodeng'
    const h = await managed()
    expect((await h.view()).speaker).toEqual({ id: 'maodeng', display: '猫灯魔女岚栖' })
    await h.ctx.fiber.dispose()
    svc.answer('/v1/accounts', new TypeError('fetch failed'))
    const down = await managed()
    expect((await down.view()).speaker).toBeNull()
  })

  it('keeps the status when only the ledger cannot be read', async () => {
    const h = await managed()
    svc.answer('/v1/manage/ledger', { status: 500, body: { error: 'boom' } })
    const view = await h.view()
    expect(view).toMatchObject({ manage: true, ledger: null })
    expect(view.accounts).toHaveLength(2)
  })

  it('asks for more ledger rows on request, at most 100', async () => {
    const h = await managed()
    svc.ledger = Array.from({ length: 150 }, (_, index) => ({ ts: 1_790_000_000 + index, kind: 'dm', target: String(index), state: 'sent' }))
    expect(((await (await h.post({ action: 'ledger', limit: 60 })).json()) as BiliView).ledger?.rows).toHaveLength(60)
    expect(svc.manageCalls).toContainEqual(['GET', '/v1/manage/ledger?limit=60'])
    expect((await h.post({ action: 'ledger', limit: 101 })).status).toBe(400)
    // A plain read asks for the same count when the section remembers it, and is capped.
    const get = async (query: string): Promise<BiliView> => await (await h.routes[0]!.fetch(new Request(`http://127.0.0.1/api/bili${query}`))).json() as BiliView
    expect((await get('?ledger=75')).ledger?.rows).toHaveLength(75)
    expect((await get('?ledger=900')).ledger?.rows).toHaveLength(100)
    expect((await get('?ledger=abc')).ledger?.rows).toHaveLength(20)
  })
})

describe('gate and brake', () => {
  it('switches the mode, refuses automatic while the brake holds, and releases the brake', async () => {
    svc.brake = { reason: 'risk_352', detail: 'Bilibili answered -352', ts: 1_790_200_000 }
    const h = await managed()
    expect(await failure(await h.post({ action: 'gate.mode', mode: 'auto' }))).toMatchObject({
      status: 409, code: 'mode_refused', error: 'the brake is set (risk_352); release it first',
    })
    const readonly = await (await h.post({ action: 'gate.mode', mode: 'readonly' })).json() as BiliView
    expect(readonly.gate).toMatchObject({ mode: 'readonly', readonly: true })
    expect(readonly.result).toEqual({ action: 'gate.mode', account: null, outcome: 'readonly', days: null })
    const released = await (await h.post({ action: 'brake.release' })).json() as BiliView
    expect(released.gate?.brake).toBeNull()
    expect(released.result?.outcome).toBe('released')
    const auto = await (await h.post({ action: 'gate.mode', mode: 'auto' })).json() as BiliView
    expect(auto.gate).toMatchObject({ mode: 'auto', readonly: false })
    expect((await (await h.post({ action: 'brake.release' })).json() as BiliView).result?.outcome).toBe('none')
    expect(h.logs.map(line => line.text)).toContain('bili: manage gate.mode → readonly (0 ms)')
  })
})

describe('QR sign-in', () => {
  it('shows only the code\'s modules, follows waiting, scanned, and done, and keeps the key and URL out of views and logs', async () => {
    svc.qrStates = [{ state: 'waiting' }, { state: 'scanned' }]
    const h = await managed()
    const started = await (await h.post({ action: 'login.start', account: 'maomao' })).json() as BiliView
    const login = started.logins[0]!
    expect(login).toMatchObject({ account: 'maomao', state: 'waiting', message: null })
    expect(login.qr!.length).toBeGreaterThan(20)
    expect(login.qr!.every(row => /^[01]+$/.test(row) && row.length === login.qr!.length)).toBe(true)
    expect(login.expiresAt).toBe(Math.floor(Date.now() / 1000) * 1000 + 180_000)
    expect((await (await h.post({ action: 'login.poll', account: 'maomao' })).json() as BiliView).logins[0]!.state).toBe('waiting')
    expect((await (await h.post({ action: 'login.poll', account: 'maomao' })).json() as BiliView).logins[0]!.state).toBe('scanned')
    const done = await (await h.post({ action: 'login.poll', account: 'maomao' })).json() as BiliView
    expect(done.logins[0]).toMatchObject({ state: 'done', qr: null })
    expect(done.accounts.find(account => account.id === 'maomao')?.session).toBe('ok')
    expect(done.result).toEqual({ action: 'login.poll', account: 'maomao', outcome: 'done', days: null })
    // A finished attempt stays visible for a few seconds, then goes; polling it again asks bili-svc nothing.
    const callsBefore = svc.manageCalls.length
    expect((await (await h.post({ action: 'login.poll', account: 'maomao' })).json() as BiliView).logins[0]!.state).toBe('done')
    expect(svc.manageCalls.slice(callsBefore).filter(([, path]) => path.includes('login/qr'))).toEqual([])
    await vi.advanceTimersByTimeAsync(9000)
    expect((await h.view()).logins).toEqual([])
    const everything = JSON.stringify([started, done]) + h.logs.map(line => line.text).join('\n')
    for (const secret of ['qr-key-secret', 'passport.bilibili.com', MANAGE_TOKEN]) expect(everything).not.toContain(secret)
    expect(h.logs.map(line => line.text)).toContain('bili: manage login.start account=maomao → started (0 ms)')
  })

  it('expires locally after the code\'s lifetime, can be cancelled, and cannot be polled before it starts', async () => {
    const h = await managed()
    expect(await failure(await h.post({ action: 'login.poll', account: 'maomao' }))).toMatchObject({ status: 409, code: 'no_login' })
    await h.post({ action: 'login.start', account: 'maomao' })
    await vi.advanceTimersByTimeAsync(181_000)
    expect((await h.view()).logins[0]).toMatchObject({ state: 'expired', qr: null })
    await h.post({ action: 'login.start', account: 'maomao' })
    expect((await (await h.post({ action: 'login.cancel', account: 'maomao' })).json() as BiliView).logins).toEqual([])
  })

  it('reports a failed attempt with bili-svc\'s words, and refuses an account whose session another service owns', async () => {
    svc.qrStates = [{ state: 'failed', message: 'risk control' }]
    const h = await managed()
    expect(await failure(await h.post({ action: 'login.start', account: 'maodeng' }))).toMatchObject({ status: 409, code: 'not_owner', error: 'another service owns this session' })
    await h.post({ action: 'login.start', account: 'maomao' })
    const failed = await (await h.post({ action: 'login.poll', account: 'maomao' })).json() as BiliView
    expect(failed.logins[0]).toMatchObject({ state: 'failed', qr: null, message: 'risk control' })
  })

  it('renders the same modules for the same text, with a quiet border', () => {
    const modules = qrModules('https://example.test/x')
    expect(modules).toEqual(qrModules('https://example.test/x'))
    expect(modules[0]).toMatch(/^0+$/)
  })
})

describe('sessions', () => {
  it('refreshes, reports an unchanged session and a refused refresh, checks, and logs out after the typed confirmation', async () => {
    const h = await managed()
    const refreshed = await (await h.post({ action: 'session.refresh', account: 'maomao' })).json() as BiliView
    expect(refreshed.result).toEqual({ action: 'session.refresh', account: 'maomao', outcome: 'refreshed', days: null })
    svc.refreshed = false
    expect(await failure(await h.post({ action: 'session.refresh', account: 'maomao' }))).toMatchObject({ status: 502, code: 'refresh_failed', error: 'Bilibili refused the refresh token' })
    const checked = await (await h.post({ action: 'session.check', account: 'maomao' })).json() as BiliView
    expect(checked.result).toEqual({ action: 'session.check', account: 'maomao', outcome: 'invalid', days: null })
    expect((await (await h.post({ action: 'session.check', account: 'maodeng' })).json() as BiliView).result).toEqual({
      action: 'session.check', account: 'maodeng', outcome: 'valid', days: 23,
    })
    expect((await h.post({ action: 'logout', account: 'maomao' })).status).toBe(400)
    expect((await h.post({ action: 'logout', account: 'maomao', confirm: 'maodeng' })).status).toBe(400)
    const out = await (await h.post({ action: 'logout', account: 'maomao', confirm: 'maomao' })).json() as BiliView
    expect(out.accounts.find(account => account.id === 'maomao')?.session).toBe('missing')
    expect(out.result?.outcome).toBe('logged-out')
    expect(svc.manageCalls).toContainEqual(['POST', '/v1/manage/accounts/maomao/logout'])
    expect(await failure(await h.post({ action: 'session.check', account: 'nobody' }))).toMatchObject({ status: 404, code: 'unknown_account' })
    // After sign-out there is no session to check.
    expect(await failure(await h.post({ action: 'session.check', account: 'maomao' }))).toMatchObject({ status: 400, code: 'no_session' })
    const text = h.logs.map(line => line.text).join('\n')
    expect(text).toContain('bili: manage session.refresh account=maomao → refreshed')
    expect(text).toContain('bili: manage session.refresh account=maomao failed: refresh_failed')
    expect(text).not.toContain('ticket-secret')
  })

  it('reports bili-svc unreachable as a gateway error', async () => {
    const h = await managed()
    svc.answer('/v1/manage/brake/release', new TypeError('fetch failed'))
    expect(await failure(await h.post({ action: 'brake.release' }))).toMatchObject({ status: 502, code: 'transport' })
  })
})

describe('validation', () => {
  it('refuses unknown actions, other content types, bad JSON, and malformed fields before any call', async () => {
    const h = await managed()
    const bodies: unknown[] = [
      null, 'x', [], {}, { action: 'wake' }, { action: 'login' }, { action: 'login.start' }, { action: 'login.start', account: '../x' },
      { action: 'login.start', account: 'Maomao' }, { action: 'login.start', account: 5 }, { action: 'gate.mode', mode: 'yolo' },
      { action: 'gate.mode' }, { action: 'ledger', limit: 0 }, { action: 'ledger', limit: 1.5 }, { action: 'ledger', limit: '5' },
      { action: 'owner', mid: 0 }, { action: 'owner', mid: 1.5 }, { action: 'owner', mid: '7' }, { action: 'logout', account: 'maomao', confirm: '' },
    ]
    for (const body of bodies) expect((await h.post(body)).status, JSON.stringify(body)).toBe(400)
    expect((await h.post('{', 'application/json')).status).toBe(400)
    expect((await h.post({ action: 'brake.release' }, 'text/plain')).status).toBe(415)
    expect(svc.manageCalls).toEqual([])
  })

  it('keeps only an action\'s own fields', () => {
    expect(parseAction({ action: 'login.poll', account: 'maomao', key: 'stolen', extra: 1 })).toEqual({ ok: true, action: { action: 'login.poll', account: 'maomao' } })
  })
})

describe('parsers', () => {
  it('reads times as seconds or milliseconds, and degrades unknown values', () => {
    expect(instant(1_790_000_000)).toBe(1_790_000_000_000)
    expect(instant(1_790_000_000_123)).toBe(1_790_000_000_123)
    expect(instant(0)).toBeNull()
    expect(instant('x')).toBeNull()
    expect(parseManageStatus({ accounts: [{ id: 'a', session: 'weird', refresh_mode: 'sometimes' }, { mid: 1 }], gate: 'x' })).toEqual({
      accounts: [{ id: 'a', mid: 0, display: '', session: 'missing', refreshMode: null, login: false, refreshedAt: null, importedAt: null, deadReason: null }],
      gate: null,
    })
    expect(parseLedger({ ledger: 'x', summary: { a: 1, b: { c: 2, d: [3] }, e: 'text', f: null } })).toEqual({ rows: [], summary: { 'a': 1, 'b.c': 2, 'e': 'text' } })
  })
})
