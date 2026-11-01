import { Context } from '@deepseek-ai/cordis'
import { encode } from 'uqr'
import { describe, expect, it, vi, type Mock } from 'vitest'
import * as plugin from '../src/index.ts'
import { qrMatrix, type QqSource } from '../src/panel.ts'
import { QQ_PATH, QQ_REFRESH_PATH, type QqPanel, type QqRefreshAnswer } from '../src/view.ts'

const QR_URL = 'https://txz.qq.com/p?k=SECRETQRLINK&f=1'

interface Route { path: string; methods: readonly string[]; requestBody: string; fetch: (request: Request) => Promise<Response> }

function source(over: Partial<QqSource> = {}): QqSource & { loginStatus: Mock<QqSource['loginStatus']>; refreshLogin: Mock<QqSource['refreshLogin']> } {
  const reading = { door: 'ok' as const, state: 'qr' as const, uin: null, nickname: null, error: null, qrUrl: QR_URL }
  return {
    connectionStatus: () => ({ state: 'reconnecting', since: 1000, attempt: 4, lastError: 'socket hang up', selfId: null }),
    recordedGroups: () => 24,
    ...over,
    loginStatus: vi.fn(over.loginStatus ?? (() => Promise.resolve(reading))),
    refreshLogin: vi.fn(over.refreshLogin ?? (() => Promise.resolve({ login: reading, refreshed: true }))),
  }
}

async function mount(qq: QqSource) {
  const ctx = new Context()
  const routes: Route[] = []
  const logs: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push(`${message.type} ${String(message.args[0])}`) } })
  ctx.provide('connection', { fetch: { register: (route: Route) => { routes.push(route); return () => Promise.resolve() } } } as never)
  ctx.provide('forkQq', qq as never)
  await ctx.plugin(plugin)
  return { ctx, routes, logs }
}

describe('fork-qq-login Host routes', () => {
  it('registers GET /api/fork.qq and POST /api/fork.qq.refresh on the connection, under the /api sign-in', async () => {
    const { routes } = await mount(source())
    expect(routes.map(route => [route.path, route.methods, route.requestBody])).toEqual([
      [QQ_PATH, ['GET'], 'buffered'],
      [QQ_REFRESH_PATH, ['POST'], 'buffered'],
    ])
  })

  it('answers connection, login, and the code as a module matrix, never the link', async () => {
    const { routes, logs } = await mount(source())
    const response = await routes[0]!.fetch(new Request(`http://127.0.0.1${QQ_PATH}`))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json() as QqPanel
    expect(body.connection).toEqual({ state: 'reconnecting', since: 1000, attempt: 4, lastError: 'socket hang up', selfId: null })
    expect(body.groupsRecorded).toBe(24)
    const expected = encode(QR_URL, { ecc: 'M' })
    expect(body.login).toEqual({
      door: 'ok', state: 'qr', uin: null, nickname: null, error: null,
      qr: { size: expected.size, rows: expected.data.map(row => row.map(dark => (dark ? '1' : '0')).join('')) },
    })
    expect(JSON.stringify(body)).not.toContain('SECRETQRLINK')
    expect(logs.join('\n')).not.toContain('SECRETQRLINK')
  })

  it('asks for a fresh reading when the page says ?fresh=1', async () => {
    const qq = source()
    const { routes } = await mount(qq)
    await routes[0]!.fetch(new Request(`http://127.0.0.1${QQ_PATH}`))
    await routes[0]!.fetch(new Request(`http://127.0.0.1${QQ_PATH}?fresh=1`))
    expect(qq.loginStatus.mock.calls.map(call => call[0]?.fresh)).toEqual([false, true])
  })

  it('passes the refresh verdict on with the panel after the request', async () => {
    const qq = source()
    const { routes } = await mount(qq)
    const answer = await (await routes[1]!.fetch(new Request(`http://127.0.0.1${QQ_REFRESH_PATH}`, { method: 'POST' }))).json() as QqRefreshAnswer
    expect(answer.refreshed).toBe(true)
    expect(answer.login.qr?.size).toBeGreaterThan(20)
    expect(qq.refreshLogin.mock.calls).toHaveLength(1)
  })

  it('draws no code for a login with none, and none from a link that cannot be encoded', async () => {
    const reading = { door: 'unreachable' as const, state: null, uin: null, nickname: null, error: null, qrUrl: null }
    const { routes } = await mount(source({ loginStatus: () => Promise.resolve(reading) }))
    const body = await (await routes[0]!.fetch(new Request(`http://127.0.0.1${QQ_PATH}`))).json() as QqPanel
    expect(body.login).toEqual({ door: 'unreachable', state: null, uin: null, nickname: null, error: null, qr: null })
    expect(qrMatrix('x'.repeat(5000))).toBeNull()
  })
})
