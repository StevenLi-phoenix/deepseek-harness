/** GitHub polling sensor: publishes new releases, tags, commits, and notification updates to the lsy event bus. */

import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { LsyEventInput } from '@deepseek-ai/dsh-lsy-event-bus'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import z from '@deepseek-ai/schemastery'
import { commitEvent, notificationEvent, parseCommits, parseReleases, parseTags, parseThreads, releaseEvent, tagEvent } from './github.ts'
import { sensorDomain, type StreamCursor } from './storage.ts'

export * from './github.ts'
export type * from './storage.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    lsyGithubSensor: GithubSensor
  }
}

/** Per-repository streams. */
export type RepoStream = 'releases' | 'commits' | 'tags'

/** One watched repository. */
export interface RepoWatch {
  /** `owner/name`. */
  repo: string
  /** Streams to poll, published in this order within one tick. */
  watch: RepoStream[]
  /** Branch for `commits`; the default branch when unset. */
  branch?: string
}

/** Sensor configuration. */
export interface Config {
  /** Poll period in milliseconds. */
  intervalMs: number
  /** REST API origin. */
  apiBase: string
  /** Credential reference for repository reads (a fine-grained read-only token). */
  tokenEnv: string
  /** Credential reference for `/notifications` (a classic token with the `notifications` scope). */
  notificationsTokenEnv: string
  /** Poll the authenticated user's notification threads. */
  notifications: boolean
  /** Watched repositories. */
  repos: RepoWatch[]
  /** Per-request deadline in milliseconds. */
  timeoutMs: number
  /** Characters of release notes and commit messages kept in events. */
  maxTextChars: number
  /** `per_page` of repository list requests; more new items than this between polls are missed. */
  perPage: number
  /** Seen ids remembered per stream. */
  maxSeenPerStream: number
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  intervalMs: z.natural().min(1000).default(60_000),
  apiBase: z.string().default('https://api.github.com'),
  tokenEnv: z.string().role('credential-ref').default('LSY_GITHUB_TOKEN'),
  notificationsTokenEnv: z.string().role('credential-ref').default('LSY_GITHUB_NOTIFICATIONS_TOKEN'),
  notifications: z.boolean().default(false),
  repos: z.array(z.object({
    repo: z.string().required(),
    watch: z.array(z.union(['releases', 'commits', 'tags'] as const)).default(['releases']),
    branch: z.string(),
  })).default([]),
  timeoutMs: z.natural().min(1).default(20_000),
  maxTextChars: z.natural().min(1).default(2000),
  perPage: z.natural().min(1).max(100).default(20),
  maxSeenPerStream: z.natural().min(1).default(200),
})

const REPO_NAME = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
const NOTIFICATIONS_STREAM = 'notifications'

/** One identified item of a stream response; the event is built only when the item is new. */
interface StreamItem {
  id: string
  event: () => LsyEventInput
}

/** How one stream is fetched and read, with the item type erased. */
interface Stream {
  id: string
  path: string
  token: string | undefined
  /** Items newest first, or undefined for a malformed body. */
  read: (body: unknown) => StreamItem[] | undefined
}

/**
 * Bind a typed parser, identity, and event mapping into a stream.
 * @param id - stream id and cursor key.
 * @param path - request path including the query string.
 * @param token - bearer token, or undefined to poll unauthenticated.
 * @param parse - list parser.
 * @param identify - stable id of one item within the stream.
 * @param toEvent - event mapping of one item.
 * @returns type-erased stream.
 */
function stream<T>(
  id: string,
  path: string,
  token: string | undefined,
  parse: (body: unknown) => T[] | undefined,
  identify: (item: T) => string,
  toEvent: (item: T) => LsyEventInput,
): Stream {
  return { id, path, token, read: body => parse(body)?.map(item => ({ id: identify(item), event: () => toEvent(item) })) }
}

/** Fail at load on configuration that cannot be polled. */
function assertConfig(config: Config): void {
  for (const watch of config.repos) {
    if (!REPO_NAME.test(watch.repo)) throw new Error(`lsy-github-sensor: repo "${watch.repo}" must be owner/name`)
  }
}

