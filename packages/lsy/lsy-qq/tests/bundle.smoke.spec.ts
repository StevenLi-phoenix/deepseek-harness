/**
 * The deployed artifact: the single-file `qq-recorder.mjs` the AMS declaration runs with plain node. It is built with the
 * deploy config, started with the environment AMS gives it, and judged from outside: health probe, handshake, a clean exit
 * on SIGTERM, and a build that comes out byte for byte the same twice (the declaration is pinned to its hash).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { HelloDto, PROTOCOL_HEADER } from '../src/protocol.ts'

const ROOT = resolve(import.meta.dirname, '../../../..')
const TOKEN = 'smoke-token-0123456789abcdef'
const ONEBOT = 'onebot-secret-0123456789'
const out = mkdtempSync(join(tmpdir(), 'qq-recorder-build-'))
const bundle = join(out, 'one', 'qq-recorder.mjs')
const children: ChildProcess[] = []
const dirs: string[] = [out]

function build(dir: string): string {
  execFileSync(join(ROOT, 'node_modules/.bin/tsdown'), ['-c', 'lsy/deploy/qq-recorder/tsdown.config.ts'], { cwd: ROOT, env: { ...process.env, QQ_RECORDER_OUT: dir }, stdio: 'pipe' })
  return join(dir, 'qq-recorder.mjs')
}

beforeAll(() => { build(join(out, 'one')) }, 60_000)
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  for (const dir of dirs.splice(1)) rmSync(dir, { recursive: true, force: true })
})

function freePort(): Promise<number> {
  return new Promise((done) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port
      probe.close(() => { done(port) })
    })
  })
}

function get(socketPath: string, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = request({ socketPath, path, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => { done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }) })
    })
    req.on('error', fail)
    req.end()
  })
}

async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'qq-recorder-run-'))
  dirs.push(dir)
  const port = await freePort()
  const socket = join(dir, 'run', 'qq-recorder.sock')
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', bundle], {
    cwd: dir,
    // The environment AMS gives a service: nothing else of this process's.
    env: { PATH: process.env['PATH'] ?? '', QQ_RECORDER_DATA_DIR: join(dir, 'data'), QQ_RECORDER_SOCKET: socket, PORT_health: String(port), QQ_RECORDER_TOKEN: TOKEN, LSY_QQ_ONEBOT_TOKEN: ONEBOT, QQ_RECORDER_BUILD: 'smoke' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => { stdout += String(chunk) })
  child.stderr?.on('data', (chunk: Buffer) => { stderr += String(chunk) })
  const exited = new Promise<number | null>(done => child.once('exit', (code) => { done(code) }))
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`the recorder did not come up: ${stderr}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return { child, port, socket, dir, exited, logs: () => ({ stdout, stderr }) }
}

describe('the built qq-recorder.mjs under plain node', () => {
  it('is one self-contained file with every dependency inlined', () => {
    expect(statSync(bundle).size).toBeGreaterThan(50_000)
    const text = readFileSync(bundle, 'utf8')
    expect(text).not.toMatch(/(?:from|import\()\s*['"](?:ws|zod)['"]/)
    expect(text).not.toMatch(/(?:from|import\()\s*['"](?:@deepseek-ai\/|\.\.?\/)/)
  })

  it('answers the health probe, the authenticated handshake, and refuses a request without the token', async () => {
    const run = await start()
    expect(await (await fetch(`http://127.0.0.1:${run.port}/healthz`)).json()).toEqual({ ok: true })
    const hello = await get(run.socket, '/v1/hello', { authorization: `Bearer ${TOKEN}`, [PROTOCOL_HEADER]: 'qq-recorder/1.0' })
    expect(hello.status).toBe(200)
    expect(HelloDto.parse(JSON.parse(hello.body))).toMatchObject({ protocol: { name: 'qq-recorder', major: 1, minor: 1 }, build: 'smoke' })
    expect((await get(run.socket, '/v1/hello', {})).status).toBe(401)
    expect(statSync(run.socket).mode & 0o777).toBe(0o600)
    // Until DSH pushes the settings it waits and does not connect anywhere.
    expect(JSON.parse((await get(run.socket, '/v1/status', { authorization: `Bearer ${TOKEN}` })).body)).toMatchObject({ connection: { state: 'waiting-config' }, configRevision: null })
  })

  it('exits 0 within five seconds of SIGTERM, with nothing on stderr and no secret in its logs', async () => {
    const run = await start()
    const started = Date.now()
    run.child.kill('SIGTERM')
    expect(await run.exited).toBe(0)
    expect(Date.now() - started).toBeLessThan(5000)
    const { stdout, stderr } = run.logs()
    expect(stderr).toBe('')
    expect(stdout).toContain('SIGTERM')
    for (const line of stdout.trim().split('\n')) expect(JSON.parse(line)).toMatchObject({ service: 'qq-recorder' })
    expect(stdout + stderr).not.toContain(TOKEN)
    expect(stdout + stderr).not.toContain(ONEBOT)
    mkdirSync(run.dir, { recursive: true })
  })

  it('does not start without its token, and says why on stderr with a non-zero exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qq-recorder-bad-'))
    dirs.push(dir)
    const child = spawn(process.execPath, [bundle], { env: { PATH: process.env['PATH'] ?? '', QQ_RECORDER_DATA_DIR: dir, QQ_RECORDER_SOCKET: join(dir, 's.sock') }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += String(chunk) })
    const code = await new Promise<number | null>((done) => { child.once('exit', (c) => { done(c) }) })
    expect(code).toBe(1)
    expect(stderr).toContain('QQ_RECORDER_TOKEN is not set')
  })

  it('builds byte for byte the same twice, because the AMS declaration is pinned to the file\'s hash', () => {
    const second = build(join(out, 'two'))
    const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
    expect(sha(second)).toBe(sha(bundle))
  }, 60_000)
})
