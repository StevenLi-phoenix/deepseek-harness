/**
 * DSH's end of the qq-recorder protocol: requests over the recorder's unix socket with the bearer token, the `hello`
 * handshake that checks the protocol version, the configuration push, and the event stream that keeps the connection
 * state fresh. Every response is parsed with the DTOs of {@link ./protocol.ts}. A recorder that is not there is a state
 * (`recorder-down`), not an exception that escapes: reads fail fast with {@link RecorderUnavailable} and the loop keeps
 * trying with a backoff.
 */

import { request, type IncomingMessage } from 'node:http'
import { z } from 'zod'
import {
  ConfigAppliedDto, ErrorDto, EventDto, FEATURE_MINOR, GroupDto, HelloDto, LegacyDigestStateDto, LoginDto, MEDIA_HEADER,
  MediaHeaderDto, MembersDto,
  MessageListDto, MessagePageDto, PATHS, PROTOCOL, PROTOCOL_HEADER, RefreshDto, StatusDto, protocolTag,
  type ConfigApplied, type Group, type Hello, type MediaHeader, type LegacyDigestState, type Login, type Member, type Message,
  type MessagePage,
  type RecorderConfig, type RecorderEvent, type Refresh, type Status,
} from './protocol.ts'
import type { QqConnection } from './status.ts'

/** The recorder cannot be asked right now (not running, not answering, or a different major protocol). */
export class RecorderUnavailable extends Error {
  constructor(readonly reason: 'recorder-down' | 'protocol-mismatch', message: string) {
    super(message)
  }
}

/** The recorder answered with an error. */
export class RecorderError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

/** The client's view of the recorder. */
export type LinkState = 'connecting' | 'ok' | 'recorder-down' | 'protocol-mismatch'

/** Log sink of the client. */
export interface ClientLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
}

/** Options of {@link RecorderClient}. */
export interface RecorderClientOptions {
  socketPath: string
  /** The shared bearer token; undefined while it is not set. Never logged. */
  token(): string | undefined | Promise<string | undefined>
  logger: ClientLogger
  /** Deadline of one request, in milliseconds. */
  timeoutMs?: number
  /** First and largest wait between attempts to reach the recorder. */
  retryMs?: { first: number; max: number }
  /** Replaced by tests. */
  now?: () => number
}

/** What listeners of the client are told. */
export interface ClientListener {
  /** The link or the recorder's status changed. */
  change?(): void
  /** New messages were recorded in a group. */
  messages?(event: Extract<RecorderEvent, { type: 'messages' }>): void
  /** The protocol end reported the account offline. */
  botOffline?(at: number): void
}

const DEFAULT_RETRY = { first: 1000, max: 30_000 }

