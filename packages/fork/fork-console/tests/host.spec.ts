import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readBuildInfo } from '../src/build-info.ts'
import { Config } from '../src/config.ts'
import { TIMED_OUT, httpProbe, isHealthy, isReachable, within } from '../src/probe.ts'
import { mountConsole } from './fixtures.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('fork-console Host half', () => {
  it('registers the three routes on the connection, under the /api sign-in', async () => {
    const { routes } = await mountConsole()
    expect(routes.map(route => [route.path, route.methods, route.requestBody])).toEqual([
      ['/api/fork.overview', ['GET'], 'buffered'],
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

  it('returns nulls for a missing entry and no sha for a source checkout', () => {
    expect(readBuildInfo(undefined)).toEqual({ version: null, sha: null })
    expect(readBuildInfo('/nonexistent/entry.js')).toEqual({ version: null, sha: null })
    expect(readBuildInfo(import.meta.filename).sha).toBeNull()
  })
})