/** Human-readable error text. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Seconds from a header, or undefined when absent or not a positive number. */
function headerSeconds(response: Response, name: string): number | undefined {
  const value = Number(response.headers.get(name) ?? Number.NaN)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Polls GitHub on a fixed period with conditional requests and publishes
 * what is new since the previous poll. The first successful poll of a stream
 * only records a baseline.
 */
export class GithubSensor extends Service {
  static inject = ['timer', 'storageDomain', 'credentials', 'lsyEventBus']
  static Config = Config

  private readonly ready: Promise<Domain<typeof sensorDomain>>
  private readonly tokenRef: CredentialRef
  private readonly notificationsRef: CredentialRef
  private readonly abort = new AbortController()
  private domain: Domain<typeof sensorDomain> | undefined
  private current: Promise<void> | undefined
  private backoffUntil = 0
  private stopping = false
  private readonly warned = new Set<string>()

  /**
   * @param ctx - Host services owning timers, storage, credentials, and the bus.
   * @param config - Watched repositories, tokens, and pacing.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'lsyGithubSensor')
    assertConfig(config)
    this.tokenRef = credentialRef(config.tokenEnv)
    this.notificationsRef = credentialRef(config.notificationsTokenEnv)
    this.ready = ctx.storageDomain.open(sensorDomain)

    ctx.effect(async () => {
      const domain = await this.ready
      this.domain = domain
      const cleanup = ctx.effect(() => async () => {
        this.stopping = true
        this.abort.abort(new Error('lsy-github-sensor is stopping'))
        await this.current
        await domain.close()
      }, 'lsyGithubSensor.lifecycle()')
      this.startTick()
      return cleanup
    }, 'lsyGithubSensor.init()')
    ctx.interval(() => { this.startTick() }, config.intervalMs)
  }

  /**
   * Stored cursor of one stream.
   * @param stream - `repo:<owner/name>:<kind>` or `notifications`.
   * @returns cursor, or undefined before the first poll.
   */
  cursor(stream: string): StreamCursor | undefined {
    return this.domain?.table('cursors').get(stream)
  }

  /** Start one tick unless one is running, the domain is not open, or the sensor is stopping. */
  private startTick(): void {
    if (this.current !== undefined || this.domain === undefined || this.stopping) return
    this.current = this.tick(this.domain).finally(() => { this.current = undefined })
  }

  /** Poll every configured stream once, sequentially. */
  private async tick(domain: Domain<typeof sensorDomain>): Promise<void> {
    if (Date.now() < this.backoffUntil) return
    const token = (await this.ctx.credentials.resolve(this.tokenRef))?.value
    if (token === undefined) this.warnOnce('token', `lsy-github-sensor: ${this.config.tokenEnv} is not configured; polling unauthenticated (60 requests/hour)`)
    for (const watch of this.config.repos) {
      for (const stream of watch.watch) {
        await this.poll(domain, this.repoStream(watch, stream, token))
      }
    }
    if (this.config.notifications) {
      const notificationsToken = (await this.ctx.credentials.resolve(this.notificationsRef))?.value
      if (notificationsToken === undefined) {
        this.warnOnce('notifications', `lsy-github-sensor: ${this.config.notificationsTokenEnv} is not configured; skipping notifications`)
        return
      }
      await this.poll(domain, stream(
        NOTIFICATIONS_STREAM,
        '/notifications?per_page=50',
        notificationsToken,
        parseThreads,
        thread => `${thread.id}:${thread.updated_at}`,
        notificationEvent,
      ))
    }
  }

  /** Build one repository stream. */
  private repoStream(watch: RepoWatch, kind: RepoStream, token: string | undefined): Stream {
    const id = `repo:${watch.repo}:${kind}`
    const base = `/repos/${watch.repo}/${kind}?per_page=${this.config.perPage}`
    switch (kind) {
      case 'releases':
        return stream(id, base, token, parseReleases, release => String(release.id),
          release => releaseEvent(watch.repo, release, this.config.maxTextChars))
      case 'tags':
        return stream(id, base, token, parseTags, tag => tag.name, tag => tagEvent(watch.repo, tag))
      case 'commits': {
        const branch = watch.branch === undefined ? '' : `&sha=${encodeURIComponent(watch.branch)}`
        return stream(id, `${base}${branch}`, token, parseCommits, commit => commit.sha, commit => commitEvent(watch.repo, commit, this.config.maxTextChars))
      }
    }
  }

  /** Fetch one stream conditionally and publish its new items oldest first. */
  private async poll(domain: Domain<typeof sensorDomain>, spec: Stream): Promise<void> {
    if (this.stopping || Date.now() < this.backoffUntil) return
    const cursors = domain.table('cursors')
    const cursor: StreamCursor = cursors.get(spec.id) ?? { seen: [], initialized: false }
    if (cursor.nextPollAt !== undefined && Date.now() < cursor.nextPollAt) return

    let response: Response
    try {
      response = await fetch(`${this.config.apiBase}${spec.path}`, {
        headers: {
          'accept': 'application/vnd.github+json',
          'user-agent': 'dsh-lsy-github-sensor',
          'x-github-api-version': '2022-11-28',
          ...(spec.token === undefined ? {} : { authorization: `Bearer ${spec.token}` }),
          ...(cursor.etag === undefined ? {} : { 'if-none-match': cursor.etag }),
          ...(cursor.lastModified === undefined ? {} : { 'if-modified-since': cursor.lastModified }),
        },
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(this.config.timeoutMs), this.abort.signal]),
      })
    } catch (error: unknown) {
      if (!this.abort.signal.aborted) this.ctx.logger.warn(`lsy-github-sensor: ${spec.id}: request failed: ${errorText(error)}`)
      return
    }

    const pollInterval = headerSeconds(response, 'x-poll-interval')
    const nextPollAt = pollInterval === undefined ? {} : { nextPollAt: Date.now() + pollInterval * 1000 }
    if (response.status === 304) {
      await cursors.put(spec.id, { ...cursor, ...nextPollAt })
      return
    }
    if (this.handleRateLimit(spec.id, response)) return
    if (!response.ok) {
      this.ctx.logger.warn(`lsy-github-sensor: ${spec.id}: HTTP ${response.status}`)
      return
    }
    const items = spec.read(await response.json().catch(() => undefined))
    if (items === undefined) {
      this.ctx.logger.warn(`lsy-github-sensor: ${spec.id}: unexpected response body`)
      return
    }

    const seen = new Set(cursor.seen)
    const fresh = items.filter(item => !seen.has(item.id))
    if (!cursor.initialized) {
      this.ctx.logger.info(`lsy-github-sensor: ${spec.id}: baseline of ${items.length} item(s)`)
    } else if (!await this.publishAll(spec.id, fresh.toReversed())) {
      // Drop the validators so the next poll refetches and retries; the bus dedupes what did get through.
      await cursors.put(spec.id, { seen: cursor.seen, initialized: true, ...nextPollAt })
      return
    }
    const ids = items.map(item => item.id)
    const current = new Set(ids)
    const etag = response.headers.get('etag')
    const lastModified = response.headers.get('last-modified')
    await cursors.put(spec.id, {
      ...(etag === null ? {} : { etag }),
      ...(lastModified === null ? {} : { lastModified }),
      seen: [...ids, ...cursor.seen.filter(id => !current.has(id))].slice(0, this.config.maxSeenPerStream),
      initialized: true,
      ...nextPollAt,
    })
    if (fresh.length > 0 && cursor.initialized) this.ctx.logger.info(`lsy-github-sensor: ${spec.id}: ${fresh.length} new item(s)`)
  }

  /** Publish items in order; false after the first failure. */
  private async publishAll(stream: string, items: readonly StreamItem[]): Promise<boolean> {
    for (const item of items) {
      try {
        await this.ctx.lsyEventBus.publish(item.event())
      } catch (error: unknown) {
        this.ctx.logger.warn(`lsy-github-sensor: ${stream}: publish failed: ${errorText(error)}`)
        return false
      }
    }
    return true
  }

  /** Back off all polling on a primary or secondary rate limit; true when the response was one. */
  private handleRateLimit(stream: string, response: Response): boolean {
    if (response.status !== 403 && response.status !== 429) return false
    const retryAfter = headerSeconds(response, 'retry-after')
    const reset = headerSeconds(response, 'x-ratelimit-reset')
    const exhausted = response.headers.get('x-ratelimit-remaining') === '0'
    let until: number | undefined
    if (retryAfter !== undefined) until = Date.now() + retryAfter * 1000
    else if (exhausted && reset !== undefined) until = reset * 1000
    if (until === undefined) return false
    this.backoffUntil = until
    this.ctx.logger.warn(`lsy-github-sensor: ${stream}: rate limited (HTTP ${response.status}); pausing until ${new Date(until).toISOString()}`)
    return true
  }

  /** Log a configuration warning once per process. */
  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.ctx.logger.warn(message)
  }
}

export default GithubSensor