/** The media description header as JSON, or undefined when it is not, so the caller's check refuses it like any other wrong answer. */
function parsedHeader(raw: unknown): unknown {
  if (typeof raw !== 'string') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** Parse a header-less stream of NDJSON lines. */
function lines(): { push(chunk: string): string[] } {
  let rest = ''
  return {
    push(chunk) {
      rest += chunk
      const parts = rest.split('\n')
      /* v8 ignore next -- split always yields a last element. */
      rest = parts.pop() ?? ''
      return parts.filter(part => part.trim() !== '')
    },
  }
}

/** The client. */
export class RecorderClient {
  private state: LinkState = 'connecting'
  private since: number
  private attempt = 0
  private lastError: string | undefined
  private hello: Hello | undefined
  private lastStatus: Status | undefined
  private config: RecorderConfig | undefined
  private pushedRevision: string | undefined
  /** A revision the recorder refused (HTTP 422); it is not pushed again until the configuration changes. */
  private rejectedRevision: string | undefined
  private pushing: Promise<void> = Promise.resolve()
  private stopped = true
  private readonly abort = new AbortController()
  private loop: Promise<void> | undefined
  private stream: IncomingMessage | undefined
  private wake: (() => void) | undefined
  private readonly listeners = new Set<ClientListener>()
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly retry: { first: number; max: number }

  /** @param options - socket, token, and seams. */
  constructor(private readonly options: RecorderClientOptions) {
    this.now = options.now ?? Date.now
    this.since = this.now()
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.retry = options.retryMs ?? DEFAULT_RETRY
  }

  // ---- state ----

  /**
   * Register a listener for link and status changes.
   * @param listener - called on every change; kept until the returned function runs.
   * @returns the function that unsubscribes the listener.
   */
  listen(listener: ClientListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * The state of the connection to the recorder.
   * @returns the link state.
   */
  link(): LinkState {
    return this.state
  }

  /**
   * The recorder's most recent status report.
   * @returns the status while the link is `ok`, otherwise undefined.
   */
  status(): Status | undefined {
    return this.state === 'ok' ? this.lastStatus : undefined
  }

  /**
   * What the recorder announced in its `hello` answer.
   * @returns the announcement, or undefined before the first successful hello.
   */
  helloOf(): Hello | undefined {
    return this.hello
  }

  /**
   * Whether the recorder in front of us offers an optional capability.
   * @param feature - a key of {@link FEATURE_MINOR}.
   * @returns false before the first hello, for an unknown key, or when the recorder's protocol minor is lower than the feature needs.
   */
  supports(feature: string): boolean {
    const needed = FEATURE_MINOR[feature]
    return this.hello !== undefined && needed !== undefined && this.hello.protocol.minor >= needed
  }

  /**
   * The connection as the Settings page and the overview show it, computed synchronously from cached state.
   * @returns the connection state, with `selfId` null while the recorder is unreachable.
   */
  connection(): QqConnection {
    if (this.state === 'recorder-down' || this.state === 'protocol-mismatch') {
      /* v8 ignore next -- lastError is set in every state that returns this. */
      return { state: this.state, since: this.since, attempt: this.attempt, lastError: this.lastError ?? null, selfId: null }
    }
    const status = this.status()
    if (status === undefined) return { state: 'starting', since: null, attempt: 0, lastError: null, selfId: null }
    const { connection } = status
    const state = connection.state === 'waiting-config' ? 'starting' : connection.state
    return { state, since: connection.since, attempt: connection.attempt, lastError: connection.lastError, selfId: connection.selfId }
  }

  private setState(state: LinkState, error?: string): void {
    const changed = state !== this.state
    if (changed) {
      this.state = state
      this.since = this.now()
    }
    if (state === 'ok') {
      this.attempt = 0
      this.lastError = undefined
    } else {
      this.lastError = error
    }
    if (changed) {
      this.options.logger.info(`lsy-qq: the recorder is ${state}${error === undefined ? '' : ` (${error})`}`)
      this.changed()
    }
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener.change?.()
      } catch (error: unknown) {
        this.options.logger.debug(`lsy-qq: a recorder listener threw: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // ---- lifecycle ----

  /** Begin reaching the recorder. */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.loop = this.run()
  }

  /** Stop, closing the event stream. */
  async stop(): Promise<void> {
    this.stopped = true
    this.abort.abort()
    this.stream?.destroy()
    this.wake?.()
    await this.loop
    await this.pushing
    this.listeners.clear()
  }

  /**
   * Set the configuration the recorder must run on, and push it as soon as the link is up.
   * @param config - the full configuration.
   */
  setConfig(config: RecorderConfig): Promise<void> {
    this.config = config
    return this.pushConfig()
  }

  private pushConfig(): Promise<void> {
    const run = async (): Promise<void> => {
      const config = this.config
      if (config === undefined || this.state !== 'ok' || this.pushedRevision === config.revision || this.rejectedRevision === config.revision) return
      try {
        const applied: ConfigApplied = await this.call('PUT', PATHS.config, ConfigAppliedDto, { body: config })
        this.pushedRevision = applied.revision
        this.options.logger.info(`lsy-qq: pushed configuration ${applied.revision} to the recorder${applied.reconnect ? ' (it reconnected to QQ)' : ''}`)
      } catch (error: unknown) {
        if (error instanceof RecorderError && error.status === 422) this.rejectedRevision = config.revision
        this.options.logger.warn(`lsy-qq: could not push the configuration to the recorder: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.pushing = this.pushing.then(run, run)
    return this.pushing
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => { clearTimeout(timer); this.wake = undefined; resolve() }
      const timer = setTimeout(done, ms)
      this.wake = done
    })
  }

  private async run(): Promise<void> {
    let wait = this.retry.first
    while (!this.stopped) {
      try {
        const hello = await this.call('GET', PATHS.hello, HelloDto, { link: false })
        this.hello = hello
        if (hello.protocol.name !== PROTOCOL.name || hello.protocol.major !== PROTOCOL.major) {
          this.setState('protocol-mismatch', `the recorder speaks ${protocolTag(hello.protocol)}, this DSH speaks ${protocolTag()}`)
          wait = this.retry.max
        } else {
          this.lastStatus = await this.call('GET', PATHS.status, StatusDto, { link: false })
          this.pushedRevision = undefined
          this.setState('ok')
          wait = this.retry.first
          await this.pushConfig()
          await this.follow()
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- stop() sets it while a request is awaited.
          if (this.stopped) return
          this.setState('recorder-down', 'the event stream ended')
        }
      } catch (error: unknown) {
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- stop() sets it while a request is awaited.
        if (this.stopped) return
        if (error instanceof RecorderUnavailable && error.reason === 'protocol-mismatch') {
          this.setState('protocol-mismatch', error.message)
          wait = this.retry.max
        } else {
          this.attempt += 1
          this.setState('recorder-down', error instanceof Error ? error.message : String(error))
          this.changedIfStillDown()
        }
      }
      await this.delay(wait)
      wait = Math.min(wait * 2, this.retry.max)
    }
  }

  private changedIfStillDown(): void {
    // The attempt counter moved; the Settings page shows it.
    /* v8 ignore else -- the retry loop runs only while the recorder is down. */
    if (this.state === 'recorder-down') this.changed()
  }

  /** Read the event stream until it ends; without the capability, poll the status. */
  private async follow(): Promise<void> {
    if (!this.supports('events')) {
      while (!this.stopped && this.state === 'ok') {
        await this.delay(5000)
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- stop() sets it while a request is awaited.
        if (this.stopped) return
        this.lastStatus = await this.call('GET', PATHS.status, StatusDto)
        this.changed()
        await this.pushIfStale()
      }
      return
    }
    await new Promise<void>((resolve) => {
      const token = this.tokenSync
      const req = request({
        socketPath: this.options.socketPath, path: PATHS.events, method: 'GET',
        headers: { authorization: `Bearer ${token ?? ''}`, [PROTOCOL_HEADER]: protocolTag() },
        // stop() can land before the response gives it a stream to destroy.
        signal: this.abort.signal,
      })
      req.once('error', () => { resolve() })
      req.once('response', (res) => {
        this.stream = res
        if (res.statusCode !== 200) { res.destroy(); resolve(); return }
        res.setEncoding('utf8')
        const splitter = lines()
        res.on('data', (chunk: string) => {
          for (const line of splitter.push(chunk)) this.onEventLine(line)
        })
        res.once('close', () => { this.stream = undefined; resolve() })
        res.once('error', () => { resolve() })
      })
      req.end()
    })
  }

  private onEventLine(line: string): void {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return
    }
    const parsed = EventDto.safeParse(raw)
    // A newer recorder may send event types this DSH does not know; they are skipped.
    if (!parsed.success) return
    const event = parsed.data
    if (event.type === 'status') {
      this.lastStatus = event.status
      this.changed()
      void this.pushIfStale()
    } else if (event.type === 'messages') {
      for (const listener of this.listeners) listener.messages?.(event)
    } else if (event.type === 'bot-offline') {
      for (const listener of this.listeners) listener.botOffline?.(event.at)
    }
  }

  private async pushIfStale(): Promise<void> {
    const revision = this.lastStatus?.configRevision
    if (this.config !== undefined && revision !== this.config.revision) {
      this.pushedRevision = undefined
      await this.pushConfig()
    }
  }

  // ---- requests ----

  private tokenSync: string | undefined

  /**
   * One request.
   * @param link - false for the loop's own requests, which run while the link is down.
   * @throws {@link RecorderUnavailable} when the recorder cannot be reached or the link is down.
   * @throws {@link RecorderError} for the recorder's error answers.
   */
  private async call<S extends z.ZodType>(
    method: 'GET' | 'POST' | 'PUT', path: string, schema: S, options: { body?: unknown; link?: boolean } = {},
  ): Promise<z.output<S>> {
    const { status, body: raw, tag } = await this.exchange(method, path, options)
    return this.parse(status, raw.toString('utf8'), tag, path, schema)
  }

  /** Check an answer: protocol mismatch, error bodies, then the schema. */
  private parse<S extends z.ZodType>(status: number, text: string, tag: string | undefined, path: string, schema: S): z.output<S> {
    if (status === 426) throw new RecorderUnavailable('protocol-mismatch', `the recorder speaks ${tag ?? 'another protocol'}`)
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new RecorderError(status, 'invalid-response', 'the recorder did not answer with JSON')
    }
    if (status < 200 || status >= 300) {
      const error = ErrorDto.safeParse(body)
      throw new RecorderError(status, error.success ? error.data.error.code : 'error', error.success ? error.data.error.message : `HTTP ${status}`)
    }
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      /* v8 ignore next -- a parse failure always carries an issue. */
      throw new RecorderError(status, 'invalid-response', `the recorder's answer for ${path} does not match protocol ${protocolTag()}: ${parsed.error.issues[0]?.path.join('.') ?? ''}`)
    }
    return parsed.data
  }

  /** One HTTP exchange over the socket; transport trouble is {@link RecorderUnavailable} and moves the link to `recorder-down`. */
  private async exchange(
    method: 'GET' | 'POST' | 'PUT', path: string, options: { body?: unknown; link?: boolean },
  ): Promise<{ status: number; body: Buffer; tag: string | undefined; headers: IncomingMessage['headers'] }> {
    if (options.link !== false && this.state !== 'ok') {
      throw new RecorderUnavailable(this.state === 'protocol-mismatch' ? 'protocol-mismatch' : 'recorder-down', `the QQ recorder is ${this.state}`)
    }
    const token = await this.options.token()
    this.tokenSync = token
    if (token === undefined) throw new RecorderUnavailable('recorder-down', 'the recorder token is not set')
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
    return new Promise<{ status: number; body: Buffer; tag: string | undefined; headers: IncomingMessage['headers'] }>((resolve, reject) => {
      const req = request({
        socketPath: this.options.socketPath, path, method, timeout: this.timeoutMs,
        headers: {
          authorization: `Bearer ${token}`, [PROTOCOL_HEADER]: protocolTag(),
          ...payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        },
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.once('end', () => {
          /* v8 ignore next -- a response from the socket always has a status code. */
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), tag: res.headers[PROTOCOL_HEADER] as string | undefined,
            headers: res.headers })
        })
        res.once('error', reject)
      })
      req.once('timeout', () => { req.destroy(new Error('the recorder did not answer in time')) })
      req.once('error', reject)
      req.end(payload)
    }).catch((error: unknown) => {
      const code = (error as { code?: string }).code
      /* v8 ignore next -- a socket error is always an Error instance. */
      const reason = code === 'ENOENT' || code === 'ECONNREFUSED' ? 'the recorder is not listening' : error instanceof Error ? error.message : String(error)
      if (options.link !== false && this.state === 'ok') {
        this.setState('recorder-down', reason)
        this.stream?.destroy()
        this.wake?.()
      }
      throw new RecorderUnavailable('recorder-down', reason)
    })
  }

  /**
   * A saved image of the recorder (1.1). Nothing is fetched from QQ for this: the recorder serves the file it downloaded.
   * @param ref - the reference from a message's `media`.
   * @returns the bytes with the recorder's description of them.
   * @throws {@link RecorderError} with code `not-saved` when the recorder does not hold the image.
   */
  async media(ref: string): Promise<{ bytes: Buffer; header: MediaHeader }> {
    const answer = await this.exchange('GET', PATHS.media(ref), {})
    if (answer.status !== 200) {
      this.parse(answer.status, answer.body.toString('utf8'), answer.tag, PATHS.media(ref), z.never())
      throw new RecorderError(answer.status, 'error', `HTTP ${answer.status}`)
    }
    const raw = answer.headers[MEDIA_HEADER]
    const described = MediaHeaderDto.safeParse(parsedHeader(raw))
    if (!described.success || described.data.bytes !== answer.body.length) {
      throw new RecorderError(200, 'invalid-response', 'the recorder\'s description of the image does not match the file')
    }
    return { bytes: answer.body, header: described.data }
  }

  // ---- the API ----

  /**
   * Every group the account is in.
   * @returns the groups, recorded ones first.
   */
  groups(): Promise<Group[]> {
    return this.call('GET', PATHS.groups, GroupDto.array())
  }

  /**
   * Recent messages of a recorded group.
   * @param groupId - the QQ group number.
   * @param options - `sinceMs` is the lookback in milliseconds (negative is treated as 0), `limit` the maximum count, `userId` restricts
   *   to one sender.
   * @returns the messages, oldest first.
   */
  recent(groupId: string, options: { sinceMs: number; limit: number; userId?: string }): Promise<Message[]> {
    const q = new URLSearchParams({ groupId, sinceMs: String(Math.max(0, Math.round(options.sinceMs))), limit: String(options.limit),
      ...options.userId === undefined ? {} : { userId: options.userId } })
    return this.call('GET', `${PATHS.messages}?${q.toString()}`, MessageListDto)
  }

  /**
   * A page of a recorded group's messages in log order.
   * @param groupId - the QQ group number.
   * @param after - the cursor of the last message already seen; undefined starts at the oldest message.
   * @param limit - the maximum number of messages in the page.
   * @returns the page, with the cursor for the next one or null at the end.
   */
  page(groupId: string, after: string | undefined, limit: number): Promise<MessagePage> {
    const q = new URLSearchParams({ groupId, limit: String(limit), ...after === undefined ? {} : { after } })
    return this.call('GET', `${PATHS.messages}?${q.toString()}`, MessagePageDto)
  }

  /**
   * Full-text search over the recorded messages.
   * @param query - the text to look for.
   * @param options - `groupId` limits the search to one group, `limit` caps the matches.
   * @returns the matches, newest first.
   */
  search(query: string, options: { groupId?: string; limit: number }): Promise<Message[]> {
    return this.call('POST', PATHS.search, MessageListDto, { body: { query, ...options.groupId === undefined ? {} : { groupId: options.groupId }, limit: options.limit } })
  }

  /**
   * Messages of a group by their OneBot ids.
   * @param groupId - the QQ group number.
   * @param messageIds - OneBot message ids; only the first 200 are sent.
   * @returns the messages the recorder holds, in log order; unknown ids are absent.
   */
  lookup(groupId: string, messageIds: readonly string[]): Promise<Message[]> {
    return this.call('POST', PATHS.lookup, MessageListDto, { body: { groupId, messageIds: messageIds.slice(0, 200) } })
  }

  /**
   * The member names a group's recorded messages show.
   * @param groupId - the QQ group number.
   * @returns one entry per distinct user id, with the nickname and group card seen.
   */
  members(groupId: string): Promise<Member[]> {
    return this.call('GET', PATHS.members(groupId), MembersDto)
  }

  /**
   * NapCat's login state as the recorder reads it.
   * @param fresh - true asks the recorder to query NapCat again instead of answering from its cache.
   * @returns the login state.
   */
  login(fresh: boolean): Promise<Login> {
    return this.call('GET', `${PATHS.login}${fresh ? '?fresh=1' : ''}`, LoginDto)
  }

  /**
   * Ask NapCat for a fresh login code.
   * @returns the recorder's answer to the request.
   */
  refreshLogin(): Promise<Refresh> {
    return this.call('POST', PATHS.loginRefresh, RefreshDto, { body: {} })
  }

  /**
   * The digest state the recorder holds from before digests moved to DSH.
   * @returns the old digests, notes and sessions, for a one-time import.
   */
  legacyState(): Promise<LegacyDigestState> {
    return this.call('GET', PATHS.legacy, LegacyDigestStateDto)
  }
}
