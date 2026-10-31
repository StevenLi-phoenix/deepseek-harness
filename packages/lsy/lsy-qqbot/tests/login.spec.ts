import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { encode } from 'uqr'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connectUrl, decryptSecret, loginWithQr, LoginError, qrPng, runLoginCli, upsertEnvFile } from '../src/login.ts'

const APP_ID = '1020304050'
const APP_SECRET = 'PlatformIssuedSecret0123456789abcdef'
const OPENID = 'E4D1A2B3C4D5E6F708192A3B4C5D6E7F'

/** Encrypt the way the platform does: nonce, ciphertext, tag, base64. */
function encryptFor(keyBase64: string, secret: string): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), nonce)
  const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64')
}

/** The bind service: tasks are created with a key, then polled until scanned or expired. */
class FakeBindService {
  readonly tasks = new Map<string, { key: string; polls: number; scanAfter: number | undefined; expireAfter: number | undefined }>()
  readonly calls: string[] = []
  /** Polls before the first task is scanned; undefined means never. */
  scanAfter: number | undefined = 1
  /** Polls before each task expires; undefined means never. */
  expireAfter: number | undefined
  /** Only the first task expires. */
  expireFirstOnly = false
  failPolls = 0
  failCreate: string | undefined
  garbleSecret = false
  private counter = 0

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname
    this.calls.push(path)
    const body = JSON.parse(String(init?.body)) as Record<string, string>
    const reply = (data: unknown, retcode = 0, msg = 'success'): Response => new Response(JSON.stringify({ retcode, msg, data }), { status: 200 })
    if (path === '/lite/create_bind_task') {
      if (this.failCreate !== undefined) return reply(undefined, 1, this.failCreate)
      this.counter += 1
      const taskId = `task-${this.counter}`
      this.tasks.set(taskId, { key: body['key']!, polls: 0, scanAfter: this.scanAfter, expireAfter: this.expireFirstOnly && this.counter > 1 ? undefined : this.expireAfter })
      return reply({ task_id: taskId })
    }
    if (path === '/lite/poll_bind_result') {
      if (this.failPolls > 0) { this.failPolls -= 1; return new Response('bad gateway', { status: 502 }) }
      const task = this.tasks.get(body['task_id']!)!
      task.polls += 1
      if (task.expireAfter !== undefined && task.polls > task.expireAfter) return reply({ status: 3, bot_appid: '0', bot_encrypt_secret: '', user_openid: '' })
      if (task.scanAfter !== undefined && task.polls >= task.scanAfter) {
        const secret = this.garbleSecret ? Buffer.from('not a real ciphertext at all......').toString('base64') : encryptFor(task.key, APP_SECRET)
        return reply({ status: 2, bot_appid: Number(APP_ID), bot_encrypt_secret: secret, user_openid: OPENID })
      }
      return reply({ status: 1, bot_appid: '0', bot_encrypt_secret: '', user_openid: '' })
    }
    return new Response('{}', { status: 404 })
  }
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lsy-qqbot-login-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const quick = { pollDelayMs: 1 }

describe('decryptSecret', () => {
  it('round-trips what the platform encrypts', () => {
    const key = randomBytes(32).toString('base64')
    expect(decryptSecret(encryptFor(key, APP_SECRET), key)).toBe(APP_SECRET)
  })
  it('refuses a blob that does not authenticate', () => {
    const key = randomBytes(32).toString('base64')
    expect(() => decryptSecret(encryptFor(randomBytes(32).toString('base64'), APP_SECRET), key)).toThrow()
    expect(() => decryptSecret('AAAA', key)).toThrow('too short')
  })
})

describe('loginWithQr', () => {
  it('shows the QR page of the task and returns the decrypted credentials and the scanner\'s openid', async () => {
    const service = new FakeBindService()
    const shown: Array<[string, number]> = []
    const result = await loginWithQr({ fetch: service.fetch, ...quick, showQrCode: (url, attempt) => { shown.push([url, attempt]) } })
    expect(result).toEqual({ appId: APP_ID, appSecret: APP_SECRET, userOpenid: OPENID })
    expect(shown).toEqual([[connectUrl('task-1'), 1]])
    expect(shown[0]![0]).toBe('https://q.qq.com/qqbot/openclaw/connect.html?task_id=task-1&source=dsh-lsy&_wv=2')
  })

  it('replaces an expired code and gives up after the configured number', async () => {
    const service = new FakeBindService()
    service.scanAfter = undefined
    service.expireAfter = 1
    const shown: number[] = []
    await expect(loginWithQr({ fetch: service.fetch, ...quick, maxQrCodes: 2, showQrCode: (_url, attempt) => { shown.push(attempt) } }))
      .rejects.toThrow('expired 2 times')
    expect(shown).toEqual([1, 2])

    const second = new FakeBindService()
    second.expireAfter = 1
    second.expireFirstOnly = true
    second.scanAfter = 2
    // The first task expires on its second poll before it could be scanned; the refreshed one is scanned in time.
    const result = await loginWithQr({ fetch: second.fetch, ...quick, showQrCode: () => {} })
    expect(result.appId).toBe(APP_ID)
    expect(second.tasks.size).toBe(2)
  })

  it('rides out failed polls, then gives up', async () => {
    const service = new FakeBindService()
    service.failPolls = 2
    await expect(loginWithQr({ fetch: service.fetch, ...quick, showQrCode: () => {} })).resolves.toMatchObject({ appId: APP_ID })
    const broken = new FakeBindService()
    broken.failPolls = 99
    await expect(loginWithQr({ fetch: broken.fetch, ...quick, maxFailures: 3, showQrCode: () => {} })).rejects.toThrow('failed 3 times in a row')
  })

  it('times out when nobody scans', async () => {
    const service = new FakeBindService()
    service.scanAfter = undefined
    await expect(loginWithQr({ fetch: service.fetch, ...quick, timeoutMs: 30, showQrCode: () => {} })).rejects.toThrow('timed out')
  })

  it('reports a platform refusal and an undecryptable secret without leaking either', async () => {
    const refused = new FakeBindService()
    refused.failCreate = 'service busy'
    await expect(loginWithQr({ fetch: refused.fetch, showQrCode: () => {} })).rejects.toThrow('could not open a bind task: service busy')
    const garbled = new FakeBindService()
    garbled.garbleSecret = true
    const error = await loginWithQr({ fetch: garbled.fetch, ...quick, showQrCode: () => {} }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LoginError)
    expect((error as Error).message).not.toContain(APP_SECRET)
  })
})

