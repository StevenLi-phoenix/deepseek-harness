import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { readBuildInfo } from '../src/build-info.ts'
import { Config } from '../src/config.ts'
import { logAction } from '../src/log.ts'
import { Refusal, parseBody, readJson } from '../src/request.ts'
import { TIMED_OUT, httpProbe, isHealthy, isReachable, within } from '../src/probe.ts'
import { mountConsole } from './fixtures.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('fork-console Host half', () => {
  it('registers the four routes on the connection, under the /api sign-in', async () => {
    const { routes } = await mountConsole()
    expect(routes.map(route => [route.path, route.methods, route.requestBody])).toEqual([
      ['/api/fork.overview', ['GET'], 'buffered'],
      ['/api/fork.flow', ['GET'], 'buffered'],
      ['/api/fork.subscriptions', ['GET', 'POST'], 'buffered'],
      ['/api/fork.agents', ['GET', 'POST'], 'buffered'],
    ])
  })

  it('answers an unexpected failure as internal_error without its message', async () => {
    const { ctx, call, logs } = await mountConsole()
    ctx.provide('forkEventBus' as never, { listSubscriptions: () => { throw new Error('SECRET /Users/x') }, batches: () => [] } as never)
    const response = await call('/api/fork.subscriptions')
    expect([response.status, await response.json()]).toEqual([500, { error: 'internal_error' }])
    expect(logs.join('\n')).toContain('GET /api/fork.subscriptions failed: Error')
    expect(logs.join('\n')).not.toContain('SECRET')
  })

  it('names an unexpected failure that is not an Error by a plain class', async () => {
    const { ctx, call, logs } = await mountConsole()
    ctx.provide('forkEventBus' as never, { listSubscriptions: () => { throw 'SECRET /Users/x' }, batches: () => [] } as never)
    const response = await call('/api/fork.subscriptions')
    expect([response.status, await response.json()]).toEqual([500, { error: 'internal_error' }])
    expect(logs.join('\n')).toContain('GET /api/fork.subscriptions failed: error')
    expect(logs.join('\n')).not.toContain('SECRET')
  })

  it('answers the flow route with the activity windows, and refuses a POST to a read-only route', async () => {
    const { call } = await mountConsole()
    const flow = await call('/api/fork.flow')
    expect(flow.status).toBe(200)
    expect(Object.keys((await flow.json()) as object).sort()).toEqual(['changes', 'checkedAt', 'presence', 'recent', 'routes', 'windows'])
    const refused = await call('/api/fork.flow', { method: 'POST', body: {} })
    expect([refused.status, await refused.json()]).toEqual([405, { error: 'invalid_request' }])
  })

  it('has defaults for the Mac mini deployment and a 2 s probe deadline', () => {
    expect(Config({} as never)).toEqual({
      bili: { url: 'http://127.0.0.1:8097' },
      ams: { url: 'http://127.0.0.1:18090' },
      probeTimeoutMs: 2000,
      subscriptions: {
        workspacePath: '/Users/dsh-runtime/work', agentPreset: 'unattended', permissionPreset: 'danger-full-access',
        coalesceSeconds: 60, notifyMaxPerHour: 12, sessionMaxPerHour: 4,
      },
      previewText: '你好，我是魔女的猫猫。这是一条语音试听。',
    })
  })
})

describe('log lines', () => {
  it('logs an error that is neither a refusal nor an Error as an unknown error, and throws it again', async () => {
    const lines: string[] = []
    const log = { info: (line: string) => { lines.push(`info ${line}`) }, warn: (line: string) => { lines.push(`warn ${line}`) } }
    await expect(logAction(log, 'x.act', '', async () => { throw 'plain' })).rejects.toBe('plain')
    await expect(logAction(log, 'x.act', 't1', async () => { throw new Refusal('limit_reached') })).rejects.toBeInstanceOf(Refusal)
    expect(lines.map(line => line.replace(/\d+ ms/, 'N ms'))).toEqual([
      'warn fork-console: x.act -> error unknown (N ms)', 'warn fork-console: x.act t1 -> limit_reached (N ms)',
    ])
  })
})

describe('request bodies', () => {
  it('lets an error that is not a validation failure through', () => {
    const schema = Schema.transform(Schema.string(), () => { throw new RangeError('not a validation error') })
    expect(() => parseBody(schema, 'x')).toThrow(RangeError)
  })

  it('refuses a request with no content type at all', async () => {
    const request = new Request('http://127.0.0.1/x', { method: 'POST', body: new Uint8Array([123, 125]) })
    expect(request.headers.get('content-type')).toBeNull()
    await expect(readJson(request)).rejects.toMatchObject({ code: 'invalid_request', detail: 'content-type' })
  })
})

describe('probes', () => {
  it('classify statuses', () => {
    expect([200, 204, 301, 404, 500, null].map(status => [isHealthy(status), isReachable(status)])).toEqual([
      [true, true], [true, true], [false, true], [false, true], [false, false], [false, false],
    ])
  })

  it('httpProbe turns a failing fetch into null', async () => {
    expect(await httpProbe('http://x', 100, () => Promise.reject(new Error('refused')))).toBeNull()
    expect(await httpProbe('http://x', 100, () => Promise.resolve(new Response('', { status: 503 })))).toBe(503)
  })

  it('httpProbe keeps the status when the unread body cannot be cancelled', async () => {
    const body = new ReadableStream({ cancel() { throw new Error('cancel refused') } })
    expect(await httpProbe('http://x', 100, () => Promise.resolve(new Response(body, { status: 200 })))).toBe(200)
  })

  it('within gives up on work that does not finish and drops its late rejection', async () => {
    const late = new Promise<number>((_resolve, reject) => { setTimeout(() => { reject(new Error('late')) }, 80) })
    expect(await within(late, 20)).toBe(TIMED_OUT)
    expect(await within(Promise.resolve(5), 20)).toBe(5)
    await new Promise(resolve => setTimeout(resolve, 120))
  })
})

describe('readBuildInfo', () => {
  it('names the sha from builds.noindex and the version from the @deepseek-ai/dsh package above the entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'fork-build-'))
    dirs.push(root)
    const build = join(root, 'builds.noindex', '0a1b2c3d4e')
    const lib = join(build, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
    mkdirSync(lib, { recursive: true })
    writeFileSync(join(build, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.2.3' }))
    writeFileSync(join(lib, 'bin.js'), '')
    symlinkSync(build, join(root, 'current'))
    expect(readBuildInfo(join(root, 'current', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))).toEqual({ version: '1.2.3', sha: '0a1b2c3d4e' })
  })

  it('returns nulls when the process has no entry file', () => {
    const argv = process.argv
    process.argv = [argv[0] as string]
    try {
      expect(readBuildInfo()).toEqual({ version: null, sha: null })
    } finally {
      process.argv = argv
    }
  })

  it('stops climbing at the file system root when no package above the entry names the service', () => {
    const root = mkdtempSync(join(tmpdir(), 'fork-build-'))
    dirs.push(root)
    writeFileSync(join(root, 'entry.js'), '')
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'something-else', version: '9.9.9' }))
    expect(readBuildInfo(join(root, 'entry.js'))).toEqual({ version: null, sha: null })
  })

  it('returns nulls for a missing entry and no sha for a source checkout', () => {
    expect(readBuildInfo(undefined)).toEqual({ version: null, sha: null })
    expect(readBuildInfo('/nonexistent/entry.js')).toEqual({ version: null, sha: null })
    expect(readBuildInfo(import.meta.filename).sha).toBeNull()
  })
})
