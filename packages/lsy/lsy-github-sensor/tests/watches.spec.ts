import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import GithubSensor, { Config } from '../src/index.ts'
import { FakeGitHub, commit, release } from './fake-github.ts'
import { NOTIFICATIONS, REL, TAGS, baseConfig, disposeAll, harness } from './harness.ts'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'))
})

afterEach(async () => {
  await disposeAll()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const OTHER_REL = '/repos/acme/tool/releases?per_page=20'
const OTHER_TAGS = '/repos/acme/tool/tags?per_page=20'
const DEV_COMMITS = '/repos/acme/tool/commits?per_page=20&sha=dev'
const MAIN_COMMITS = '/repos/acme/tool/commits?per_page=20&sha=main'

describe('GithubSensor agent watches', () => {
  it('records a baseline right away and publishes only later items', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    gh.set(OTHER_REL, [release(1), release(2)])
    const { sensor, published } = await harness(gh)
    const view = await sensor.watch('acme-releases', { repo: 'acme/tool', watch: ['releases'] })
    expect(view).toMatchObject({ origin: 'agent', ref: 'acme-releases', repo: 'acme/tool', watch: ['releases'], createdAt: Date.now() })
    await vi.advanceTimersByTimeAsync(0)
    expect(gh.requestsTo(OTHER_REL)).toHaveLength(1)
    expect(sensor.cursor('repo:acme/tool:releases')?.initialized).toBe(true)
    expect(published).toEqual([])

    expect(sensor.watchedRepos()[1]!.streams).toEqual([{ stream: 'releases', id: 'repo:acme/tool:releases', baseline: true, lastPoll: { at: Date.now(), ok: true } }])

    gh.set(OTHER_REL, [release(3), release(2), release(1)])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(published.map(event => event.key)).toEqual(['acme/tool:release:3'])
  })

  it('polls a stream watched by both config and an agent once per tick', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    const { sensor } = await harness(gh)
    await sensor.watch('mine', { repo: 'octo/repo', watch: ['releases'] })
    await vi.advanceTimersByTimeAsync(60_000)
    // Initial tick, the tick the watch started, and one interval tick.
    expect(gh.requestsTo(REL)).toHaveLength(3)
  })

  it('keeps separate cursors for commits on different branches', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    gh.set(MAIN_COMMITS, [commit('m1', 'main one')])
    gh.set(DEV_COMMITS, [commit('d1', 'dev one')])
    const { sensor, published } = await harness(gh)
    await sensor.watch('main', { repo: 'acme/tool', watch: ['commits'], branch: 'main' })
    await sensor.watch('dev', { repo: 'acme/tool', watch: ['commits'], branch: 'dev' })
    await vi.advanceTimersByTimeAsync(0)
    expect(sensor.cursor('repo:acme/tool:commits@main')?.seen).toEqual(['m1'])
    expect(sensor.cursor('repo:acme/tool:commits@dev')?.seen).toEqual(['d1'])

    gh.set(DEV_COMMITS, [commit('d2', 'dev two'), commit('d1', 'dev one')])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(published.map(event => event.key)).toEqual(['acme/tool:commit:d2'])
  })

  it('polls a watch created during a running tick right after that tick', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    gh.set(OTHER_REL, [release(1)])
    let open: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { open = resolve })
    const { sensor } = await harness(gh)
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => { await gate; return gh.fetch(input, init) })
    await vi.advanceTimersByTimeAsync(60_000)
    await sensor.watch('late', { repo: 'acme/tool', watch: ['releases'] })
    await sensor.watch('later', { repo: 'acme/tool', watch: ['releases', 'tags'] })
    expect(gh.requestsTo(OTHER_REL)).toHaveLength(0)
    open?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(gh.requestsTo(OTHER_REL)).toHaveLength(1)
    expect(gh.requestsTo(OTHER_TAGS)).toHaveLength(1)
  })

  it('keeps agent watches across restarts', async () => {
    const gh = new FakeGitHub()
    const pool = new MemoryMediaPool()
    gh.set(REL, [])
    gh.set(OTHER_REL, [release(1)])
    const first = await harness(gh, { pool })
    await first.sensor.watch('acme', { repo: 'acme/tool', watch: ['releases'] })
    await vi.advanceTimersByTimeAsync(0)
    await first.ctx.fiber.dispose()

    gh.set(OTHER_REL, [release(2), release(1)])
    const second = await harness(gh, { pool })
    expect(second.sensor.watchedRepos().map(entry => [entry.origin, entry.ref, entry.repo])).toEqual([
      ['config', undefined, 'octo/repo'],
      ['agent', 'acme', 'acme/tool'],
    ])
    expect(second.published.map(event => event.key)).toEqual(['acme/tool:release:2'])
  })

  it.each([
    ['an empty ref', ' ', { repo: 'acme/tool', watch: ['releases'] }, /ref must be non-empty/],
    ['a repository that is not owner/name', 'x', { repo: 'acme', watch: ['releases'] }, /must be owner\/name/],
    ['no streams', 'x', { repo: 'acme/tool', watch: [] }, /at least one of releases, tags, commits/],
    ['an unknown stream', 'x', { repo: 'acme/tool', watch: ['issues'] }, /at least one of releases, tags, commits/],
    ['a blank branch', 'x', { repo: 'acme/tool', watch: ['commits'], branch: ' ' }, /branch must be non-empty/],
    ['a branch without commits', 'x', { repo: 'acme/tool', watch: ['releases'], branch: 'main' }, /branch applies only to the commits stream/],
  ])('rejects %s', async (_label, ref, spec, message) => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    const { sensor } = await harness(gh)
    await expect(sensor.watch(ref, spec as never)).rejects.toThrow(message)
    expect(sensor.watchedRepos()).toHaveLength(1)
  })

  it('drops repeated streams', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    const { sensor } = await harness(gh)
    expect(await sensor.watch('x', { repo: 'acme/tool', watch: ['tags', 'tags', 'releases'] })).toMatchObject({ watch: ['tags', 'releases'] })
  })
})

