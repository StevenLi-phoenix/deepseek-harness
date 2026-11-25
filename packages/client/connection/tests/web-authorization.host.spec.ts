/** WebServer admission applies Connection source checks once before route dispatch. */
import { request as httpRequest } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import WebServer, { type WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, expect, it, vi } from 'vitest'
import * as Connection from '../src/index.ts'

const roots: Context[] = []
afterEach(async () => { for (const root of roots.splice(0)) await root.fiber.dispose() })

async function mounted(config?: Parameters<typeof Connection.Config>[0]) {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const connection = ctx.plugin(Connection, config)
  await connection.await()
  return { ctx, connection, origin: ctx.webServer.getOrigin() }
}

async function requestStatus(url: string, headers: Record<string, string>, method = 'GET'): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers, method }, (response) => {
      response.resume()
      response.once('end', () => { resolve(response.statusCode) })
    })
    request.once('error', reject)
    request.end()
  })
}

const navigation = {
  'sec-fetch-site': 'cross-site',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
}

const navigationPolicy = 'self-authenticated-navigation'

it('admits trusted top-level GETs to an opted-in exact resource without a Peer', async () => {
  const { ctx, connection, origin } = await mounted({ trustedHosts: ['callback.example:3080'] })
  const authenticate = vi.fn(() => ctx.connection.browserPeer)
  ctx.connection.authentication.register({ authenticate })
  const resource = vi.fn(async (_request: Request, _peer?: object) => new Response('callback'))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/callback', auth: navigationPolicy, resource }))

  expect(await requestStatus(`${origin}/callback?ticket=fixture`, navigation)).toBe(200)
  expect(await requestStatus(`${origin}/callback`, { ...navigation, origin })).toBe(200)
  expect(await requestStatus(`${origin}/callback`, { ...navigation, host: 'callback.example:3080' })).toBe(200)
  expect(await requestStatus(`${origin}/callback`, {})).toBe(200)
  expect(resource).toHaveBeenCalledTimes(4)
  expect(resource.mock.calls.every(call => call[1] === undefined)).toBe(true)
  expect(authenticate).not.toHaveBeenCalled()
  await connection.dispose()
  expect(await requestStatus(`${origin}/callback`, navigation)).toBe(503)
  expect(resource).toHaveBeenCalledTimes(4)
})

it('refuses a navigation with the wrong Host, Origin, method, or Fetch Metadata', async () => {
  const { ctx, origin } = await mounted()
  const resource = vi.fn(async () => new Response('callback'))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/callback', auth: navigationPolicy, resource }))
  const callback = `${origin}/callback`
  const deniedHeaders: Record<string, string>[] = [
    { ...navigation, host: 'untrusted.example' },
    { ...navigation, host: 'callback.example:3081' },
    { ...navigation, host: `${new URL(origin).host}/not-an-authority` },
    { ...navigation, origin: 'https://untrusted.example' },
    { ...navigation, origin: origin.replace('http:', 'https:') },
    { ...navigation, origin: `${origin}/not-an-origin` },
    { ...navigation, origin: 'null' },
    { ...navigation, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
    { ...navigation, 'sec-fetch-dest': 'iframe' },
    { ...navigation, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
    { ...navigation, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' },
    { ...navigation, 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'iframe' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-mode': 'navigate' },
    { 'sec-fetch-dest': 'document' },
    { 'sec-fetch-user': '?1' },
  ]
  for (const headers of deniedHeaders) {
    expect(await requestStatus(callback, headers), JSON.stringify(headers)).toBe(403)
  }
  for (const method of ['HEAD', 'POST']) {
    expect(await requestStatus(callback, navigation, method), method).toBe(403)
  }
  expect(ctx.bail(ctx.webServer, 'webserver/authorize', {
    headers: navigation, method: 'GET', url: new URL(callback), transport: 'http',
  }, navigationPolicy)).toEqual({ kind: 'deny', status: 403 })
  expect(resource).not.toHaveBeenCalled()
})

it('limits the policy to fixed exact resources rather than prefix, handler, fallback, or shared API routes', async () => {
  const { ctx, origin } = await mounted()
  const resource = vi.fn(async () => new Response('callback'))
  const handler = vi.fn<WebRoute['handler']>((_request, response) => { response.end() })
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/callback', auth: navigationPolicy, resource }))
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/prefix', auth: navigationPolicy, resource }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/handler', auth: navigationPolicy, handler }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/selected', auth: () => navigationPolicy, resource }))
  ctx.effect(() => ctx.webServer.registerFallback({ auth: navigationPolicy, resource }))
  for (const path of ['/callback/nested', '/prefix', '/prefix/child', '/handler', '/selected', '/api/fixture/read']) {
    expect(await requestStatus(`${origin}${path}`, navigation), path).toBe(403)
  }
  expect(await requestStatus(`${origin}/api/fixture/read`, { ...navigation, 'sec-fetch-site': 'same-origin' })).toBe(401)
  const read = await ctx.webServer.readResource(new Request(`${origin}/callback`), ctx.connection.browserPeer)
  expect(read.status).toBe(403)
  expect(resource).not.toHaveBeenCalled()
  expect(handler).not.toHaveBeenCalled()
})

it('checks anonymous route sources without authenticating their credentials', async () => {
  const { ctx, origin } = await mounted()
  const authenticate = vi.fn(() => ctx.connection.browserPeer)
  ctx.connection.authentication.register({ authenticate })
  const handler = vi.fn<WebRoute['handler']>((_request, response) => { response.end('public') })
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/public', auth: 'anonymous', handler }))
  for (const headers of [{ host: 'untrusted.example' }, { origin: 'http://untrusted.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    expect(await requestStatus(`${origin}/public`, headers)).toBe(403)
  }
  expect(handler).not.toHaveBeenCalled()
  const response = await fetch(`${origin}/public`, { headers: { cookie: 'irrelevant=value' } })
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('public')
  expect(authenticate).not.toHaveBeenCalled()
  expect(handler.mock.calls[0]?.[2]).toBeUndefined()
})

it('authenticates once and passes the selected Peer to shared and custom RPC routes', async () => {
  const { ctx, origin } = await mounted()
  const peer = ctx.connection.createPeer({ principal: { kind: 'owner' } })
  const authenticate = vi.fn(() => peer)
  ctx.connection.authentication.register({ authenticate })
  const handler = vi.fn<Connection.ConnectionRpcHandler>(async (_endpoint, _payload, _signal, caller) => ({ ok: true, value: caller.id }))
  ctx.connection.rpc.intercept('/api', () => true, handler)
  await ctx.plugin({ inject: ['connection', 'webServer'], apply(owner: Context) {
    owner.connection.rpc.handle('/custom', handler)
  } }).await()
  for (const channel of ['/api', '/custom']) {
    const response = await fetch(`${origin}${channel}/fixture/read`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'one', method: 'fixture/read', payload: {} }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ result: { ok: true, value: peer.id } })
  }
  expect(authenticate).toHaveBeenCalledTimes(2)
  expect(handler).toHaveBeenCalledTimes(2)
  expect(handler.mock.calls.every(call => call[3] === peer)).toBe(true)
})

it('withdraws authorization with Connection and leaves authenticated routes unavailable', async () => {
  const { ctx, connection, origin } = await mounted()
  const handler = vi.fn<WebRoute['handler']>((_request, response) => { response.end('private') })
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/private', handler }))
  expect((await fetch(`${origin}/private`)).status).toBe(401)
  await connection.dispose()
  expect((await fetch(`${origin}/private`)).status).toBe(503)
  expect(handler).not.toHaveBeenCalled()
})
