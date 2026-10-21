import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clientVersion, IlinkApiError, IlinkClient, IlinkError, ILINK_BASE_URL, isStaleTokenError } from '../src/api.ts'
import { FakeIlink, textMessage } from './fake-ilink.ts'

const TOKEN = 'secret-bot-token-123'

function client(ilink: FakeIlink, token: string | null = TOKEN): IlinkClient {
  return new IlinkClient({ baseUrl: 'https://ilink.test', fetch: ilink.fetch, ...(token === null ? {} : { token }) })
}

/** A fetch that never answers until its signal aborts. */
const hangingFetch: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => { reject(new DOMException('This operation was aborted', 'AbortError')) })
})

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('IlinkClient requests', () => {
  it('requests a QR code with the iLink headers and no Authorization', async () => {
    const ilink = new FakeIlink()
    expect(await client(ilink, null).getBotQrcode()).toEqual({ qrcode: 'qr-1', url: 'https://liteapp.weixin.qq.com/q/1?qrcode=qr-1&bot_type=3' })
    const [request] = ilink.requests
    expect(request).toMatchObject({
      method: 'POST',
      origin: 'https://ilink.test',
      endpoint: 'ilink/bot/get_bot_qrcode',
      query: { bot_type: '3' },
      body: { local_token_list: [] },
      headers: {
        'content-type': 'application/json',
        'authorizationtype': 'ilink_bot_token',
        'ilink-app-id': 'bot',
        'ilink-app-clientversion': '513',
      },
    })
    expect(request!.headers).not.toHaveProperty('authorization')
    expect(Buffer.from(request!.headers['x-wechat-uin']!, 'base64').toString('utf8')).toMatch(/^\d+$/)
  })

  it('long-polls updates with the cursor, base_info, and the bearer token', async () => {
    const ilink = new FakeIlink()
    ilink.updates([textMessage('owner', 'hi'), { message_type: 'not a number' }], { longpolling_timeout_ms: 20_000 })
    const result = await client(ilink).getUpdates('cursor-0', 35_000)
    expect(result).toMatchObject({ malformed: 1, buf: 'buf-1', nextTimeoutMs: 20_000, timedOut: false })
    expect(result.messages).toEqual([{ from_user_id: 'owner', message_type: 1, context_token: 'ctx-hi', item_list: [{ type: 1, text_item: { text: 'hi' } }] }])
    expect(ilink.requests[0]).toMatchObject({
      endpoint: 'ilink/bot/getupdates',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: { get_updates_buf: 'cursor-0', base_info: { channel_version: '0.2.1', bot_agent: 'dsh-lsy-wechat/0.2.1' } },
    })
  })

  it('reads an answer without messages, cursor, or a usable timeout hint', async () => {
    const ilink = new FakeIlink()
    ilink.reply('ilink/bot/getupdates', { body: { longpolling_timeout_ms: 0 } })
    expect(await client(ilink).getUpdates('', 1000)).toEqual({ messages: [], malformed: 0, buf: undefined, nextTimeoutMs: undefined, timedOut: false })
  })

  it('treats a client-side long-poll timeout as an empty answer', async () => {
    const ilink = new FakeIlink()
    const pending = client(ilink).getUpdates('', 5000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await pending).toEqual({ messages: [], malformed: 0, buf: undefined, nextTimeoutMs: undefined, timedOut: true })
  })

  it('rejects with the external abort reason', async () => {
    const ilink = new FakeIlink()
    const controller = new AbortController()
    const pending = client(ilink).getUpdates('', 35_000, controller.signal)
    controller.abort(new Error('stopping'))
    await expect(pending).rejects.toThrow('stopping')
  })

  it('reports ret and errcode -14 as a stale token', async () => {
    const ilink = new FakeIlink()
    ilink.reply('ilink/bot/getupdates', { body: { ret: -14, errmsg: 'session timeout' } }, { body: { ret: 0, errcode: -14 } }, { body: { ret: -1 } })
    const first = await client(ilink).getUpdates('', 1000).catch((error: unknown) => error)
    expect(first).toBeInstanceOf(IlinkApiError)
    expect((first as IlinkApiError).message).toBe('iLink ilink/bot/getupdates failed: ret -14, errcode 0 (session timeout)')
    expect(isStaleTokenError(first)).toBe(true)
    expect(isStaleTokenError(await client(ilink).getUpdates('', 1000).catch((error: unknown) => error))).toBe(true)
    const other = await client(ilink).getUpdates('', 1000).catch((error: unknown) => error)
    expect(other).toBeInstanceOf(IlinkApiError)
    expect(isStaleTokenError(other)).toBe(false)
    expect(isStaleTokenError(new Error('x'))).toBe(false)
  })

  it('sends one finished bot text message with the context token', async () => {
    const ilink = new FakeIlink()
    await client(ilink).sendText('owner', 'hello', 'ctx-1')
    const body = ilink.requests[0]!.body as { msg: Record<string, unknown>; base_info: unknown }
    expect(body.msg).toMatchObject({
      from_user_id: '',
      to_user_id: 'owner',
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: 'hello' } }],
      context_token: 'ctx-1',
    })
    expect(body.msg['client_id']).toMatch(/^dsh-lsy-wechat-[0-9a-f-]{36}$/)
    expect(body.base_info).toEqual({ channel_version: '0.2.1', bot_agent: 'dsh-lsy-wechat/0.2.1' })
    expect(ilink.sent).toEqual([{ to: 'owner', text: 'hello', contextToken: 'ctx-1' }])
  })

  it('accepts a send answer without ret', async () => {
    const ilink = new FakeIlink()
    ilink.reply('ilink/bot/sendmessage', { body: {} })
    await expect(client(ilink).sendText('owner', 'x', 'ctx')).resolves.toBeUndefined()
  })

  it('fails a send on a non-zero ret', async () => {
    const ilink = new FakeIlink()
    ilink.reply('ilink/bot/sendmessage', { body: { ret: -2 } })
    const error = await client(ilink).sendText('owner', 'x', 'ctx').catch((caught: unknown) => caught)
    expect(error).toMatchObject({ name: 'IlinkApiError', ret: -2, errcode: 0, stale: false })
  })

  it('fails a send that outlives its deadline', async () => {
    const pending = new IlinkClient({ baseUrl: 'https://ilink.test', fetch: hangingFetch, timeoutMs: 2000 }).sendText('owner', 'x', 'ctx')
    const settled = pending.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await settled).toMatchObject({ name: 'IlinkError', message: 'iLink ilink/bot/sendmessage: timed out after 2000ms' })
  })

  it('fails a QR request that outlives its deadline', async () => {
    const pending = new IlinkClient({ fetch: hangingFetch }).getBotQrcode().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await pending).toMatchObject({ message: 'iLink ilink/bot/get_bot_qrcode: timed out after 15000ms' })
  })
})