describe('GithubSensor unwatch', () => {
  it('removes the watch and forgets its cursors so a later watch baselines again', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    gh.set(OTHER_REL, [release(1)])
    const { sensor, published } = await harness(gh)
    await sensor.watch('acme', { repo: 'acme/tool', watch: ['releases'] })
    await vi.advanceTimersByTimeAsync(0)
    expect(await sensor.unwatch('acme')).toBe(true)
    expect(sensor.cursor('repo:acme/tool:releases')).toBeUndefined()
    expect(await sensor.unwatch('acme')).toBe(false)

    gh.set(OTHER_REL, [release(3), release(2), release(1)])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(gh.requestsTo(OTHER_REL)).toHaveLength(1)
    await sensor.watch('acme', { repo: 'acme/tool', watch: ['releases'] })
    await vi.advanceTimersByTimeAsync(0)
    expect(published).toEqual([])
  })

  it('keeps cursors of streams that config or another watch still polls', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    gh.set(OTHER_REL, [])
    const { sensor } = await harness(gh)
    await sensor.watch('dup-config', { repo: 'octo/repo', watch: ['releases'] })
    await sensor.watch('a', { repo: 'acme/tool', watch: ['releases'] })
    await sensor.watch('b', { repo: 'acme/tool', watch: ['releases'] })
    await vi.advanceTimersByTimeAsync(0)
    await sensor.unwatch('dup-config')
    await sensor.unwatch('a')
    expect(sensor.cursor('repo:octo/repo:releases')?.initialized).toBe(true)
    expect(sensor.cursor('repo:acme/tool:releases')?.initialized).toBe(true)
  })

  it('forgets the cursors of streams a replaced watch no longer polls', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    gh.set(OTHER_REL, [])
    gh.set(OTHER_TAGS, [])
    const { sensor } = await harness(gh)
    await sensor.watch('acme', { repo: 'acme/tool', watch: ['releases', 'tags'] })
    await vi.advanceTimersByTimeAsync(0)
    await sensor.watch('acme', { repo: 'acme/tool', watch: ['tags'] })
    expect(sensor.cursor('repo:acme/tool:releases')).toBeUndefined()
    expect(sensor.cursor('repo:acme/tool:tags')?.initialized).toBe(true)
    expect(sensor.watchedRepos().filter(entry => entry.ref === 'acme')).toHaveLength(1)
  })

  it('does not write the cursor of a stream unwatched while its request was in flight', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    gh.set(OTHER_REL, [release(1)])
    const { sensor } = await harness(gh)
    let open: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { open = resolve })
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      if (input.endsWith(OTHER_REL)) await gate
      return gh.fetch(input, init)
    })
    await sensor.watch('acme', { repo: 'acme/tool', watch: ['releases'] })
    await vi.advanceTimersByTimeAsync(0)
    await sensor.unwatch('acme')
    open?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(gh.requestsTo(OTHER_REL)).toHaveLength(1)
    expect(sensor.cursor('repo:acme/tool:releases')).toBeUndefined()
  })
})

