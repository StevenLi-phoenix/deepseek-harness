/** The client of bili-svc: what it sends, how it reads bili-svc's outcomes, its deadlines, and its refusals. */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACTION_TIMEOUT_MS, BiliApiError, BiliOutcomeError, BiliRefused, BiliRiskError, BiliSessionError, BiliTransportError, BiliVerifyError,
  READ_TIMEOUT_MS, RemoteBiliClient, allowedEndpoint,
} from '../src/client.ts'
import { ENDPOINTS, type EndpointName } from '../src/endpoints.ts'
import BiliAccount from '../src/index.ts'
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

/** Replace fetch by a stub that answers every request with `status` and the text `raw` (a string is sent as is, anything else as JSON). */
function answering(status: number, raw: unknown) {
  const stub = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(new Response(typeof raw === 'string' ? raw : JSON.stringify(raw), { status })))
  vi.stubGlobal('fetch', stub)
  return stub
}

describe('RemoteBiliClient over answers bili-svc could give', () => {
  it('names the bili-svc id and base URL it was built with', () => {
    expect(client('maodeng').account).toBe('maodeng')
    expect(client().baseUrl).toBe(SVC_URL)
  })

  it('sends the json body, path suffix, referer, and anonymity of a call, and only those it was given', async () => {
    const stub = answering(200, { ok: true, data: 1 })
    await client().call('nav', { json: { a: 1 }, path: '/x.json', referer: 'https://www.bilibili.com/', anonymous: true })
    expect(JSON.parse(stub.mock.calls[0]![1].body as string)).toEqual({
      endpoint: 'nav', account: 'maomao', json: { a: 1 }, path: '/x.json', referer: 'https://www.bilibili.com/', anonymous: true,
    })
    await client().call('nav', { anonymous: false })
    expect(JSON.parse(stub.mock.calls[1]![1].body as string)).toEqual({ endpoint: 'nav', account: 'maomao' })
  })

  it('words an outcome by what bili-svc said: the code alone, the reason, the message, or nothing', async () => {
    answering(200, { ok: false, outcome: 'risk', code: -352 })
    await expect(client().call('nav')).rejects.toMatchObject({ reason: 'code -352' })
    answering(200, { ok: false, outcome: 'risk' })
    await expect(client().call('nav')).rejects.toMatchObject({ reason: 'risk control' })
    answering(200, { ok: false, outcome: 'refused', message: 'closed for the night' })
    await expect(client().call('nav')).rejects.toMatchObject({ outcome: 'refused', reason: 'closed for the night' })
    answering(200, { ok: false, outcome: 'held' })
    await expect(client().call('nav')).rejects.toThrow(new BiliOutcomeError('nav', 'held', ''))
    answering(200, { ok: false, outcome: 'api_error' })
    await expect(client().call('nav')).rejects.toThrow(new BiliApiError('nav', 0, ''))
    answering(200, { ok: false, outcome: 'verify' })
    await expect(client().call('nav')).rejects.toMatchObject({ code: 0, detail: '' })
    expect(logs).toContain('info bili: nav answered risk')
    expect(logs).toContain('info bili: nav answered refused (closed for the night)')
  })

  it('treats an answer with no outcome or an unknown outcome as an unknown result, and a non-object body as empty', async () => {
    answering(200, { ok: false })
    await expect(client().call('nav')).rejects.toThrow('nav: bili-svc answered an unknown outcome ""')
    expect(logs).toContain('info bili: nav answered no outcome')
    answering(200, { ok: false, outcome: 'teleported' })
    await expect(client().call('nav')).rejects.toThrow('nav: bili-svc answered an unknown outcome "teleported"')
    answering(200, '[1,2]')
    await expect(client().call('nav')).rejects.toThrow('unknown outcome ""')
    answering(200, '')
    await expect(client().call('nav')).rejects.toThrow('unknown outcome ""')
  })

  it('answers a server error as an unknown result of the call, and says why a refusal had no error text', async () => {
    answering(500, {})
    await expect(client().call('nav')).rejects.toThrow('nav: bili-svc answered HTTP 500')
    answering(403, {})
    await expect(client().call('nav')).rejects.toThrow('bili-svc did not accept the token for nav (HTTP 403)')
    answering(422, {})
    await expect(client().call('nav')).rejects.toThrow('bili-svc refused the request as malformed (HTTP 422)')
    answering(422, { error: 'bad_form' })
    await expect(client().call('nav')).rejects.toThrow('bili-svc refused the request as malformed (HTTP 422: bad_form)')
  })

  it('refuses an answer that is too large, and names a failure that is not an Error as unknown', async () => {
    answering(200, 'x'.repeat(8 * 1024 * 1024 + 1))
    await expect(client().call('nav')).rejects.toThrow('nav: bili-svc answer too large')
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error arm is the case under test.
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject('closed')))
    await expect(client().call('nav')).rejects.toThrow('nav: bili-svc is unreachable (unknown)')
  })

  it('stops with the caller\'s own abort, before and during the request', async () => {
    const stub = answering(200, {})
    const aborted = new AbortController()
    aborted.abort(new Error('caller stopped'))
    await expect(client().call('nav', { signal: aborted.signal })).rejects.toThrow('caller stopped')
    expect(stub).not.toHaveBeenCalled()
    const live = new AbortController()
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new Error('fetch aborted')) })
    })))
    const pending = client().call('nav', { signal: live.signal })
    const settled = expect(pending).rejects.toThrow('caller stopped')
    live.abort(new Error('caller stopped'))
    await settled
  })

  it('reads /v1/status as far as it is complete: no accounts, rows without an id, and a gate only when sent', async () => {
    answering(200, { accounts: 'x' })
    expect(await client().status()).toEqual({ accounts: [], gate: undefined })
    answering(200, { accounts: ['x', { mid: 5 }, { id: 'a', session: '' }, { id: 'b', mid: 7, display: 'B', session: 'dead' }], gate: { mode: 'auto' } })
    expect(await client().status()).toEqual({
      accounts: [{ id: 'a', mid: 0, display: '', session: 'none' }, { id: 'b', mid: 7, display: 'B', session: 'dead' }],
      gate: { mode: 'auto', readonly: false },
    })
    answering(401, {})
    await expect(client().status()).rejects.toThrow('bili-svc did not accept the token for /v1/status (HTTP 401)')
    answering(503, {})
    await expect(client().status()).rejects.toThrow('status: bili-svc answered HTTP 503')
  })

  it('reads who speaks for the Reply Gate from /v1/accounts', async () => {
    const stub = answering(200, { routes: { reply_comment: 'maomao', reply_dm: 'maodeng' } })
    expect(await client().replyRoutes()).toEqual({ comment: 'maomao', dm: 'maodeng' })
    expect(stub.mock.calls[0]![0]).toBe(`${SVC_URL}/v1/accounts`)
    answering(200, { routes: null })
    expect(await client().replyRoutes()).toEqual({ comment: '', dm: '' })
    answering(403, {})
    await expect(client().replyRoutes()).rejects.toThrow('bili-svc did not accept the token for /v1/accounts (HTTP 403)')
    answering(500, {})
    await expect(client().replyRoutes()).rejects.toThrow('accounts: bili-svc answered HTTP 500')
  })

  it('answers a reply without an id as just its status, and refuses any other HTTP answer', async () => {
    answering(200, { status: 'sent' })
    expect(await client().replyDm(200000001, 'hi')).toEqual({ status: 'sent' })
    answering(502, {})
    await expect(client().replyDm(200000001, 'hi')).rejects.toThrow('reply/dm: bili-svc answered HTTP 502')
  })

  it('finds an endpoint only for an https URL without credentials or a port', () => {
    const url = 'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/101abc'
    expect(allowedEndpoint('GET', 'not a url')).toBeUndefined()
    expect(allowedEndpoint('GET', url.replace('https', 'http'))).toBeUndefined()
    expect(allowedEndpoint('GET', url.replace('https://', 'https://user@'))).toBeUndefined()
    expect(allowedEndpoint('GET', url.replace('https://', 'https://user:secret@'))).toBeUndefined()
    expect(allowedEndpoint('GET', url.replace('.com', '.com:8443'))).toBeUndefined()
    expect(allowedEndpoint('GET', url)).toBe('subtitleAi')
  })
})