describe('IlinkClient QR status', () => {
  it('polls with GET, the qrcode, and an optional verify code', async () => {
    const ilink = new FakeIlink()
    ilink.statuses({ status: 'scaned' }, {
      status: 'confirmed', bot_token: 'tok', ilink_bot_id: 'bot@im.bot', baseurl: 'https://idc.ilink.test', ilink_user_id: 'owner@im.wechat', redirect_host: '',
    })
    const c = client(ilink, null)
    expect(await c.getQrcodeStatus('qr-1', undefined, 35_000)).toEqual({
      status: 'scaned', botToken: undefined, botId: undefined, baseUrl: undefined, ownerUserId: undefined, redirectHost: undefined,
    })
    expect(await c.getQrcodeStatus('qr-1', '42', 35_000)).toEqual({
      status: 'confirmed', botToken: 'tok', botId: 'bot@im.bot', baseUrl: 'https://idc.ilink.test', ownerUserId: 'owner@im.wechat', redirectHost: undefined,
    })
    const [first, second] = ilink.requestsTo('ilink/bot/get_qrcode_status')
    expect(first).toMatchObject({ method: 'GET', query: { qrcode: 'qr-1' } })
    expect(second!.query).toEqual({ qrcode: 'qr-1', verify_code: '42' })
    expect(Object.keys(first!.headers).sort()).toEqual(['ilink-app-clientversion', 'ilink-app-id'])
  })

  it('reads a client-side timeout as wait', async () => {
    const pending = client(new FakeIlink()).getQrcodeStatus('qr-1', undefined, 35_000)
    await vi.advanceTimersByTimeAsync(35_000)
    expect((await pending).status).toBe('wait')
  })
})