describe('GithubSensor watchedRepos', () => {
  it('reports each stream\'s baseline and latest poll', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, { message: 'limited' }, { status: 429, headers: { 'retry-after': '600' } })
    const { sensor } = await harness(gh, { config: { repos: [{ repo: 'octo/repo', watch: ['releases', 'tags'] }] } })
    await sensor.watch('acme', { repo: 'acme/tool', watch: ['commits'], branch: 'main' })
    await vi.advanceTimersByTimeAsync(0)
    expect(sensor.watchedRepos()).toEqual([
      {
        origin: 'config',
        repo: 'octo/repo',
        watch: ['releases', 'tags'],
        streams: [
          { stream: 'releases', id: 'repo:octo/repo:releases', baseline: false, lastPoll: { at: Date.now(), ok: false, detail: 'rate limited (HTTP 429)' } },
          { stream: 'tags', id: 'repo:octo/repo:tags', baseline: false },
        ],
      },
      {
        origin: 'agent',
        ref: 'acme',
        repo: 'acme/tool',
        watch: ['commits'],
        branch: 'main',
        createdAt: Date.now(),
        streams: [{ stream: 'commits', id: 'repo:acme/tool:commits@main', baseline: false }],
      },
    ])
  })

  it('lists only configured repositories before its storage domain opens', async () => {
    // Not registered for teardown: disposal would wait for the never-opening domain.
    const ctx = new Context()
    await ctx.plugin(Timer)
    ctx.provide('storageDomain', { open: () => new Promise(() => {}) } as never)
    ctx.provide('credentials', { resolve: async () => undefined } as never)
    ctx.provide('lsyEventBus', {} as never)
    await ctx.plugin(GithubSensor, baseConfig)
    expect(ctx.lsyGithubSensor.watchedRepos()).toEqual([
      { origin: 'config', repo: 'octo/repo', watch: ['releases'], streams: [{ stream: 'releases', id: 'repo:octo/repo:releases', baseline: false }] },
    ])
  })

  it('reports network failures, rate limits, malformed bodies, and failed publishes', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    const { ctx, sensor } = await harness(gh)
    const lastPoll = () => sensor.watchedRepos()[0]!.streams[0]!.lastPoll
    vi.stubGlobal('fetch', async () => { throw new Error('ECONNRESET') })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(lastPoll()).toMatchObject({ ok: false, detail: 'request failed: ECONNRESET' })

    vi.stubGlobal('fetch', gh.fetch)
    gh.set(REL, { message: 'nope' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(lastPoll()).toMatchObject({ ok: false, detail: 'unexpected response body' })

    gh.set(REL, [release(1)])
    ctx.lsyEventBus.publish = async () => { throw new Error('full') }
    await vi.advanceTimersByTimeAsync(60_000)
    expect(lastPoll()).toMatchObject({ ok: false, detail: 'publish failed' })

    gh.set(REL, { message: 'gone' }, { status: 404 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(lastPoll()).toMatchObject({ ok: false, detail: 'HTTP 404' })

    gh.set(REL, { message: 'slow down' }, { status: 429, headers: { 'retry-after': '30' } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(lastPoll()).toMatchObject({ ok: false, detail: 'rate limited (HTTP 429)' })
  })
})

describe('GithubSensor probe', () => {
  const REPO = '/repos/acme/tool'

  it('returns the canonical name, visibility, and default branch with the token', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    gh.set(REPO, { full_name: 'Acme/Tool', private: true, default_branch: 'trunk', extra: 1 })
    const { sensor } = await harness(gh)
    expect(await sensor.probe('acme/tool')).toEqual({ ok: true, fullName: 'Acme/Tool', private: true, defaultBranch: 'trunk' })
    expect(gh.requestsTo(REPO)[0]!.headers['authorization']).toBe('Bearer repo-token')
  })

  it('probes without authorization when no token is configured', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    gh.set(REPO, { full_name: 'acme/tool', private: false, default_branch: 'main' })
    const { sensor } = await harness(gh, { tokens: {} })
    expect(await sensor.probe('acme/tool')).toMatchObject({ ok: true })
    expect(gh.requestsTo(REPO)[0]!.headers).not.toHaveProperty('authorization')
  })

  it('reports HTTP failures with GitHub\'s message', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    const { sensor } = await harness(gh)
    expect(await sensor.probe('acme/tool')).toEqual({ ok: false, status: 404, message: 'HTTP 404: Not Found' })
  })

  it('reports HTTP failures without a JSON message', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    const { sensor } = await harness(gh, { fetch: async () => new Response('<html>', { status: 502, statusText: 'Bad Gateway' }) })
    expect(await sensor.probe('acme/tool')).toEqual({ ok: false, status: 502, message: 'HTTP 502: Bad Gateway' })
    vi.stubGlobal('fetch', async () => new Response(null, { status: 500 }))
    expect(await sensor.probe('acme/tool')).toEqual({ ok: false, status: 500, message: 'HTTP 500' })
  })

  it('reports malformed bodies, network errors, and invalid names without throwing', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    gh.set(REPO, { name: 'tool' })
    const { sensor } = await harness(gh)
    expect(await sensor.probe('acme/tool')).toEqual({ ok: false, status: 200, message: 'unexpected response body' })
    expect(await sensor.probe('not a repo')).toEqual({ ok: false, status: 0, message: 'repository must be owner/name' })
    for (const failure of [new Error('ENOTFOUND'), 'plain failure']) {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercises non-Error rejections from fetch.
      vi.stubGlobal('fetch', () => Promise.reject(failure))
      expect(await sensor.probe('acme/tool')).toEqual({ ok: false, status: 0, message: `request failed: ${String(failure).replace('Error: ', '')}` })
    }
  })

  it('honors the caller\'s abort signal', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    const { sensor } = await harness(gh)
    vi.stubGlobal('fetch', (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
    }))
    const controller = new AbortController()
    const pending = sensor.probe('acme/tool', controller.signal)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    expect(await pending).toEqual({ ok: false, status: 0, message: 'request failed: aborted' })
  })
})

