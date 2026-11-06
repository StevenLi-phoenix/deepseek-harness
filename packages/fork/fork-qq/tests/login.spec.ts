import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoginDoor, parseDoorAnswer, qrLink } from '../src/login.ts'

afterEach(() => { vi.unstubAllGlobals() })

const TOKEN = 'onebot-token-0123456789abcdef'

/** A fetch that answers with `response`, or throws when given an Error. */
const answering = (response: Response | Error): typeof fetch => async () => {
  if (response instanceof Error) throw response
  return response
}

const online = { v: 1, napcat: 'up', login: 'online', uin: '2153925085', nickname: '小号' }

describe('qrLink', () => {
  it('passes an https link on qq.com or one of its subdomains', () => {
    expect(qrLink('https://txz.qq.com/p?k=1')).toBe('https://txz.qq.com/p?k=1')
    expect(qrLink('https://qq.com/p')).toBe('https://qq.com/p')
  })

  it.each([
    ['text that is not a string', 5],
    ['a link over 600 characters', `https://txz.qq.com/${'a'.repeat(600)}`],
    ['a link with whitespace', 'https://txz.qq.com/a b'],
    ['text that is not a URL', 'not a url'],
    ['plain http', 'http://txz.qq.com/p'],
    ['a host that only ends like qq.com', 'https://evilqq.com/p'],
    ['another host', 'https://example.com/p'],
  ])('refuses %s', (_name, value) => {
    expect(qrLink(value)).toBeNull()
  })
})

describe('parseDoorAnswer', () => {
  it('reads an online answer, cleaning the text fields and keeping the code only while a scan is wanted', () => {
    expect(parseDoorAnswer({ ...online, nickname: '  小\u0007号  ', error: 'x'.repeat(300), qrUrl: 'https://txz.qq.com/p' })).toEqual({
      kind: 'ok', login: 'online', uin: '2153925085', nickname: '小 号', error: 'x'.repeat(200), qrUrl: null,
    })
    expect(parseDoorAnswer({ ...online, login: 'qr', uin: null, qrUrl: 'https://txz.qq.com/p' })).toMatchObject({ login: 'qr', uin: null, qrUrl: 'https://txz.qq.com/p' })
  })

  it('drops a blank text field and a uin that is not digits', () => {
    expect(parseDoorAnswer({ ...online, nickname: '   ', error: 5, uin: 'abc' })).toMatchObject({ nickname: null, error: null, uin: null })
  })

  it.each([
    ['not an object', 'text'],
    ['null', null],
    ['another version', { ...online, v: 2 }],
    ['an unknown NapCat state', { ...online, napcat: 'sideways' }],
    ['a login state that is not text', { ...online, login: 5 }],
    ['a login state it does not know', { ...online, login: 'dancing' }],
  ])('calls %s invalid', (_name, body) => {
    expect(parseDoorAnswer(body)).toEqual({ kind: 'invalid' })
  })

  it('reads NapCat being down', () => {
    expect(parseDoorAnswer({ v: 1, napcat: 'down' })).toEqual({ kind: 'napcat-down' })
  })
})

describe('LoginDoor', () => {
  const door = (fetchImpl: typeof fetch) => new LoginDoor({ url: 'http://127.0.0.1:3002///', timeoutMs: 1000, fetch: fetchImpl })

  it('asks the door with the Bearer token, no redirects, and a path joined to the address without trailing slashes', async () => {
    let seen: { url: string; init: RequestInit | undefined } | undefined
    const fetchImpl: typeof fetch = async (url, init) => { seen = { url: typeof url === 'string' ? url : 'not a string', init }; return Response.json(online) }
    expect(await door(fetchImpl).status(TOKEN)).toMatchObject({ kind: 'ok', login: 'online' })
    expect(seen?.url).toBe('http://127.0.0.1:3002/v1/login')
    expect(seen?.init).toMatchObject({ method: 'GET', headers: { authorization: `Bearer ${TOKEN}` }, redirect: 'error' })
  })

  it('posts a refresh, and reports whether the door passed it on and why not', async () => {
    const refused = await door(answering(Response.json({ ...online, refreshed: false, reason: 'too-soon' }))).refresh(TOKEN)
    expect(refused).toMatchObject({ refreshed: false, reason: 'too-soon', result: { kind: 'ok' } })
    const passed = await door(answering(Response.json({ ...online, refreshed: true }))).refresh(TOKEN)
    expect(passed.refreshed).toBe(true)
    expect(passed).not.toHaveProperty('reason')
    const odd = await door(answering(Response.json({ ...online, refreshed: 'yes', reason: 'because' }))).refresh(TOKEN)
    expect(odd.refreshed).toBe(false)
    expect(odd).not.toHaveProperty('reason')
  })

  it('reads an answer that is not an object as a refresh that did nothing', async () => {
    const answer = await door(answering(Response.json([1, 2]))).refresh(TOKEN)
    expect(answer).toMatchObject({ result: { kind: 'invalid' }, refreshed: false })
    expect(await door(answering(Response.json(null))).refresh(TOKEN)).toMatchObject({ result: { kind: 'invalid' } })
  })

  it('tells an unreachable door, a refused token, and a failing door apart', async () => {
    expect(await door(answering(new Error('connect ECONNREFUSED'))).status(TOKEN)).toEqual({ kind: 'unreachable' })
    expect(await door(answering(new Response('no', { status: 401 }))).status(TOKEN)).toEqual({ kind: 'unauthorized' })
    expect(await door(answering(new Response('no', { status: 503 }))).status(TOKEN)).toEqual({ kind: 'unauthorized' })
    expect(await door(answering(new Response('no', { status: 500 }))).status(TOKEN)).toEqual({ kind: 'invalid' })
  })

  it('calls an OK answer that is not JSON invalid', async () => {
    expect(await door(answering(new Response('<html>', { status: 200 }))).status(TOKEN)).toEqual({ kind: 'invalid' })
  })

  it('uses the global fetch when none is given', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => { calls.push(url); return Response.json(online) })
    expect(await new LoginDoor({ url: 'http://127.0.0.1:1', timeoutMs: 10 }).status(TOKEN)).toMatchObject({ kind: 'ok' })
    expect(calls).toEqual(['http://127.0.0.1:1/v1/login'])
  })
})
