import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import type { LsyEventInput } from '@deepseek-ai/dsh-lsy-event-bus'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import GithubSensor, { type Config } from '../src/index.ts'
import { FakeGitHub, commit, release, thread } from './fake-github.ts'

const REL = '/repos/octo/repo/releases?per_page=20'
const TAGS = '/repos/octo/repo/tags?per_page=20'
const COMMITS = '/repos/octo/repo/commits?per_page=20&sha=main'
const NOTIFICATIONS = '/notifications?per_page=50'

const baseConfig: Config = {
  intervalMs: 60_000,
  apiBase: 'https://api.github.test',
  tokenEnv: 'LSY_GITHUB_TOKEN',
  notificationsTokenEnv: 'LSY_GITHUB_NOTIFICATIONS_TOKEN',
  notifications: false,
  repos: [{ repo: 'octo/repo', watch: ['releases'] }],
  timeoutMs: 10_000,
  maxTextChars: 2000,
  perPage: 20,
  maxSeenPerStream: 200,
}

const contexts: Context[] = []

async function harness(gh: FakeGitHub, options: {
  config?: Partial<Config>
  pool?: MemoryMediaPool
  tokens?: Record<string, string>
  fetch?: typeof fetch
} = {}) {
  vi.stubGlobal('fetch', options.fetch ?? gh.fetch)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Timer)
  await ctx.plugin(Storage)
  const pool = options.pool ?? new MemoryMediaPool()
  const backend = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  ctx.effect(() => async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => { await facility.closeAll(); unmount() }
  })
  const tokens = options.tokens ?? { LSY_GITHUB_TOKEN: 'repo-token' }
  ctx.provide('credentials', {
    resolve: async (ref: string) => tokens[ref] === undefined ? undefined : { value: tokens[ref], source: 'env' },
  } as never)
  const published: LsyEventInput[] = []
  ctx.provide('lsyEventBus', { publish: async (event: LsyEventInput) => { published.push(event); return 'accepted' } } as never)
  await ctx.plugin(GithubSensor, Object.assign({}, baseConfig, options.config))
  await vi.advanceTimersByTimeAsync(0)
  return { ctx, published, pool }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'))
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('GithubSensor repository streams', () => {
  it('baselines existing releases on the first poll and publishes only new ones later', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [release(1)])
    const { published } = await harness(gh)
    expect(gh.requestsTo(REL)).toHaveLength(1)
    expect(published).toEqual([])

    gh.set(REL, [release(2), release(1)])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(published.map(event => event.key)).toEqual(['octo/repo:release:2'])
  })

  it('revalidates with If-None-Match and publishes nothing on 304', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [release(1)])
    const { published } = await harness(gh)
    await vi.advanceTimersByTimeAsync(60_000)
    const [first, second] = gh.requestsTo(REL)
    expect(second).toMatchObject({ status: 304, headers: { 'if-none-match': first!.headers['if-none-match'] ?? '"v1"' } })
    expect(second!.headers['if-none-match']).toBe('"v1"')
    expect(published).toEqual([])
  })

  it('publishes new commits and tags oldest first, in configured stream order', async () => {
    const gh = new FakeGitHub()
    gh.set(COMMITS, [commit('c1', 'one')])
    gh.set(TAGS, [{ name: 'v1', commit: { sha: 'c1' } }])
    const { published } = await harness(gh, { config: { repos: [{ repo: 'octo/repo', watch: ['commits', 'tags'], branch: 'main' }] } })
    gh.set(COMMITS, [commit('c3', 'three'), commit('c2', 'two'), commit('c1', 'one')])
    gh.set(TAGS, [{ name: 'v2', commit: { sha: 'c3' } }, { name: 'v1', commit: { sha: 'c1' } }])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(published.map(event => event.key)).toEqual(['octo/repo:commit:c2', 'octo/repo:commit:c3', 'octo/repo:tag:v2'])
  })

  it('skips draft releases', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    const { published } = await harness(gh)
    gh.set(REL, [release(2, { draft: true }), release(3)])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(published.map(event => event.key)).toEqual(['octo/repo:release:3'])
  })

  it('sends the API headers and the repository token', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    await harness(gh)
    expect(gh.requests[0]!.headers).toMatchObject({
      'accept': 'application/vnd.github+json',
      'authorization': 'Bearer repo-token',
      'user-agent': 'dsh-lsy-github-sensor',
      'x-github-api-version': '2022-11-28',
    })
  })

  it('polls without authorization when no repository token is configured', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    await harness(gh, { tokens: {} })
    expect(gh.requests[0]!.headers).not.toHaveProperty('authorization')
  })

  it('keeps polling other repositories when one fails', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    const { published } = await harness(gh, { config: { repos: [{ repo: 'gone/repo', watch: ['releases'] }, { repo: 'octo/repo', watch: ['releases'] }] } })
    gh.set(REL, [release(1)])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(gh.requestsTo('/repos/gone/repo/releases?per_page=20').map(request => request.status)).toEqual([404, 404])
    expect(published.map(event => event.key)).toEqual(['octo/repo:release:1'])
  })

  it('ignores a response body that is not the expected list', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, { unexpected: true })
    const { published } = await harness(gh)
    gh.set(REL, [release(1)])
    await vi.advanceTimersByTimeAsync(60_000)
    // The malformed first response never initialized the cursor, so this poll is the baseline.
    expect(published).toEqual([])
  })

  it('keeps cursors across restarts', async () => {
    const gh = new FakeGitHub()
    const pool = new MemoryMediaPool()
    gh.set(REL, [release(1)])
    const first = await harness(gh, { pool })
    await first.ctx.fiber.dispose()

    gh.set(REL, [release(2), release(1)])
    const second = await harness(gh, { pool })
    expect(second.published.map(event => event.key)).toEqual(['octo/repo:release:2'])
  })

  it('remembers only a bounded number of seen ids per stream', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, Array.from({ length: 5 }, (_, index) => release(index + 1)))
    const { ctx } = await harness(gh, { config: { perPage: 20, maxSeenPerStream: 3 } })
    expect(ctx.lsyGithubSensor.cursor('repo:octo/repo:releases')?.seen).toHaveLength(3)
  })
})