describe('IlinkClient failures', () => {
  it('reports HTTP errors without the token', async () => {
    const ilink = new FakeIlink()
    ilink.reply('ilink/bot/getupdates', { status: 502, raw: `bad gateway ${TOKEN}` })
    const error = await client(ilink).getUpdates('', 1000).catch((caught: unknown) => caught) as Error
    expect(error).toBeInstanceOf(IlinkError)
    expect(error.message).toBe('iLink ilink/bot/getupdates: HTTP 502')
    expect(error.message).not.toContain(TOKEN)
  })

  it('reports network failures, non-JSON bodies, and unexpected shapes', async () => {
    const ilink = new FakeIlink()
    ilink.reply('ilink/bot/sendmessage', new TypeError('fetch failed'), { raw: '<html>' }, { body: { ret: 'zero' } })
    const send = (): Promise<unknown> => client(ilink).sendText('owner', 'x', 'ctx').catch((error: unknown) => error)
    expect(await send()).toMatchObject({ message: 'iLink ilink/bot/sendmessage: request failed: fetch failed' })
    expect(await send()).toMatchObject({ message: 'iLink ilink/bot/sendmessage: response is not JSON' })
    expect(await send()).toMatchObject({ message: 'iLink ilink/bot/sendmessage: unexpected response shape' })
  })

  it('reports non-Error network failures', async () => {
    const failing: typeof fetch = async () => { throw 'socket closed' }
    const error = await new IlinkClient({ fetch: failing }).getBotQrcode().catch((caught: unknown) => caught)
    expect(error).toMatchObject({ message: 'iLink ilink/bot/get_bot_qrcode: request failed: socket closed' })
  })

  it('reports a refused or empty QR code answer', async () => {
    const ilink = new FakeIlink()
    ilink.reply('ilink/bot/get_bot_qrcode', { body: { ret: -1, errmsg: 'busy' } }, { body: { ret: 0, qrcode: 'q' } }, { body: {} })
    await expect(client(ilink).getBotQrcode()).rejects.toThrow('iLink ilink/bot/get_bot_qrcode failed: ret -1, errcode 0 (busy)')
    await expect(client(ilink).getBotQrcode()).rejects.toThrow('no QR code in the answer')
    await expect(client(ilink).getBotQrcode()).rejects.toThrow('no QR code in the answer')
  })
})

describe('IlinkClient defaults', () => {
  it('uses the global fetch and the public origin by default', async () => {
    const ilink = new FakeIlink()
    vi.stubGlobal('fetch', ilink.fetch)
    await new IlinkClient().getBotQrcode()
    expect(ilink.requests[0]!.origin).toBe(ILINK_BASE_URL)
  })

  it('accepts a base URL with a trailing slash', async () => {
    const ilink = new FakeIlink()
    await new IlinkClient({ baseUrl: 'https://ilink.test/', fetch: ilink.fetch }).getBotQrcode()
    expect(ilink.requests[0]).toMatchObject({ origin: 'https://ilink.test', endpoint: 'ilink/bot/get_bot_qrcode' })
  })

  it('encodes versions as 0x00MMNNPP', () => {
    expect(clientVersion('1.0.11')).toBe(65_547)
    expect(clientVersion('0.2.1-rc.2')).toBe(513)
    expect(clientVersion('x')).toBe(0)
  })
})
