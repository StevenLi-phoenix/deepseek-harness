/** GitHub polling sensor: publishes new releases, tags, commits, and notification updates to the lsy event bus. */

import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { LsyEventInput } from '@deepseek-ai/dsh-lsy-event-bus'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import z from '@deepseek-ai/schemastery'
import { commitEvent, notificationEvent, parseCommits, parseReleases, parseRepository, parseTags, parseThreads, releaseEvent, tagEvent } from './github.ts'
import { sensorDomain, type StreamCursor, type WatchRecord } from './storage.ts'

export * from './github.ts'
export type * from './storage.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    lsyGithubSensor: GithubSensor
  }
}

/** Per-repository streams. */
export type RepoStream = 'releases' | 'commits' | 'tags'

/** Every repository stream, in documentation order. */
export const REPO_STREAMS: readonly RepoStream[] = ['releases', 'tags', 'commits']

/** One watched repository. */
export interface RepoWatch {
  /** `owner/name`. */
  repo: string
  /** Streams to poll, published in this order within one tick. */
  watch: RepoStream[]
  /** Branch for `commits`; the default branch when unset. */
  branch?: string
}

/** Outcome of the latest poll of one stream in this process. */
export interface PollStatus {
  /** Unix epoch milliseconds. */
  at: number
  /** True for a 200 or 304 whose items were all published. */
  ok: boolean
  /** Why the poll failed, e.g. `HTTP 404`. */
  detail?: string
}

/** Polling state of one stream of a watched repository. */
export interface StreamStatus {
  stream: RepoStream
  /** Cursor key. */
  id: string
  /** True once the first successful poll recorded the existing items. */
  baseline: boolean
  lastPoll?: PollStatus
}

/** One repository the sensor polls, as `GithubSensor.watchedRepos()` reports it. */
export interface WatchedRepo extends RepoWatch {
  /** `config` for `Config.repos`, `agent` for `GithubSensor.watch()`. */
  origin: 'config' | 'agent'
  /** Watch id of an agent watch. */
  ref?: string
  /** Creation time of an agent watch, in Unix epoch milliseconds. */
  createdAt?: number
  streams: StreamStatus[]
}

/** Result of `GithubSensor.probe()`; `status` is 0 when no HTTP response arrived. */
export type RepoProbe =
  | { ok: true; fullName: string; private: boolean; defaultBranch: string }
  | { ok: false; status: number; message: string }

/** Whether one credential reference resolves. */
export interface TokenStatus {
  ref: string
  configured: boolean
}