describe('GithubSensor notifications', () => {
  it('polls with If-Modified-Since, honors X-Poll-Interval, and publishes new threads', async () => {
    const gh = new FakeGitHub()
    const headers = { 'x-poll-interval': '120' }
    gh.set(NOTIFICATIONS, [thread('1', '2026-10-21T00:00:00Z')], { headers })
    const { published } = await harness(gh, {
      config: { notifications: true, repos: [] },
      tokens: { LSY_GITHUB_NOTIFICATIONS_TOKEN: 'notif-token' },
    })
    expect(gh.requestsTo(NOTIFICATIONS)).toHaveLength(1)
    expect(gh.requests[0]!.headers['authorization']).toBe('Bearer notif-token')

    gh.set(NOTIFICATIONS, [thread('2', '2026-10-21T00:01:00Z'), thread('1', '2026-10-21T00:00:00Z')], { headers })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(gh.requestsTo(NOTIFICATIONS)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    const requests = gh.requestsTo(NOTIFICATIONS)
    expect(requests).toHaveLength(2)
    expect(requests[1]!.headers['if-modified-since']).toBeDefined()
    expect(published.map(event => event.key)).toEqual(['notification:2:2026-10-21T00:01:00Z'])
  })

  it('skips notifications without a notifications token', async () => {
    const gh = new FakeGitHub()
    gh.set(NOTIFICATIONS, [])
    await harness(gh, { config: { notifications: true, repos: [] } })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(gh.requestsTo(NOTIFICATIONS)).toHaveLength(0)
  })
})

describe('GithubSensor scheduling', () => {
  it('backs off until the rate-limit reset after a 403 with no remaining quota', async () => {
    const gh = new FakeGitHub()
    const reset = String(Date.parse('2026-10-21T00:05:00Z') / 1000)
    gh.set(REL, { message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } })
    await harness(gh)
    expect(gh.requestsTo(REL)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(240_000)
    expect(gh.requestsTo(REL)).toHaveLength(1)
    gh.set(REL, [release(1)])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(gh.requestsTo(REL)).toHaveLength(2)
  })

  it('backs off for retry-after on a secondary rate limit', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, { message: 'secondary rate limit' }, { status: 429, headers: { 'retry-after': '150' } })
    await harness(gh)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(gh.requestsTo(REL)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(gh.requestsTo(REL)).toHaveLength(2)
  })

  it('does not start a tick while the previous one is still running', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    let release_: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release_ = resolve })
    const slow = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      await gate
      return gh.fetch(input, init)
    }
    const { ctx } = await harness(gh)
    vi.stubGlobal('fetch', slow)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    release_?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(gh.requestsTo(REL)).toHaveLength(2)
    expect(ctx.lsyGithubSensor.cursor('repo:octo/repo:releases')?.initialized).toBe(true)
  })

  it('rejects malformed repository names at load', () => {
    expect(() => new GithubSensor(new Context(), Object.assign({}, baseConfig, { repos: [{ repo: 'not-a-repo', watch: ['releases'] }] }))).toThrow('owner/name')
  })
})

