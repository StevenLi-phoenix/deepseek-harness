import { request } from 'node:http'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { disposeAll, mount, START } from '../../gmail/tests/fixture.ts'
import * as GmailSettings from '../src/index.ts'

const HOST = 'oauth.example'
const REDIRECT = `https://${HOST}/gmail.oauth`
const NAVIGATION = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
})

afterEach(async () => {
  await disposeAll()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function boot(options: Parameters<typeof mount>[0] = {}) {
  const env = await mount({ ...options, config: { redirectUri: REDIRECT } })
  await env.ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await env.ctx.plugin(Connection, { trustedHosts: [HOST, 'alias.example'] })
  await env.ctx.plugin(GmailSettings)
  return { ...env, origin: env.ctx.webServer.getOrigin() }
}

function callback(origin: string, state: string, host = HOST): Promise<{ status: number | undefined; html: string }> {
  const target = new URL('/gmail.oauth', origin)
  target.searchParams.set('state', state)
  target.searchParams.set('code', 'test-authorization-code')
  return new Promise((resolve, reject) => {
    const req = request(target, { headers: { ...NAVIGATION, host } }, (res) => {
      res.setEncoding('utf8')
      let html = ''
      res.on('data', (chunk: string) => { html += chunk })
      res.once('error', reject)
      res.once('end', () => { resolve({ status: res.statusCode, html }) })
    })
    req.once('error', reject)
    req.end()
  })
}

it('completes the credential-free Google navigation after restart and rejects replay', async () => {
  const first = await boot()
  const { url } = await first.gmail.beginSignIn({ account: 'personal', origin: `https://${HOST}`, policy: 'confirm-all' })
  const state = new URL(url).searchParams.get('state') ?? ''
  await first.ctx.fiber.dispose()
  const second = await boot({ pool: first.pool, credentials: first.credentials, google: first.google })

  const alias = await callback(second.origin, state, 'alias.example')
  expect(alias.status).toBe(400)
  expect(alias.html).toContain('not the registered sign-in address')
  expect(second.google.tokenCalls('authorization_code')).toHaveLength(0)

  const accepted = await callback(second.origin, state)
  expect(accepted.status).toBe(200)
  expect(accepted.html).toContain('已连接 personal')
  expect(second.gmail.accounts()).toMatchObject([{ id: 'personal', policy: 'confirm-all' }])
  const replay = await callback(second.origin, state)
  expect(replay.status).toBe(410)
  expect(replay.html).toContain('已过期或已使用')
  expect(second.google.tokenCalls('authorization_code')).toHaveLength(1)
  expect(second.logs.join('\n')).not.toContain(state)
  expect(second.logs.join('\n')).not.toContain('test-authorization-code')
})

it('answers unknown and expired states with a readable 410 before any Google request', async () => {
  const env = await boot()
  const { url } = await env.gmail.beginSignIn({ account: 'personal', origin: `https://${HOST}` })
  vi.setSystemTime(START + 10 * 60_000)
  for (const state of ['A'.repeat(32), new URL(url).searchParams.get('state') ?? '']) {
    const refused = await callback(env.origin, state)
    expect(refused.status).toBe(410)
    expect(refused.html).toContain('请回到设置 → 邮箱重新连接')
  }
  expect(env.google.calls).toEqual([])
})