/** Which tokens resolve, without their values. */
export interface CredentialStatus {
  /** Repository reads; unauthenticated polling shares 60 requests per hour. */
  token: TokenStatus
  /** `/notifications`. */
  notificationsToken: TokenStatus
  /** Whether notification polling is turned on. */
  notifications: boolean
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
  /** Poll the authenticated user's notification threads when the notifications token resolves. */
  notifications: boolean
  /** Repositories watched by configuration; `GithubSensor.watch()` adds more at run time. */
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
  notifications: z.boolean().default(true),
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

/**
 * Cursor key of one repository stream; a commits stream on an explicit branch keeps its own cursor.
 * @param watch - repository and branch.
 * @param kind - stream.
 * @returns `repo:<owner/name>:<kind>` or `repo:<owner/name>:commits@<branch>`.
 */
export function streamId(watch: RepoWatch, kind: RepoStream): string {
  const branch = kind === 'commits' && watch.branch !== undefined ? `@${watch.branch}` : ''
  return `repo:${watch.repo}:${kind}${branch}`
}

/** Fail at load on configuration that cannot be polled. */
function assertConfig(config: Config): void {
  for (const watch of config.repos) {
    if (!REPO_NAME.test(watch.repo)) throw new Error(`lsy-github-sensor: repo "${watch.repo}" must be owner/name`)
  }
}

/** First problem of a run-time watch, or undefined when it can be polled. */
function watchProblem(ref: string, spec: RepoWatch): string | undefined {
  if (ref.trim() === '') return 'watch ref must be non-empty'
  if (!REPO_NAME.test(spec.repo)) return `repo "${spec.repo}" must be owner/name`
  if (spec.watch.length === 0 || spec.watch.some(kind => !REPO_STREAMS.includes(kind))) {
    return `watch must list at least one of ${REPO_STREAMS.join(', ')}`
  }
  if (spec.branch === undefined) return undefined
  if (spec.branch.trim() === '') return 'branch must be non-empty when given'
  return spec.watch.includes('commits') ? undefined : 'branch applies only to the commits stream'
}

/** The polling fields of a stored watch. */
function toRepoWatch(record: WatchRecord): RepoWatch {
  return { repo: record.repo, watch: record.watch, ...(record.branch === undefined ? {} : { branch: record.branch }) }
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

/** `message` of a GitHub error body, if it has one. */
function bodyMessage(body: unknown): string | undefined {
  return typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string' ? body.message : undefined
}

/**
 * Polls GitHub on a fixed period with conditional requests and publishes
 * what is new since the previous poll. The first successful poll of a stream
 * only records a baseline. Repositories come from the configuration and from
 * watches created at run time; a stream several watches name is polled once.
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
  private rerun = false
  private backoffUntil = 0
  private stopping = false
  private readonly logged = new Set<string>()
  private readonly polls = new Map<string, PollStatus>()

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
   * @param stream - stream id, see {@link streamId}, or `notifications`.
   * @returns cursor, or undefined before the first poll.
   */
  cursor(stream: string): StreamCursor | undefined {
    return this.domain?.table('cursors').get(stream)
  }

  /**
   * Outcome of the latest poll of one stream in this process.
   * @param stream - stream id, see {@link streamId}, or `notifications`.
   * @returns status, or undefined before the first poll since start or after the stream was forgotten.
   */
  pollStatus(stream: string): PollStatus | undefined {
    return this.polls.get(stream)
  }

  /**
   * Watch a repository at run time. The watch is stored durably; a poll starts
   * right away so the existing items become the baseline, and only later
   * items are published. A watch with the same ref is replaced.
   * @param ref - watch id, e.g. the bus subscription that routes its events.
   * @param spec - `owner/name`, a non-empty subset of streams, and an optional commits branch.
   * @returns the stored watch with its stream status.
   * @throws {TypeError} when the ref, repository, streams, or branch is invalid.
   */
  async watch(ref: string, spec: RepoWatch): Promise<WatchedRepo> {
    const problem = watchProblem(ref, spec)
    if (problem !== undefined) throw new TypeError(`lsy-github-sensor: ${problem}`)
    const domain = await this.ready
    const watches = domain.table('watches')
    const previous = watches.get(ref)
    const record: WatchRecord = {
      ref,
      repo: spec.repo,
      watch: [...new Set(spec.watch)],
      ...(spec.branch === undefined ? {} : { branch: spec.branch }),
      createdAt: Date.now(),
    }
    await watches.put(ref, record)
    if (previous !== undefined) await this.forgetStreams(domain, toRepoWatch(previous))
    this.ctx.logger.info(`lsy-github-sensor: watching ${record.repo} [${record.watch.join(', ')}]${record.branch === undefined ? '' : ` on ${record.branch}`} as ${ref}`)
    this.requestTick()
    return this.repoView(toRepoWatch(record), 'agent', record)
  }

  /**
   * Stop a run-time watch. Cursors of streams nobody polls anymore are
   * deleted, so watching the repository again records a fresh baseline.
   * @param ref - watch id.
   * @returns true when the watch existed.
   */
  async unwatch(ref: string): Promise<boolean> {
    const domain = await this.ready
    const watches = domain.table('watches')
    const previous = watches.get(ref)
    if (previous === undefined) return false
    await watches.delete(ref)
    await this.forgetStreams(domain, toRepoWatch(previous))
    this.ctx.logger.info(`lsy-github-sensor: stopped watching ${previous.repo} (${ref})`)
    return true
  }

  /**
   * Every polled repository, configuration first and then run-time watches by creation time.
   * @returns snapshot with per-stream baseline and latest poll.
   */
  watchedRepos(): WatchedRepo[] {
    return [
      ...this.config.repos.map(watch => this.repoView(watch, 'config')),
      ...this.agentWatches().map(record => this.repoView(toRepoWatch(record), 'agent', record)),
    ]
  }

  /**
   * Check that a repository exists and the repository token can read it. Never throws.
   * @param repo - `owner/name`.
   * @param signal - optional caller cancellation.
   * @returns canonical name, visibility, and default branch, or the HTTP status (0 without a response) and a message.
   */
  async probe(repo: string, signal?: AbortSignal): Promise<RepoProbe> {
    if (!REPO_NAME.test(repo)) return { ok: false, status: 0, message: 'repository must be owner/name' }
    const token = await this.resolveToken(this.tokenRef)
    let response: Response
    try {
      response = await fetch(`${this.config.apiBase}/repos/${repo}`, {
        headers: this.headers(token),
        signal: AbortSignal.any([AbortSignal.timeout(this.config.timeoutMs), this.abort.signal, ...(signal === undefined ? [] : [signal])]),
      })
    } catch (error: unknown) {
      return { ok: false, status: 0, message: `request failed: ${errorText(error)}` }
    }
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      const detail = bodyMessage(body) ?? response.statusText
      return { ok: false, status: response.status, message: detail === '' ? `HTTP ${response.status}` : `HTTP ${response.status}: ${detail}` }
    }
    const parsed = parseRepository(body)
    if (parsed === undefined) return { ok: false, status: response.status, message: 'unexpected response body' }
    return { ok: true, fullName: parsed.full_name, private: parsed.private, defaultBranch: parsed.default_branch }
  }

