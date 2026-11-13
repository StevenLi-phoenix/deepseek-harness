import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = join(import.meta.dirname, '../../../../fork/deploy/napcat/login-door.py')
const ONEBOT_TOKEN = 'onebot-token-0123456789abcdef'
const WEBUI_TOKEN = 'webui-token-fedcba9876543210'
const CREDENTIAL = 'credential-abc'
const hasPython = spawnSync('python3', ['-c', 'pass']).status === 0

/** NapCat's WebUI as far as the door uses it. */
class FakeWebUi {
  server: Server
  calls: string[] = []
  check: Record<string, unknown> = { isLogin: false, isOffline: false, loginPhase: 'waiting_qrcode', qrcodeurl: 'https://txz.qq.com/p?k=SECRETQR&f=1', loginError: '' }
  info: Record<string, unknown> = { uin: '2153925085', nick: '小号', online: true }
  /** Answer "Unauthorized" this many times before accepting the credential. */
  refuseCredential = 0
  refreshAnswer: Record<string, unknown> = { code: 0, message: 'success', data: { qrcodeurl: 'https://txz.qq.com/p?k=NEW' } }
  constructor() {
    this.server = createServer((request, response) => { void this.handle(request, response) })
  }

  async listen(): Promise<number> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    return (this.server.address() as AddressInfo).port
  }

  private async handle(request: IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    const reply = (value: unknown): void => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)) }
    const path = request.url ?? ''
    this.calls.push(`${request.method} ${path}`)
    if (path === '/api/auth/login') {
      const expected = createHash('sha256').update(`${WEBUI_TOKEN}.napcat`).digest('hex')
      reply(body['hash'] === expected ? { code: 0, message: 'success', data: { Credential: CREDENTIAL } } : { code: -1, message: 'token is invalid' })
      return
    }
    if (request.headers.authorization !== `Bearer ${CREDENTIAL}` || this.refuseCredential > 0) {
      this.refuseCredential = Math.max(0, this.refuseCredential - 1)
      reply({ code: -1, message: 'Unauthorized' })
      return
    }
    if (path === '/api/QQLogin/CheckLoginStatus') {
      reply({ code: 0, message: 'success', data: this.check })
      return
    }
    if (path === '/api/QQLogin/GetQQLoginInfo') {
      reply({ code: 0, message: 'success', data: this.info })
      return
    }
    if (path === '/api/QQLogin/RefreshQRcode') {
      reply(this.refreshAnswer)
      return
    }
    response.statusCode = 404
    reply({ code: -1, message: 'nope' })
  }
}

let dir: string
let fake: FakeWebUi
let child: ChildProcess | undefined
let base: string
let stderr = ''

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise(resolve => probe.close(resolve))
  return port
}