/** Every `.ts` and `.tsx` source under a directory. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map(entry => join(entry.parentPath, entry.name))
}

describe('no speech', () => {
  it('lists no endpoint that comments, replies, posts, shares, or messages, so no code here can name one', () => {
    for (const name of ['replyAdd', 'dmSend', 'dynamicCreate', 'shareReport']) expect(Object.hasOwn(ENDPOINTS, name)).toBe(false)
    const writes = Object.entries(ENDPOINTS).filter(([, entry]) => entry.kind === 'write').map(([name]) => name).sort()
    expect(writes).toEqual(['coin', 'favDeal', 'like', 'relationModify', 'triple', 'watchLaterAdd', 'watchLaterDel', 'watchReport'])
  })

  it('has no source in this package or its tools that names a speech endpoint or path, or calls fetch outside the client', () => {
    const files = sourceFiles
    const sources = [...files(join(import.meta.dirname, '../src')), ...files(join(import.meta.dirname, '../../tool-bili/src'))]
    expect(sources.length).toBeGreaterThan(10)
    for (const file of sources) {
      const text = readFileSync(file, 'utf8')
      for (const needle of ['replyAdd', 'dmSend', 'dynamicCreate', 'shareReport', '/x/v2/reply/add', 'send_msg', 'create/dyn', 'share/add', '/v1/reply/comment']) {
        expect(text.includes(needle), `${file} names ${needle}`).toBe(false)
      }
      if (!file.endsWith(join('src', 'client.ts')) && !file.endsWith(join('src', 'manage.ts')) && !file.endsWith(join('client', 'index.ts'))) expect(/\bfetch\(/.test(text), `${file} calls fetch`).toBe(false)
    }
  })
})

describe('the manage token', () => {
  it('is named by no tool and no agent-facing source: only the Settings route\'s client uses it', () => {
    const files = sourceFiles
    const agentFacing = [
      ...files(join(import.meta.dirname, '../../tool-bili/src')),
      ...files(join(import.meta.dirname, '../../lsy-tool-up/src')),
      join(import.meta.dirname, '../src/client.ts'),
      join(import.meta.dirname, '../src/api.ts'),
      join(import.meta.dirname, '../src/dm.ts'),
    ]
    expect(agentFacing.length).toBeGreaterThan(4)
    for (const file of agentFacing) {
      const text = readFileSync(file, 'utf8')
      for (const needle of ['/v1/manage', 'ManageClient', 'ManageSettings', 'BILI_SVC_TOKEN_MANAGE', 'manageTokenEnv']) {
        expect(text.includes(needle), `${file} names ${needle}`).toBe(false)
      }
    }
    // Inside this package only the Settings route's modules and the plugin that mounts them name the client.
    for (const file of files(join(import.meta.dirname, '../src')).filter(path => !path.includes(join('src', 'client') + '/'))) {
      const owner = ['index.ts', 'manage.ts', 'settings.ts', 'actions.ts', 'view.ts'].some(name => file.endsWith(join('src', name)))
      if (!owner) expect(readFileSync(file, 'utf8').includes('ManageClient'), `${file} names ManageClient`).toBe(false)
    }
  })

  it('is not reachable from the public methods of ctx.bili', () => {
    const methods = Object.getOwnPropertyNames(BiliAccount.prototype).filter(name => !name.startsWith('_'))
    for (const name of methods) {
      if (typeof Reflect.get(BiliAccount.prototype, name) !== 'function') continue
      expect(name, 'a public method that takes the manage token').not.toMatch(/manage|login|logout|brake|gate/i)
    }
  })
})
