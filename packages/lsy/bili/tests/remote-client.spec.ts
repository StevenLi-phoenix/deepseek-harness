/** The client of bili-svc: what it sends, how it reads bili-svc's outcomes, its deadlines, and its refusals. */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACTION_TIMEOUT_MS, BiliApiError, BiliOutcomeError, BiliRefused, BiliRiskError, BiliSessionError, BiliTransportError, BiliVerifyError,
  READ_TIMEOUT_MS, RemoteBiliClient, allowedEndpoint,
} from '../src/client.ts'
import { ENDPOINTS, type EndpointName } from '../src/endpoints.ts'
import { FakeBiliSvc, SVC_TOKEN, SVC_URL } from './fake-bili-svc.ts'

let svc: FakeBiliSvc
let token: string | undefined
let logs: string[]

function client(account = 'maomao'): RemoteBiliClient {
  return new RemoteBiliClient({
    baseUrl: SVC_URL, account, token: () => Promise.resolve(token),
    debug: (line) => { logs.push(`debug ${line}`) }, info: (line) => { logs.push(`info ${line}`) },
  })
}

beforeEach(() => {
  svc = new FakeBiliSvc()
  token = SVC_TOKEN
  logs = []
  vi.stubGlobal('fetch', svc.fetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('RemoteBiliClient', () => {
  it('posts each call to the door with the bearer token, the account, and the composed query and form, and no cookie', async () => {
    const answer = await client().call('view', { query: { bvid: 'BV1aa4y1X7aa' } })
    expect((answer.data as { aid: number }).aid).toBe(101)
    const [request] = svc.requests
    expect(request).toMatchObject({ method: 'POST', path: '/v1/bili/call', authorization: `Bearer ${SVC_TOKEN}` })
    expect(request!.body).toEqual({ endpoint: 'view', account: 'maomao', query: { bvid: 'BV1aa4y1X7aa' } })
    await client().call('like', { query: { a: 1 }, form: { aid: '101', like: 1 }, referer: 'https://www.bilibili.com/en/video/BV1aa4y1X7aa/' })
    expect(svc.requests[1]!.body).toEqual({ endpoint: 'like', account: 'maomao', query: { a: 1 }, form: { aid: '101', like: 1 }, referer: 'https://www.bilibili.com/en/video/BV1aa4y1X7aa/' })
    expect(JSON.stringify(svc.requests)).not.toMatch(/SESSDATA|bili_jct|cookie/i)
    // The token never reaches a log line.
    expect(logs.join('\n')).not.toContain(SVC_TOKEN)
    expect(logs.some(line => line.startsWith('debug bili: view → bili-svc HTTP 200'))).toBe(true)
  })

  it('maps every outcome of bili-svc to this package\'s errors', async () => {
    const cases: [string, Record<string, unknown>, (error: unknown) => void][] = [
      ['risk', { ok: false, outcome: 'risk', code: -352, message: '风控校验失败' }, (error) => {
        expect(error).toBeInstanceOf(BiliRiskError)
        expect((error as BiliRiskError).reason).toBe('code -352: 风控校验失败')
      }],
      ['api_error', { ok: false, outcome: 'api_error', code: 34005, message: '超过投币上限啦~' }, (error) => {
        expect(error).toBeInstanceOf(BiliApiError)
        expect(error).not.toBeInstanceOf(BiliVerifyError)
        expect(error).toMatchObject({ code: 34005, detail: '超过投币上限啦~' })
      }],
      ['verify', { ok: false, outcome: 'verify', code: 21015, message: '请先绑定手机' }, (error) => {
        expect(error).toBeInstanceOf(BiliVerifyError)
        expect(error).toMatchObject({ code: 21015, detail: '请先绑定手机' })
      }],
      ['session_expired', { ok: false, outcome: 'session_expired', code: -101 }, (error) => {
        expect(error).toBeInstanceOf(BiliSessionError)
        expect((error as Error).message).toContain('the owner renews it there')
      }],
      ['session_unavailable', { ok: false, outcome: 'session_unavailable', message: 'no cookies' }, (error) => {
        expect(error).toMatchObject({ outcome: 'session_unavailable', detail: 'no cookies' })
      }],
      ['refused', { ok: false, outcome: 'refused', reason: 'daily cap of like reached (30)' }, (error) => {
        expect(error).toBeInstanceOf(BiliOutcomeError)
        expect(error).toMatchObject({ outcome: 'refused', reason: 'daily cap of like reached (30)' })
      }],
      ['held', { ok: false, outcome: 'held', reason: 'sender busy' }, (error) => { expect(error).toMatchObject({ outcome: 'held', reason: 'sender busy' }) }],
      ['already', { ok: false, outcome: 'already', reason: 'coin on 101 was already done' }, (error) => { expect(error).toMatchObject({ outcome: 'already' }) }],
      ['uncertain', { ok: false, outcome: 'uncertain', reason: 'the request may or may not have reached Bilibili' }, (error) => { expect(error).toMatchObject({ outcome: 'uncertain' }) }],
      ['unknown', { ok: false, outcome: 'surprise' }, (error) => { expect(error).toBeInstanceOf(BiliTransportError) }],
    ]
    for (const [label, body, check] of cases) {
      svc.answer('like', { body })
      const error: unknown = await client().call('like', { form: { aid: '101' } }).then(() => undefined, (failure: unknown) => failure)
      expect(error, label).toBeDefined()
      check(error)
    }
    expect(logs.some(line => line === 'info bili: like answered risk (code -352: 风控校验失败)')).toBe(true)
  })

  it('treats HTTP 401, 403, 404, and 422 as refusals, and a server error or a network failure as an unknown outcome', async () => {
    token = 'wrong'
    await expect(client().call('nav')).rejects.toThrow(new BiliRefused('bili-svc did not accept the token for nav (HTTP 401: unauthorized)'))
    token = SVC_TOKEN
    svc.answer('nav', { status: 404, body: { error: 'unknown_account' } })
    await expect(client('nobody').call('nav')).rejects.toThrow('bili-svc does not know the account nobody (HTTP 404)')
    svc.answer('nav', { status: 422, body: { error: 'bad_request' } })
    await expect(client().call('nav')).rejects.toBeInstanceOf(BiliRefused)
    svc.answer('like', { status: 502, body: { error: 'bilibili_error' } })
    await expect(client().call('like', { form: { aid: '101' } })).rejects.toBeInstanceOf(BiliTransportError)
    svc.answer('like', new TypeError('fetch failed'))
    await expect(client().call('like', { form: { aid: '101' } })).rejects.toThrow('like: bili-svc is unreachable (TypeError)')
    svc.answer('nav', { raw: '<html>' })
    await expect(client().call('nav')).rejects.toThrow('bili-svc answer is not JSON')
  })

  it('gives a read 30 s and an action 330 s, since bili-svc may wait minutes for its sender slot', async () => {
    vi.useFakeTimers()
    expect(READ_TIMEOUT_MS).toBe(30_000)
    expect(ACTION_TIMEOUT_MS).toBe(330_000)
    svc.answer('nav', 'hang')
    const read = client().call('nav').then(() => 'answered', (error: unknown) => error)
    await vi.advanceTimersByTimeAsync(29_000)
    expect(await Promise.race([read, Promise.resolve('pending')])).toBe('pending')
    await vi.advanceTimersByTimeAsync(1_500)
    expect(String(await read)).toContain('no answer from bili-svc within 30000 ms')

    svc.answer('coin', 'hang')
    const action = client().call('coin', { form: { aid: '101', multiply: 1 } }).then(() => 'answered', (error: unknown) => error)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(await Promise.race([action, Promise.resolve('pending')])).toBe('pending')
    await vi.advanceTimersByTimeAsync(31_000)
    const error = await action
    expect(error).toBeInstanceOf(BiliTransportError)
    expect(String(error)).toContain('within 330000 ms')
  })

  it('sends nothing without the token, and nothing for a name outside the door\'s list', async () => {
    token = undefined
    await expect(client().call('nav')).rejects.toThrow('BILI_SVC_TOKEN_BILI is not set, so bili-svc cannot be called; nav was not sent')
    await expect(client().status()).rejects.toBeInstanceOf(BiliRefused)
    await expect(client().replyDm(200000001, 'hi')).rejects.toBeInstanceOf(BiliRefused)
    token = SVC_TOKEN
    for (const name of ['replyAdd', 'dmSend', 'dynamicCreate', 'shareReport', 'qrPoll', 'cookieRefresh']) {
      await expect(client().call(name as EndpointName)).rejects.toThrow(`${name} is not an endpoint this package may call`)
    }
    expect(svc.requests).toEqual([])
  })

  it('reads the accounts and gate from /v1/status and replies to the owner through /v1/reply/dm', async () => {
    svc.gate = { ...svc.gate, mode: 'readonly', readonly: true }
    expect(await client().status()).toEqual({
      accounts: [
        { id: 'maodeng', mid: 1_000_001, display: '猫灯魔女岚栖', session: 'ok' },
        { id: 'maomao', mid: 3_000_001, display: '魔女的猫猫', session: 'ok' },
      ],
      gate: { mode: 'readonly', readonly: true },
    })
    expect(svc.requests[0]).toMatchObject({ method: 'GET', path: '/v1/status', authorization: `Bearer ${SVC_TOKEN}` })
    svc.replyStatus = ['held']
    expect(await client().replyDm(200000001, '在的')).toEqual({ status: 'held', id: 'r-1' })
    expect(svc.replies).toEqual([{ account: 'maomao', talker: 200000001, message: '在的' }])
    svc.answer('/v1/reply/dm', { body: {} })
    await expect(client().replyDm(200000001, '在的')).rejects.toThrow('bili-svc answered no status')
  })

  it('keeps big integers exact and finds subtitle files by their URL', async () => {
    svc.answer('replies', { raw: '{"ok":true,"code":0,"data":{"rpid":600000000000000001}}' })
    expect((await client().call('replies')).data).toEqual({ rpid: '600000000000000001' })
    expect(allowedEndpoint('GET', 'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/101abc?auth_key=1')).toBe('subtitleAi')
    expect(allowedEndpoint('GET', 'https://evil.example/bfs/ai_subtitle/prod/101abc')).toBeUndefined()
    expect(allowedEndpoint('POST', 'https://api.bilibili.com/x/v2/reply/add')).toBeUndefined()
  })
})

describe('no speech', () => {
  it('lists no endpoint that comments, replies, posts, shares, or messages, so no code here can name one', () => {
    for (const name of ['replyAdd', 'dmSend', 'dynamicCreate', 'shareReport']) expect(Object.hasOwn(ENDPOINTS, name)).toBe(false)
    const writes = Object.entries(ENDPOINTS).filter(([, entry]) => entry.kind === 'write').map(([name]) => name).sort()
    expect(writes).toEqual(['coin', 'favDeal', 'like', 'relationModify', 'triple', 'watchLaterAdd', 'watchLaterDel', 'watchReport'])
  })

  it('has no source in this package or its tools that names a speech endpoint or path, or calls fetch outside the client', () => {
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true, recursive: true })
      .filter(entry => entry.isFile() && /\.tsx?$/.test(entry.name))
      .map(entry => join(entry.parentPath, entry.name))
    const sources = [...files(join(import.meta.dirname, '../src')), ...files(join(import.meta.dirname, '../../tool-bili/src'))]
    expect(sources.length).toBeGreaterThan(10)
    for (const file of sources) {
      const text = readFileSync(file, 'utf8')
      for (const needle of ['replyAdd', 'dmSend', 'dynamicCreate', 'shareReport', '/x/v2/reply/add', 'send_msg', 'create/dyn', 'share/add', '/v1/reply/comment']) {
        expect(text.includes(needle), `${file} names ${needle}`).toBe(false)
      }
      if (!file.endsWith(join('src', 'client.ts')) && !file.endsWith(join('client', 'index.ts'))) expect(/\bfetch\(/.test(text), `${file} calls fetch`).toBe(false)
    }
  })
})