describe('GithubSensor credentials', () => {
  it('reports which tokens resolve without their values', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    const { sensor } = await harness(gh, { tokens: { LSY_GITHUB_TOKEN: 'secret-value', LSY_GITHUB_NOTIFICATIONS_TOKEN: '' } })
    const status = await sensor.credentialStatus()
    expect(status).toEqual({
      token: { ref: 'LSY_GITHUB_TOKEN', configured: true },
      notificationsToken: { ref: 'LSY_GITHUB_NOTIFICATIONS_TOKEN', configured: false },
      notifications: false,
    })
    expect(JSON.stringify(status)).not.toContain('secret-value')
  })

  it('treats a credential store failure as not configured and warns once', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    let root: Context | undefined
    const warn = vi.fn()
    const { sensor } = await harness(gh, {
      tokens: { LSY_GITHUB_TOKEN: () => { throw new Error('keychain locked') } },
      beforeSensor: (ctx) => { root = ctx; vi.spyOn(ctx.logger, 'warn').mockImplementation(warn) },
    })
    expect(root).toBeDefined()
    expect((await sensor.credentialStatus()).token.configured).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(gh.requestsTo(REL)[0]!.headers).not.toHaveProperty('authorization')
    expect(warn.mock.calls.filter(([message]) => String(message).includes('keychain locked'))).toHaveLength(1)
  })
})

describe('GithubSensor notifications default', () => {
  it('polls notifications unless configured off', () => {
    // Every field has a default; the schema's input type still names them all.
    expect(Config({} as never).notifications).toBe(true)
  })

  it('logs a missing notifications token once at info and skips the stream', async () => {
    const gh = new FakeGitHub()
    gh.set(NOTIFICATIONS, [])
    gh.set(TAGS, [])
    const info = vi.fn()
    const warn = vi.fn()
    await harness(gh, {
      config: { notifications: true, repos: [] },
      beforeSensor: (ctx) => {
        vi.spyOn(ctx.logger, 'info').mockImplementation(info)
        vi.spyOn(ctx.logger, 'warn').mockImplementation(warn)
      },
    })
    await vi.advanceTimersByTimeAsync(180_000)
    expect(gh.requestsTo(NOTIFICATIONS)).toHaveLength(0)
    expect(info.mock.calls.filter(([message]) => String(message).includes('LSY_GITHUB_NOTIFICATIONS_TOKEN'))).toHaveLength(1)
    expect(warn.mock.calls.filter(([message]) => String(message).includes('LSY_GITHUB_NOTIFICATIONS_TOKEN'))).toHaveLength(0)
  })
})