async function startDoor(env: Record<string, string> = {}): Promise<void> {
  const upstreamPort = await fake.listen()
  const port = await freePort()
  child = spawn('python3', ['-I', SCRIPT], {
    env: { PATH: process.env['PATH'] ?? '', DOOR_CFG: dir, DOOR_UPSTREAM: `http://127.0.0.1:${upstreamPort}`, DOOR_BIND: '127.0.0.1', DOOR_PORT: String(port), DOOR_CACHE_S: '0', DOOR_CACHE_ONLINE_S: '0', DOOR_REFRESH_GAP_S: '0.3', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  // A spawn failure never reaches stderr, and the CI runner needs longer than a local shell to import and bind.
  child.on('error', (error: Error) => { stderr += `spawn failed: ${error.message}` })
  let exitNote = ''
  child.on('exit', (code, signal) => { exitNote = ` (exit ${String(code)}, signal ${String(signal)})` })
  base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 30_000
  while (!stderr.includes('listening')) {
    if (Date.now() > deadline) throw new Error(`login-door did not start${exitNote}: ${stderr}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const auth = { authorization: `Bearer ${ONEBOT_TOKEN}` }
const get = (path = '/v1/login', headers: Record<string, string> = auth) => fetch(base + path, { headers })
const post = (path = '/v1/login/refresh', headers: Record<string, string> = auth) => fetch(base + path, { method: 'POST', headers })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'login-door-'))
  writeFileSync(join(dir, 'webui.json'), JSON.stringify({ host: '::', port: 6099, token: WEBUI_TOKEN }))
  writeFileSync(join(dir, 'onebot11.json'), JSON.stringify({ network: { websocketServers: [{ name: 'ws', token: ONEBOT_TOKEN }] } }))
  fake = new FakeWebUi()
  stderr = ''
})

afterEach(async () => {
  child?.kill()
  child = undefined
  await new Promise(resolve => fake.server.close(resolve))
  rmSync(dir, { recursive: true, force: true })
  // Neither a token nor a QR link may reach the log.
  if (hasPython) for (const secret of [ONEBOT_TOKEN, WEBUI_TOKEN, CREDENTIAL, 'SECRETQR', 'k=NEW']) expect(stderr).not.toContain(secret)
})

describe.skipIf(!hasPython)('login door', () => {
  it('passes on a waiting QR code as a typed, trimmed answer', async () => {
    await startDoor()
    const response = await get()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ v: 1, napcat: 'up', login: 'qr', phase: 'waiting_qrcode', qrUrl: 'https://txz.qq.com/p?k=SECRETQR&f=1', uin: null, nickname: null, error: null })
  })

  it('names the account once logged in, and leaves the QR link out', async () => {
    fake.check = { isLogin: true, isOffline: false, loginPhase: 'ready', qrcodeurl: 'https://txz.qq.com/p?k=OLD', loginError: '' }
    await startDoor()
    expect(await (await get()).json()).toMatchObject({ login: 'online', uin: '2153925085', nickname: '小号', qrUrl: null })
  })

  it.each([
    [{ isLogin: false, isOffline: true, loginPhase: 'offline', qrcodeurl: '', loginError: '' }, 'offline'],
    [{ isLogin: false, isOffline: false, loginPhase: 'qrcode_scanned', qrcodeurl: '', loginError: '' }, 'scanned'],
    [{ isLogin: false, isOffline: false, loginPhase: 'initializing', qrcodeurl: '', loginError: '' }, 'logging-in'],
    [{ isLogin: false, isOffline: false, loginPhase: 'reconnecting', qrcodeurl: '', loginError: '' }, 'restarting'],
    [{ isLogin: false, isOffline: false, loginPhase: 'generating_qrcode', qrcodeurl: '', loginError: '' }, 'preparing'],
    [{ isLogin: false, isOffline: false, loginPhase: 'something-new', qrcodeurl: '', loginError: '' }, 'unknown'],
  ])('maps NapCat state %j to %s', async (check, login) => {
    fake.check = check
    await startDoor()
    expect(await (await get()).json()).toMatchObject({ login })
  })

  it('drops what NapCat says that does not fit: a foreign QR host, control characters, an oversize error', async () => {
    fake.check = { isLogin: false, isOffline: false, loginPhase: 'waiting_qrcode', qrcodeurl: 'https://evil.example/p?k=1', loginError: `过期\n${'x'.repeat(500)}` }
    await startDoor()
    const body = await (await get()).json() as { login: string; qrUrl: string | null; error: string }
    expect(body.login).toBe('preparing')
    expect(body.qrUrl).toBeNull()
    expect(body.error).not.toContain('\n')
    expect(body.error.length).toBeLessThanOrEqual(200)
  })

  it('refuses a missing or wrong token and answers nothing else', async () => {
    await startDoor()
    expect((await get('/v1/login', {})).status).toBe(401)
    expect((await get('/v1/login', { authorization: 'Bearer nope' })).status).toBe(401)
    expect((await get('/v1/anything')).status).toBe(404)
    expect((await get('/api/auth/login')).status).toBe(404)
    expect((await post('/v1/login')).status).toBe(404)
    expect((await fetch(`${base}/v1/login`, { method: 'DELETE', headers: auth })).status).toBe(405)
    expect(fake.calls).toEqual([])
    expect(stderr).toContain('refused')
  })

  it('signs in again when NapCat refuses the credential, and reports auth failure when the WebUI token is wrong', async () => {
    fake.refuseCredential = 1
    await startDoor()
    expect(await (await get()).json()).toMatchObject({ napcat: 'up', login: 'qr' })
    expect(fake.calls.filter(call => call === 'POST /api/auth/login')).toHaveLength(2)
    writeFileSync(join(dir, 'webui.json'), JSON.stringify({ token: 'changed' }))
    fake.refuseCredential = 5
    expect(await (await get()).json()).toMatchObject({ napcat: 'down', reason: 'auth' })
  })

  it('reports an unreachable NapCat as down, not as an error', async () => {
    await startDoor({ DOOR_UPSTREAM: 'http://127.0.0.1:9' })
    const response = await get()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ napcat: 'down', reason: 'unreachable' })
  })

  it('refreshes the QR code on request, at most once per gap', async () => {
    await startDoor()
    const first = await (await post()).json() as { refreshed: boolean; login: string }
    expect(first).toMatchObject({ refreshed: true, login: 'qr' })
    const second = await (await post()).json() as { refreshed: boolean }
    expect(second.refreshed).toBe(false)
    expect(fake.calls.filter(call => call.endsWith('RefreshQRcode'))).toHaveLength(1)
    await new Promise(resolve => setTimeout(resolve, 350))
    expect((await (await post()).json() as { refreshed: boolean }).refreshed).toBe(true)
  })

  it('says why a refresh was not asked for: a second one too soon', async () => {
    await startDoor()
    await post()
    expect(await (await post()).json()).toMatchObject({ refreshed: false, reason: 'too-soon' })
  })

  it('never asks NapCat for a fresh code while QQ is logged in', async () => {
    fake.check = { isLogin: true, isOffline: false, loginPhase: 'ready', qrcodeurl: '', loginError: '' }
    await startDoor()
    const answer = await (await post()).json() as { refreshed: boolean; reason: string; login: string }
    expect(answer).toMatchObject({ refreshed: false, reason: 'logged-in', login: 'online' })
    expect(fake.calls.filter(call => call.endsWith('RefreshQRcode'))).toEqual([])
  })

  it('refuses for ten minutes after QQ logged in, even once NapCat reports offline, and allows it later', async () => {
    fake.check = { isLogin: true, isOffline: false, loginPhase: 'ready', qrcodeurl: '', loginError: '' }
    await startDoor({ DOOR_RECENT_LOGIN_S: '1' })
    await get()
    fake.check = { isLogin: false, isOffline: true, loginPhase: 'offline', qrcodeurl: '', loginError: '' }
    expect(await (await post()).json()).toMatchObject({ refreshed: false, reason: 'recently-logged-in' })
    expect(fake.calls.filter(call => call.endsWith('RefreshQRcode'))).toEqual([])
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect(await (await post()).json()).toMatchObject({ refreshed: true })
  })

  it('asks NapCat about a logged-in account at most once a minute, but about a waiting code every time', async () => {
    fake.check = { isLogin: true, isOffline: false, loginPhase: 'ready', qrcodeurl: '', loginError: '' }
    await startDoor({ DOOR_CACHE_ONLINE_S: '60', DOOR_CACHE_S: '0' })
    await get()
    await get()
    await get()
    expect(fake.calls.filter(call => call.endsWith('CheckLoginStatus'))).toHaveLength(1)
  })

  it('does not call it refreshed when NapCat refuses', async () => {
    fake.refreshAnswer = { code: -1, message: 'QQ Is Logined' }
    await startDoor()
    expect(await (await post()).json()).toMatchObject({ refreshed: false, reason: 'napcat-refused' })
  })

  it('logs state changes only', async () => {
    await startDoor()
    await get()
    await get()
    fake.check = { isLogin: false, isOffline: false, loginPhase: 'qrcode_scanned', qrcodeurl: '', loginError: '' }
    await get()
    expect(stderr.match(/state: /g)).toHaveLength(2)
    expect(stderr).toContain('login qr')
    expect(stderr).toContain('login scanned')
  })
})