describe('qrPng', () => {
  it('encodes the text as a PNG whose pixels are the QR modules', () => {
    const url = connectUrl('task-1')
    const png = qrPng(url, 4, 4)
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const modules = encode(url, { ecc: 'M', border: 0 }).data
    const side = (modules.length + 8) * 4
    expect(png.readUInt32BE(16)).toBe(side)
    expect(png.readUInt32BE(20)).toBe(side)
    // IDAT follows the 25-byte IHDR chunk after the 8-byte signature.
    const idatLength = png.readUInt32BE(33)
    const pixels = inflateSync(png.subarray(41, 41 + idatLength))
    expect(pixels.length).toBe((side + 1) * side)
    const at = (mx: number, my: number): number => pixels[((my + 4) * 4) * (side + 1) + 1 + (mx + 4) * 4]!
    for (let my = 0; my < modules.length; my += 3) {
      for (let mx = 0; mx < modules.length; mx += 3) expect(at(mx, my)).toBe(modules[my]![mx] === true ? 0 : 255)
    }
    // The quiet zone is white.
    expect(pixels[1]).toBe(255)
  })
})

describe('upsertEnvFile', () => {
  it('replaces its own names, keeps every other line, and leaves the file private', async () => {
    const path = join(dir, '.env')
    writeFileSync(path, 'OPENROUTER_API_KEY=keep-me\nLSY_QQBOT_APP_ID=old\nLSY_GITHUB_TOKEN=also-keep\n', { mode: 0o644 })
    const names = await upsertEnvFile(path, { LSY_QQBOT_APP_ID: 'new-id', LSY_QQBOT_APP_SECRET: 'new-secret' })
    expect(names).toEqual(['LSY_QQBOT_APP_ID', 'LSY_QQBOT_APP_SECRET'])
    expect(readFileSync(path, 'utf8')).toBe('LSY_QQBOT_APP_ID=new-id\nLSY_QQBOT_APP_SECRET=new-secret\nOPENROUTER_API_KEY=keep-me\nLSY_GITHUB_TOKEN=also-keep\n')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
  it('creates a missing file', async () => {
    const path = join(dir, 'fresh.env')
    await upsertEnvFile(path, { A: '1' })
    expect(readFileSync(path, 'utf8')).toBe('A=1\n')
  })
})

describe('runLoginCli', () => {
  const sink = (): { text: string; write(chunk: string): void } => ({ text: '', write(chunk) { this.text += chunk } })

  it('saves the credentials to the env file, saves the QR as a private PNG, and never prints the secret', async () => {
    const service = new FakeBindService()
    const out = sink()
    const err = sink()
    const envFile = join(dir, '.env')
    const pngFile = join(dir, 'qr.png')
    const code = await runLoginCli({
      stdout: out, stderr: err, argv: ['--qr-png', pngFile, '--env-file', envFile], env: { DSH_HOME: dir }, login: { fetch: service.fetch, pollDelayMs: 1 },
    })
    expect(code).toBe(0)
    expect(readFileSync(envFile, 'utf8')).toBe(`LSY_QQBOT_APP_ID=${APP_ID}\nLSY_QQBOT_APP_SECRET=${APP_SECRET}\n`)
    expect(statSync(pngFile).mode & 0o777).toBe(0o600)
    expect(readFileSync(pngFile).subarray(1, 4).toString()).toBe('PNG')
    expect(out.text).toContain(`AppID ${APP_ID}`)
    expect(out.text).toContain(OPENID)
    expect(out.text).toContain(`users: ['${OPENID}']`)
    expect(out.text + err.text).not.toContain(APP_SECRET)
  })

  it('defaults the env file to DSH_HOME and reports failure with a non-zero code', async () => {
    const service = new FakeBindService()
    const out = sink()
    const login = { fetch: service.fetch, pollDelayMs: 1 }
    expect(await runLoginCli({ stdout: out, stderr: sink(), argv: [], env: { DSH_HOME: dir }, login })).toBe(0)
    expect(readFileSync(join(dir, '.env'), 'utf8')).toContain('LSY_QQBOT_APP_SECRET=')
    const broken = new FakeBindService()
    broken.failCreate = 'nope'
    const err = sink()
    const argv = ['--env-file', join(dir, 'x.env')]
    expect(await runLoginCli({ stdout: sink(), stderr: err, argv, login: { fetch: broken.fetch } })).toBe(1)
    expect(err.text).toContain('QQ 登录失败')
  })
})