  /**
   * Report which tokens resolve. Token values never leave the credential store.
   * @returns per-reference status and whether notification polling is on.
   */
  async credentialStatus(): Promise<CredentialStatus> {
    const token = await this.resolveToken(this.tokenRef)
    const notificationsToken = await this.resolveToken(this.notificationsRef)
    return {
      token: { ref: this.config.tokenEnv, configured: token !== undefined },
      notificationsToken: { ref: this.config.notificationsTokenEnv, configured: notificationsToken !== undefined },
      notifications: this.config.notifications,
    }
  }

  /** Stored run-time watches, oldest first. */
  private agentWatches(): WatchRecord[] {
    const table = this.domain?.table('watches')
    return table === undefined ? [] : [...table.entries()].map(([, record]) => record).sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Configuration and run-time watches, in polling order. */
  private allWatches(): RepoWatch[] {
    return [...this.config.repos, ...this.agentWatches().map(toRepoWatch)]
  }

  /** Stream ids some watch still polls. */
  private activeStreams(): Set<string> {
    return new Set(this.allWatches().flatMap(watch => watch.watch.map(kind => streamId(watch, kind))))
  }

  /** Delete cursors and poll status of a removed watch's streams that no remaining watch polls. */
  private async forgetStreams(domain: Domain<typeof sensorDomain>, removed: RepoWatch): Promise<void> {
    const active = this.activeStreams()
    for (const kind of removed.watch) {
      const id = streamId(removed, kind)
      if (active.has(id)) continue
      this.polls.delete(id)
      await domain.table('cursors').delete(id)
    }
  }

  /** Attach origin and per-stream status to one watch. */
  private repoView(watch: RepoWatch, origin: WatchedRepo['origin'], record?: WatchRecord): WatchedRepo {
    return {
      origin,
      ...(record === undefined ? {} : { ref: record.ref }),
      ...watch,
      ...(record === undefined ? {} : { createdAt: record.createdAt }),
      streams: watch.watch.map((kind) => {
        const id = streamId(watch, kind)
        const lastPoll = this.pollStatus(id)
        return { stream: kind, id, baseline: this.cursor(id)?.initialized === true, ...(lastPoll === undefined ? {} : { lastPoll }) }
      }),
    }
  }

  /** Request headers shared by polls and probes. */
  private headers(token: string | undefined): Record<string, string> {
    return {
      'accept': 'application/vnd.github+json',
      'user-agent': 'dsh-lsy-github-sensor',
      'x-github-api-version': '2022-11-28',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    }
  }

  /** Resolve one token; a credential store failure counts as not configured and is logged once. */
  private async resolveToken(ref: CredentialRef): Promise<string | undefined> {
    try {
      const value = (await this.ctx.credentials.resolve(ref))?.value
      return value === '' ? undefined : value
    } catch (error: unknown) {
      this.logOnce(`resolve:${ref}`, 'warn', `lsy-github-sensor: resolving ${ref} failed: ${errorText(error)}`)
      return undefined
    }
  }

  /** Start a tick now, or right after the running one so it sees a new watch. */
  private requestTick(): void {
    if (this.current !== undefined) {
      this.rerun = true
      return
    }
    this.startTick()
  }

  /** Start one tick unless one is running, the domain is not open, or the sensor is stopping. */
  private startTick(): void {
    if (this.current !== undefined || this.domain === undefined || this.stopping) return
    this.current = this.tick(this.domain).finally(() => {
      this.current = undefined
      if (!this.rerun) return
      this.rerun = false
      this.startTick()
    })
  }

  /** Poll every watched stream once, sequentially, then notifications. */
  private async tick(domain: Domain<typeof sensorDomain>): Promise<void> {
    if (Date.now() < this.backoffUntil) return
    const token = await this.resolveToken(this.tokenRef)
    if (token === undefined) this.logOnce('token', 'warn', `lsy-github-sensor: ${this.config.tokenEnv} is not configured; polling unauthenticated (60 requests/hour)`)
    const streams = new Map<string, Stream>()
    for (const watch of this.allWatches()) {
      for (const kind of watch.watch) {
        const spec = this.repoStream(watch, kind, token)
        if (!streams.has(spec.id)) streams.set(spec.id, spec)
      }
    }
    for (const spec of streams.values()) await this.poll(domain, spec)
    if (!this.config.notifications) return
    const notificationsToken = await this.resolveToken(this.notificationsRef)
    if (notificationsToken === undefined) {
      this.logOnce('notifications', 'info', `lsy-github-sensor: ${this.config.notificationsTokenEnv} is not configured; skipping notifications`)
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

  /** Build one repository stream. */
  private repoStream(watch: RepoWatch, kind: RepoStream, token: string | undefined): Stream {
    const id = streamId(watch, kind)
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

  /** Remember the latest poll outcome of one stream. */
  private recordPoll(id: string, ok: boolean, detail?: string): void {
    this.polls.set(id, { at: Date.now(), ok, ...(detail === undefined ? {} : { detail }) })
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
          ...this.headers(spec.token),
          ...(cursor.etag === undefined ? {} : { 'if-none-match': cursor.etag }),
          ...(cursor.lastModified === undefined ? {} : { 'if-modified-since': cursor.lastModified }),
        },
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(this.config.timeoutMs), this.abort.signal]),
      })
    } catch (error: unknown) {
      if (this.abort.signal.aborted) return
      this.ctx.logger.warn(`lsy-github-sensor: ${spec.id}: request failed: ${errorText(error)}`)
      this.recordPoll(spec.id, false, `request failed: ${errorText(error)}`)
      return
    }
    // A watch removed while its request was in flight must not leave a cursor behind.
    if (spec.id !== NOTIFICATIONS_STREAM && !this.activeStreams().has(spec.id)) return

    const pollInterval = headerSeconds(response, 'x-poll-interval')
    const nextPollAt = pollInterval === undefined ? {} : { nextPollAt: Date.now() + pollInterval * 1000 }
    if (response.status === 304) {
      await cursors.put(spec.id, { ...cursor, ...nextPollAt })
      this.recordPoll(spec.id, true)
      return
    }
    if (this.handleRateLimit(spec.id, response)) {
      this.recordPoll(spec.id, false, `rate limited (HTTP ${response.status})`)
      return
    }
    if (!response.ok) {
      this.ctx.logger.warn(`lsy-github-sensor: ${spec.id}: HTTP ${response.status}`)
      this.recordPoll(spec.id, false, `HTTP ${response.status}`)
      return
    }
    const items = spec.read(await response.json().catch(() => undefined))
    if (items === undefined) {
      this.ctx.logger.warn(`lsy-github-sensor: ${spec.id}: unexpected response body`)
      this.recordPoll(spec.id, false, 'unexpected response body')
      return
    }

    const seen = new Set(cursor.seen)
    const fresh = items.filter(item => !seen.has(item.id))
    if (!cursor.initialized) {
      this.ctx.logger.info(`lsy-github-sensor: ${spec.id}: baseline of ${items.length} item(s)`)
    } else if (!await this.publishAll(spec.id, fresh.toReversed())) {
      // Drop the validators so the next poll refetches and retries; the bus dedupes what did get through.
      await cursors.put(spec.id, { seen: cursor.seen, initialized: true, ...nextPollAt })
      this.recordPoll(spec.id, false, 'publish failed')
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
    this.recordPoll(spec.id, true)
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

  /** Log a configuration message once per process. */
  private logOnce(key: string, level: 'info' | 'warn', message: string): void {
    if (this.logged.has(key)) return
    this.logged.add(key)
    this.ctx.logger[level](message)
  }
}

export default GithubSensor
