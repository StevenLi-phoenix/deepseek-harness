/** Shared sensor test fixtures: memory storage, credential and bus doubles, and the fake GitHub API. */
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import type { LsyEventInput } from '@deepseek-ai/dsh-lsy-event-bus'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import GithubSensor, { type Config } from '../src/index.ts'
import type { FakeGitHub } from './fake-github.ts'

export const REL = '/repos/octo/repo/releases?per_page=20'
export const TAGS = '/repos/octo/repo/tags?per_page=20'
export const COMMITS = '/repos/octo/repo/commits?per_page=20&sha=main'
export const NOTIFICATIONS = '/notifications?per_page=50'

export const baseConfig: Config = {
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

/** Options of {@link harness}. */
export interface HarnessOptions {
  config?: Partial<Config>
  pool?: MemoryMediaPool
  /** Credential values by reference; a function value throws on resolve. */
  tokens?: Record<string, string | (() => never)>
  fetch?: typeof fetch
  /** Runs on the root context before the sensor mounts. */
  beforeSensor?: (ctx: Context) => void
}

/**
 * Mount a sensor over memory storage with a recording bus double.
 * @param gh - fake GitHub serving `fetch`.
 * @param options - config overrides, shared pool, tokens, and fetch replacement.
 * @returns context, published events, and the pool.
 */
export async function harness(gh: FakeGitHub, options: HarnessOptions = {}) {
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
    resolve: async (ref: string) => {
      const token = tokens[ref]
      if (typeof token === 'function') token()
      return token === undefined ? undefined : { value: token, source: 'env' }
    },
  } as never)
  const published: LsyEventInput[] = []
  ctx.provide('lsyEventBus', { publish: async (event: LsyEventInput) => { published.push(event); return 'accepted' } } as never)
  options.beforeSensor?.(ctx)
  await ctx.plugin(GithubSensor, Object.assign({}, baseConfig, options.config))
  await vi.advanceTimersByTimeAsync(0)
  return { ctx, sensor: ctx.lsyGithubSensor, published, pool }
}

/** Dispose every context a test mounted. */
export async function disposeAll(): Promise<void> {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
}