describe('GithubSensor failure handling', () => {
  /** `fetch` that answers the first request to `path` with `reply` and serves the rest from `gh`. */
  function onceThen(gh: FakeGitHub, path: string, reply: () => Promise<Response>): typeof fetch {
    let used = false
    return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (!used && `${url.pathname}${url.search}` === path) {
        used = true
        return reply()
      }
      return gh.fetch(input, init)
    }
  }

  function stubOnce(gh: FakeGitHub, path: string, reply: () => Promise<Response>): void {
    vi.stubGlobal('fetch', onceThen(gh, path, reply))
  }

  it('logs and skips network failures, then recovers', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [release(1)])
    const { ctx, published } = await harness(gh)
    for (const failure of [new Error('ECONNRESET'), 'plain failure']) {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercises non-Error rejections from fetch.
      stubOnce(gh, REL, () => Promise.reject(failure))
      await vi.advanceTimersByTimeAsync(60_000)
    }
    vi.stubGlobal('fetch', gh.fetch)
    gh.set(REL, [release(2), release(1)])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(published.map(event => event.key)).toEqual(['octo/repo:release:2'])
    expect(ctx.lsyGithubSensor.cursor('repo:octo/repo:releases')?.initialized).toBe(true)
  })

  it('treats a non-JSON body as malformed', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    const { ctx } = await harness(gh)
    stubOnce(gh, REL, async () => new Response('<html>', { status: 200 }))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ctx.lsyGithubSensor.cursor('repo:octo/repo:releases')?.etag).toBe('"v1"')
  })

  it('stores no validators when the response carries none', async () => {
    const gh = new FakeGitHub()
    const { ctx } = await harness(gh, { fetch: onceThen(gh, REL, async () => new Response(JSON.stringify([release(1)]), { status: 200 })) })
    expect(ctx.lsyGithubSensor.cursor('repo:octo/repo:releases')).toEqual({ seen: ['1'], initialized: true })
  })

  it('retries items whose publish failed on the next poll', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    const { ctx } = await harness(gh)
    const published: string[] = []
    let failures = 1
    ctx.lsyEventBus.publish = async (event: LsyEventInput) => {
      if (failures-- > 0) throw new Error('storage full')
      published.push(event.key)
      return 'accepted'
    }
    gh.set(REL, [release(1)])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(published).toEqual([])
    expect(ctx.lsyGithubSensor.cursor('repo:octo/repo:releases')).toMatchObject({ seen: [], initialized: true })
    expect(ctx.lsyGithubSensor.cursor('repo:octo/repo:releases')).not.toHaveProperty('etag')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(published).toEqual(['octo/repo:release:1'])
  })

  it('logs a forbidden response that is not a rate limit and keeps polling', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, { message: 'Resource not accessible' }, { status: 403 })
    await harness(gh)
    gh.set(REL, { message: 'quota' }, { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(gh.requestsTo(REL).map(request => request.status)).toEqual([403, 403, 403])
  })

  it('stops the remaining streams of a tick after a rate limit', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, { message: 'limited' }, { status: 429, headers: { 'retry-after': '600' } })
    gh.set(TAGS, [])
    await harness(gh, { config: { repos: [{ repo: 'octo/repo', watch: ['releases', 'tags'] }] } })
    expect(gh.requestsTo(TAGS)).toHaveLength(0)
  })

  it('stops quietly when disposed during a request', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    const { ctx } = await harness(gh)
    vi.stubGlobal('fetch', (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('aborted', { cause: init.signal?.reason })) })
    }))
    await vi.advanceTimersByTimeAsync(60_000)
    await ctx.fiber.dispose()
    expect(gh.requestsTo(REL)).toHaveLength(1)
  })

  it('polls the default branch when no branch is configured', async () => {
    const gh = new FakeGitHub()
    gh.set('/repos/octo/repo/commits?per_page=20', [commit('c1', 'one')])
    await harness(gh, { config: { repos: [{ repo: 'octo/repo', watch: ['commits'] }] } })
    expect(gh.requestsTo('/repos/octo/repo/commits?per_page=20')).toHaveLength(1)
  })
})
