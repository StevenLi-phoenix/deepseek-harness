/**
 * The recording half of the QQ channel, run by the `qq-recorder` service (an AMS service of its own process): it holds the
 * one connection to the protocol end (NapCat's OneBot server), writes the recorded groups' messages and downloads to
 * `qq.db` and the data directory, and answers reads over {@link ./server.ts}. It owns those files exclusively; DSH reaches
 * the data only through the protocol in {@link ./protocol.ts}. Settings come from DSH (`applyConfig`) and survive in
 * `recorder-config.json`, so a DSH restart or deploy never touches the connection. It decides nothing about what the data
 * means: digests, notes, tools, and the owner notice are DSH's.
 *
 * Logging: routine connection trouble is `info` (DSH tells the owner about an outage); `error` is reserved for faults a
 * person has to fix, because AMS escalates `error` lines to the alert journal.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { detectExtension, fetchCapped, isAllowedMediaUrl, removeMedia, saveMedia } from './media.ts'
import { LoginDoor, type DoorResult } from './login.ts'
import { isPrivateAddress, isPrivateUrl, OneBotClient, type OneBotEvent } from './onebot.ts'
import {
  RecorderConfigDto, type ConfigApplied, type Group, type LegacyDigestState, type Login, type Member, type Message, type Refresh,
  type MediaHeader, type RecorderConfig, type RecorderEvent, type Status,
} from './protocol.ts'
import { displayName, parseMessage } from './text.ts'
import { QqStore, type MediaRow, type MessageRow } from './store.ts'

/** The recorder's log sink; JSON lines in production. */
export interface RecorderLogger {
  debug(message: string): void
  info(message: string): void
  /** A fault that needs a person; AMS escalates these. */
  error(message: string): void
}

/** What the recorder needs from its host process. */
export interface RecorderDeps {
  /** Directory of `qq.db`, downloads, and the state files; the recorder is the only process that opens them. */
  dataDir: string
  logger: RecorderLogger
  /** Value of a secret by its environment name; undefined while unset. Never logged. */
  secret(name: string): string | undefined
  /** Fingerprint of the running build, reported by `hello`. */
  build?: string
  /** Replaced by tests. */
  now?: () => number
  fetch?: typeof fetch
  /** Opens the OneBot socket; tests substitute a double. */
  oneBot?: { requestTimeoutMs?: number; idleTimeoutMs?: number }
}

/** A configuration the recorder refuses; the server answers 422. */
export class ConfigRejected extends Error {}

const STALE_PHASES: ReadonlySet<string> = new Set(['restarting', 'logging-in', 'preparing', 'unknown'])
const NO_HISTORY = /消息undefined不存在/
const FIRST_RETRY_MS = 2000
const MAX_RETRY_MS = 120_000
const STABLE_MS = 60_000
const GROUP_REFRESH_MS = 3_600_000
const SCHEDULE_MS = 10 * 60_000
const RETENTION_CHECK_MS = 6 * 3_600_000
const MEDIA_CONCURRENCY = 2
const LOGIN_CACHE_MS = 1500
const ONLINE_CACHE_MS = 60_000
const RECENT_LOGIN_MS = 10 * 60_000
const WAKE_GAP_MS = 10_000
const WAIT_CONFIG_MS = 30_000
/** Per-group `messages` events are merged over this window. */
const EVENT_COALESCE_MS = 500

/** What a media download needs to know about its message. */
interface MediaJob {
  rowId: number
  groupId: string
  at: number
  mediaId: number
  kind: string
  url: string | undefined
  file: string | undefined
  name: string | undefined
}

/** Human-readable error text. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The cursor of a stored row.
 * @param rowId - the message row id.
 * @returns the cursor string.
 */
export function cursorOf(rowId: number): string {
  return `c${rowId}`
}

/**
 * The stored row a cursor names.
 * @param cursor - a cursor from {@link cursorOf}.
 * @returns the row id, or undefined when the cursor is not one of ours.
 */
export function rowOf(cursor: string): number | undefined {
  const match = /^c(\d{1,15})$/.exec(cursor)
  return match === null ? undefined : Number(match[1])
}

/**
 * The short reference of a media row.
 * @param mediaId - the media row id.
 * @returns the reference string.
 */
export function mediaRef(mediaId: number): string {
  return `m${mediaId.toString(36)}`
}

/**
 * The media row a reference names.
 * @param ref - a reference from {@link mediaRef}.
 * @returns the media row id, or undefined when the reference is not one of ours.
 */
export function mediaIdOf(ref: string): number | undefined {
  const match = /^m([0-9a-z]{1,12})$/.exec(ref)
  const id = match === null ? Number.NaN : Number.parseInt(match[1] ?? '', 36)
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

/** A file the recorder cannot hand out; the server answers 404 `not-saved`. */
export class MediaNotSaved extends Error {}

const IMAGE_TYPES: Readonly<Record<string, MediaHeader['contentType']>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
}

/** The protocol's name for a stored media kind; anything unforeseen is a file. */
function mediaKind(kind: string): 'image' | 'voice' | 'video' | 'file' {
  return kind === 'image' || kind === 'voice' || kind === 'video' ? kind : 'file'
}

/**
 * A stored message as the protocol shows it.
 * @param row - the stored message.
 * @param media - its media rows, in segment order.
 * @returns the protocol message; a media item is `saved` when its row has a local file.
 */
export function toMessage(row: MessageRow, media: readonly MediaRow[] = []): Message {
  return {
    cursor: cursorOf(row.id), groupId: row.groupId, messageId: row.messageId, at: row.at, userId: row.userId,
    nickname: row.nickname, card: row.card, role: row.role, text: row.text, replyTo: row.replyTo, kinds: row.kinds, recalled: row.recalled,
    media: media.map(item => ({ ref: mediaRef(item.id), kind: mediaKind(item.kind), saved: item.localPath !== null })),
  }
}

/**
 * Why a configuration cannot work, or undefined when it can.
 * @param config - a parsed configuration.
 * @returns a message naming the unusable address, or undefined when `url` and `login.url` are acceptable.
 */
export function configProblem(config: RecorderConfig): string | undefined {
  if (!isPrivateUrl(config.url)) return 'url must be a ws:// or wss:// address on this machine (127.0.0.1, localhost) or the tailnet (100.64.0.0/10, *.ts.net)'
  if (!isPrivateAddress(config.login.url, ['http:', 'https:'])) return 'login.url must be an http(s) address on this machine (127.0.0.1, localhost) or the tailnet (100.64.0.0/10, *.ts.net)'
  return undefined
}

/** The recorder. */
export class QqRecorder {
  /** The message database, `qq.db` in {@link QqRecorder.dataDir}. */
  readonly store: QqStore
  /** The directory holding the database, saved media, and the saved configuration. */
  readonly dataDir: string
  /** When this recorder instance started, in epoch milliseconds. */
  readonly startedAt: number
  private config: RecorderConfig | undefined
  private readonly abort = new AbortController()
  private readonly inflight = new Set<Promise<void>>()
  private client: OneBotClient | undefined
  private connAbort: AbortController | undefined
  private reconfigured = false
  private loop: Promise<void> | undefined
  private schedule: Promise<void> | undefined
  private aliveTimer: NodeJS.Timeout | undefined
  private stopping = false
  private started = false
  private selfId = ''
  private readonly seenUnlisted = new Set<string>()
  private readonly unlistedCounts = new Map<string, number>()
  private downloadsRunning = 0
  private readonly downloadQueue: Array<() => Promise<void>> = []
  private budgetWarnedAt = 0
  private disconnectedSince: number | undefined
  private botOfflineAt: number | undefined
  private connState: Status['connection']['state'] = 'starting'
  private connSince: number | undefined
  private attempt = 0
  private lastError: string | undefined
  private door: LoginDoor | undefined
  private loginCache: { at: number; login: Login } | undefined
  private loginInFlight: Promise<Login> | undefined
  private lastLoginKey = ''
  private lastWakeAt = 0
  private connectionState: { lastAliveAt?: number; lastGroupListAt?: number; lastBackfillAt?: number } = {}
  private connectionStateWarned = false
  private quietOpen = false
  private openedAt: number | undefined
  private lastDisconnectAt: number | undefined
  private backfillCursor = 0
  private backfillTail: Promise<void> = Promise.resolve()
  private lastBackfillEnd = 0
  private wakeRetry: (() => void) | undefined
  private readonly counters = { messages: 0, media: 0, voices: 0, dropped: 0, private: 0 }
  private readonly listeners = new Set<(event: RecorderEvent) => void>()
  private readonly pendingEvents = new Map<string, { count: number; last: number }>()
  private eventTimer: NodeJS.Timeout | undefined
  /** The clock; tests replace it. */
  now: () => number

  /**
   * @param deps - data directory, log sink, secrets, and test seams.
   */
  constructor(private readonly deps: RecorderDeps) {
    this.now = deps.now ?? Date.now
    this.startedAt = this.now()
    this.dataDir = deps.dataDir
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    this.store = new QqStore(join(this.dataDir, 'qq.db'))
    this.loadConnectionState()
    this.loadSavedConfig()
  }

  // ---- lifecycle ----

  /** Begin connecting (as soon as a configuration is known) and the scheduled upkeep. */
  start(): void {
    if (this.started) return
    this.started = true
    this.loop = this.run()
    this.schedule = this.scheduled()
    this.aliveTimer = setInterval(() => { if (this.client?.connected === true) this.touchAlive() }, 60_000)
    this.aliveTimer.unref()
  }

  /** Stop connecting, finish what is in flight, note the last time the connection was alive, and close the database. */
  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    clearInterval(this.aliveTimer)
    clearTimeout(this.eventTimer)
    this.abort.abort(new Error('qq-recorder is stopping'))
    await Promise.allSettled([this.loop, this.schedule])
    await Promise.allSettled([...this.inflight])
    if (this.client?.connected === true || this.openedAt !== undefined) this.touchAlive()
    this.store.close()
    this.listeners.clear()
  }

  // ---- configuration ----

  private get configFile(): string {
    return join(this.dataDir, 'recorder-config.json')
  }

  private loadSavedConfig(): void {
    let raw: string
    try {
      raw = readFileSync(this.configFile, 'utf8')
    } catch {
      // A first start: DSH pushes the configuration, and the recorder waits for it before connecting.
      return
    }
    const saved: unknown = JSON.parse(raw)
    const parsed = RecorderConfigDto.safeParse(saved)
    const problem = parsed.success ? configProblem(parsed.data) : parsed.error.message.slice(0, 300)
    if (!parsed.success || problem !== undefined) {
      this.deps.logger.error(`qq-recorder: the saved configuration in recorder-config.json is unusable (${problem ?? 'invalid'}); waiting for DSH to push one`)
      return
    }
    this.config = parsed.data
    this.setDoor(parsed.data)
    this.deps.logger.info(`qq-recorder: configuration ${parsed.data.revision} loaded from recorder-config.json; recording ${parsed.data.groups.length} group(s)`)
  }

  private saveConfig(config: RecorderConfig): void {
    const temp = `${this.configFile}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(config), { mode: 0o600 })
      renameSync(temp, this.configFile)
    } catch (error: unknown) {
      this.deps.logger.error(`qq-recorder: could not save recorder-config.json: ${errorText(error)}`)
    }
  }

  private setDoor(config: RecorderConfig): void {
    this.door = config.login.enabled
      ? new LoginDoor({ url: config.login.url, timeoutMs: config.login.timeoutMs,
        ...this.deps.fetch === undefined ? {} : { fetch: this.deps.fetch } })
      : undefined
    this.loginCache = undefined
  }

  /**
   * Apply a configuration pushed by DSH. Only a different `url` or `tokenEnv` drops the connection; every other field
   * takes effect on the next use, and a group added to the list is caught up with a backfill.
   * @param next - the parsed configuration.
   * @returns its revision, and whether the connection was dropped.
   * @throws {@link ConfigRejected} when the configuration cannot work.
   */
  applyConfig(next: RecorderConfig): ConfigApplied {
    const problem = configProblem(next)
    if (problem !== undefined) throw new ConfigRejected(problem)
    const prev = this.config
    const before = this.recordedIds
    this.config = next
    this.recordedCacheSource = undefined
    this.saveConfig(next)
    const doorChanged = prev === undefined || prev.login.enabled !== next.login.enabled
      || prev.login.url !== next.login.url || prev.login.timeoutMs !== next.login.timeoutMs
    if (doorChanged) this.setDoor(next)
    const reconnect = prev !== undefined && (prev.url !== next.url || prev.tokenEnv !== next.tokenEnv)
    this.deps.logger.info(`qq-recorder: config applied ${next.revision} reconnect=${String(reconnect)}; recording ${next.groups.length} group(s)`)
    if (prev === undefined) {
      this.wakeRetry?.()
    } else if (reconnect) {
      this.reconfigured = true
      this.connAbort?.abort()
      this.wakeRetry?.()
    } else {
      this.onGroupsChanged(before)
    }
    this.emit({ type: 'status', status: this.status() })
    return { revision: next.revision, reconnect }
  }

  private get live(): RecorderConfig {
    if (this.config === undefined) throw new Error('no configuration yet')
    return this.config
  }

  // ---- the group list ----

  private recordedCacheSource: readonly string[] | undefined
  private recordedCache: ReadonlySet<string> = new Set()

  private get recordedIds(): ReadonlySet<string> {
    const source = this.config?.groups
    if (source === undefined) return this.recordedCache
    if (this.recordedCacheSource !== source) {
      this.recordedCacheSource = source
      this.recordedCache = new Set(source)
    }
    return this.recordedCache
  }

  private onGroupsChanged(before: ReadonlySet<string>): void {
    const now = this.recordedIds
    const added = [...now].filter(id => !before.has(id))
    const removed = [...before].filter(id => !now.has(id))
    for (const id of added) {
      this.seenUnlisted.delete(id)
      this.deps.logger.info(`qq-recorder: now recording group ${id}${this.store.groupName(id) === undefined ? '' : ` (${this.store.groupName(id)})`}`)
    }
    for (const id of removed) this.deps.logger.info(`qq-recorder: no longer recording group ${id}; what is stored ages out with retention`)
    const client = this.client
    if (client === undefined || !this.live.backfill.enabled) return
    if (added.length > 0) this.track(this.queueBackfill(added, client))
  }

  // ---- reads, for the server ----

  /**
   * The recorder's state for `GET /v1/status` and the `status` event.
   * @returns the connection, outage clock, recorded group count, configuration revision, and counters.
   */
  status(): Status {
    const up = this.connState === 'connected'
    return {
      connection: {
        state: this.connState, since: this.connSince ?? null, attempt: up ? 0 : this.attempt,
        lastError: up ? null : this.lastError ?? null, selfId: up && this.selfId !== '' ? this.selfId : null,
      },
      outage: { disconnectedSince: this.disconnectedSince ?? null, botOfflineAt: this.botOfflineAt ?? null },
      recordedGroups: this.recordedIds.size,
      configRevision: this.config?.revision ?? null,
      counters: { ...this.counters },
    }
  }

  /**
   * Every group the account is in.
   * @returns the groups, recorded ones first, then by unlisted traffic, message count, and name.
   */
  groups(): Group[] {
    const stats = new Map(this.store.stats().map(stat => [stat.groupId, stat]))
    const known = new Map(this.store.groups().map(group => [group.groupId, group]))
    for (const id of this.recordedIds) if (!known.has(id)) known.set(id, { groupId: id, name: id, memberCount: null, updatedAt: 0 })
    return [...known.values()].map((group): Group => {
      const stat = stats.get(group.groupId)
      return {
        groupId: group.groupId, name: group.name, memberCount: group.memberCount, recorded: this.recordedIds.has(group.groupId),
        messages: stat?.messages ?? 0, firstAt: stat?.firstAt ?? null, lastAt: stat?.lastAt ?? null,
        unlistedSeen: this.unlistedCounts.get(group.groupId) ?? 0,
      }
    }).sort((a, b) => Number(b.recorded) - Number(a.recorded) || b.unlistedSeen - a.unlistedSeen
      || b.messages - a.messages || a.name.localeCompare(b.name))
  }

  /**
   * Recent messages of a recorded group.
   * @param groupId - the QQ group number.
   * @param options - `sinceMs` is the lower bound on the message time in epoch milliseconds, `limit` the maximum count, `userId` restricts
   *   to one sender.
   * @returns the messages, oldest first; empty for a group not on the list.
   */
  recent(groupId: string, options: { sinceMs: number; limit: number; userId?: string }): Message[] {
    if (!this.recordedIds.has(groupId)) return []
    const rows = this.store.recent(groupId,
      { sinceMs: options.sinceMs, limit: options.limit, ...options.userId === undefined ? {} : { userId: options.userId } })
    return this.withMedia(rows)
  }

  /** The protocol form of stored messages, with their media items (one query for all of them). */
  private withMedia(rows: readonly MessageRow[]): Message[] {
    const media = this.store.mediaForMessages(rows.map(row => row.id))
    return rows.map(row => toMessage(row, media.get(row.id)))
  }

  /**
   * A page of a recorded group's messages after a cursor.
   * @param groupId - the QQ group number.
   * @param after - the cursor of the last message already seen; undefined starts at the oldest.
   * @param limit - the maximum number of messages.
   * @returns the messages in log order, and the next cursor or null when the page is not full; empty for a group not on the list.
   * @throws {@link RangeError} when `after` is not a cursor of this recorder.
   */
  page(groupId: string, after: string | undefined, limit: number): { items: Message[]; nextCursor: string | null } {
    const row = after === undefined ? 0 : rowOf(after)
    if (row === undefined) throw new RangeError('after is not a cursor of this recorder')
    if (!this.recordedIds.has(groupId)) return { items: [], nextCursor: null }
    const items = this.withMedia(this.store.after(groupId, row, limit))
    return { items, nextCursor: items.length >= limit ? items.at(-1)?.cursor ?? null : null }
  }

  /**
   * Search the recorded groups' messages.
   * @param query - the text to find.
   * @param options - `groupId` limits to one group, `limit` caps the count.
   * @returns the matches, newest first; empty when `groupId` is not on the list.
   */
  search(query: string, options: { groupId?: string; limit: number }): Message[] {
    if (options.groupId !== undefined && !this.recordedIds.has(options.groupId)) return []
    return this.withMedia(this.store.search(query, options).filter(row => this.recordedIds.has(row.groupId)))
  }

  /**
   * The stored messages of a recorded group by their OneBot ids (recalled ones included, text emptied).
   * @param groupId - the QQ group number.
   * @param messageIds - OneBot message ids; only the first 200 are used.
   * @returns the messages found, in the order asked; empty for a group not on the list.
   */
  lookup(groupId: string, messageIds: readonly string[]): Message[] {
    if (!this.recordedIds.has(groupId)) return []
    const rows: MessageRow[] = []
    for (const id of messageIds.slice(0, 200)) {
      const row = this.store.byMessageId(groupId, id)
      if (row !== undefined) rows.push(row)
    }
    return this.withMedia(rows)
  }

  /**
   * The saved image behind a media reference, for `GET /v1/media/{ref}`. Nothing is fetched from QQ here: the file was downloaded when its
   * message arrived (never for a backfilled one), so serving it cannot start a download.
   * @param ref - a reference from a message's `media`.
   * @returns the file content and its header (content type, size, group).
   * @throws {@link MediaNotSaved} when the recorder does not hold that image (images are off, the download failed or was skipped, the file
   *   aged out, the message was recalled, or the group is no longer recorded).
   * @throws {@link RangeError} when the reference is not one of this recorder's.
   */
  async mediaFile(ref: string): Promise<{ bytes: Buffer; header: MediaHeader }> {
    const id = mediaIdOf(ref)
    if (id === undefined) throw new RangeError('not a media reference of this recorder')
    const config = this.live
    if (!config.media.images) throw new MediaNotSaved('images are not saved: media.images is off')
    const item = this.store.mediaById(id)
    if (item === undefined || item.kind !== 'image') throw new MediaNotSaved('there is no saved image with that reference')
    if (!this.recordedIds.has(item.groupId)) throw new MediaNotSaved('that group is no longer recorded')
    if (item.localPath === null) throw new MediaNotSaved(item.error ?? 'the image was not downloaded')
    const contentType = IMAGE_TYPES[extname(item.localPath).toLowerCase()]
    if (contentType === undefined) throw new MediaNotSaved('the saved file is not a picture a model can read')
    let bytes: Buffer
    try {
      bytes = await readFile(item.localPath)
    } catch {
      throw new MediaNotSaved('the saved file is gone')
    }
    if (bytes.length === 0 || bytes.length > config.media.maxImageBytes) throw new MediaNotSaved('the saved file is larger than media.maxImageBytes')
    return { bytes, header: { contentType, bytes: bytes.length, groupId: item.groupId } }
  }

  /**
   * The distinct member names a recorded group's messages show.
   * @param groupId - the QQ group number.
   * @returns the names; empty for a group not on the list.
   */
  members(groupId: string): Member[] {
    return this.recordedIds.has(groupId) ? this.store.members(groupId) : []
  }

  /**
   * The digest state the plugin kept in `qq.db` before it moved to DSH.
   * @returns the old digests, notes, Sessions, alias salt, and last outage notice time.
   */
  legacyState(): LegacyDigestState {
    let outageNoticeAt: number | null = null
    try {
      const saved = JSON.parse(readFileSync(join(this.dataDir, 'outage-notice.json'), 'utf8')) as { lastNoticeAt?: unknown }
      if (typeof saved.lastNoticeAt === 'number' && Number.isFinite(saved.lastNoticeAt)) outageNoticeAt = saved.lastNoticeAt
    } catch {
      // No notice was ever recorded, or the file is unreadable: nothing to carry over.
    }
    return {
      digests: this.store.legacyDigests().map(row => ({
        groupId: row.groupId, fromCursor: cursorOf(row.fromRow), toCursor: cursorOf(row.toRow), messageCount: row.messageCount,
        text: row.text, model: row.model, usage: row.usage, rawPath: row.rawPath, createdAt: row.createdAt,
      })),
      notes: this.store.legacyNotes(),
      groupSessions: this.store.legacySessions(),
      aliasSalt: this.store.getMeta('alias-salt') ?? null,
      outageNoticeAt,
    }
  }

  // ---- events, for the server ----

  /**
   * Listen to the recorder's notices.
   * @param listener - called with each event.
   * @returns the unsubscribe function.
   */
  subscribe(listener: (event: RecorderEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(event: RecorderEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error: unknown) {
        this.deps.logger.debug(`qq-recorder: an event listener threw: ${errorText(error)}`)
      }
    }
  }

  private noteMessage(groupId: string, rowId: number): void {
    const entry = this.pendingEvents.get(groupId) ?? { count: 0, last: 0 }
    entry.count += 1
    entry.last = rowId
    this.pendingEvents.set(groupId, entry)
    if (this.eventTimer !== undefined) return
    this.eventTimer = setTimeout(() => {
      this.eventTimer = undefined
      for (const [id, pending] of this.pendingEvents) this.emit({ type: 'messages', groupId: id, count: pending.count, lastCursor: cursorOf(pending.last) })
      this.pendingEvents.clear()
    }, EVENT_COALESCE_MS)
    this.eventTimer.unref()
  }

  // ---- the login door ----

  private toLogin(result: DoorResult): Login {
    if (result.kind !== 'ok') return { door: result.kind, state: null, uin: null, nickname: null, error: null, qrUrl: null }
    return { door: 'ok', state: result.login, uin: result.uin, nickname: result.nickname, error: result.error, qrUrl: result.qrUrl }
  }

  /**
   * NapCat's login as the login door reports it. When NapCat turns out to be logged in while the recorder is still backing off, the
   * recorder reconnects at once, so a scan ends in "connected" within seconds. Answers are shared for 1.5 s.
   * @param options - `fresh` skips the shared answer.
   * @returns the login state; `door` says whether the door answered.
   */
  async loginStatus(options: { fresh?: boolean } = {}): Promise<Login> {
    let login = await this.loginView(options.fresh === true)
    if (this.connState === 'connected' && login.door === 'ok' && login.state !== null && STALE_PHASES.has(login.state)) {
      login = { ...login, state: 'online', uin: login.uin ?? (this.selfId === '' ? null : this.selfId), qrUrl: null }
    }
    if (login.state === 'online' && (this.connState === 'reconnecting' || this.connState === 'starting') && this.now() - this.lastWakeAt >= WAKE_GAP_MS) {
      this.lastWakeAt = this.now()
      this.deps.logger.info('qq-recorder: NapCat is logged in; reconnecting now')
      this.wakeRetry?.()
    }
    return login
  }

  /**
   * Ask NapCat for a fresh login QR code. Refused while QQ is logged in and for ten minutes after the connection came up.
   * @returns whether a code was requested, and the reason when refused.
   */
  async refreshLogin(): Promise<Refresh> {
    let refusal: Refresh['reason'] = null
    if (this.connState === 'connected') refusal = 'logged-in'
    else if (this.openedAt !== undefined && this.now() - this.openedAt < RECENT_LOGIN_MS) refusal = 'recently-logged-in'
    const token = refusal !== null || this.door === undefined ? undefined : this.token()
    let refreshed = false
    if (refusal === null && this.door !== undefined && token !== undefined) {
      const answer = await this.door.refresh(token)
      refreshed = answer.refreshed
      refusal = answer.refreshed ? null : answer.reason ?? 'unreachable'
      this.loginCache = { at: this.now(), login: this.toLogin(answer.result) }
      this.noteLogin(this.loginCache.login)
    }
    this.deps.logger.info(`qq-recorder: asked NapCat for a fresh login QR from the settings page (${refreshed ? 'done' : `not done: ${refusal ?? 'no door'}`})`)
    return { login: await this.loginStatus(), refreshed, reason: refusal }
  }

  private loginView(fresh: boolean): Promise<Login> {
    const door = this.door
    if (door === undefined) return Promise.resolve({ door: 'disabled', state: null, uin: null, nickname: null, error: null, qrUrl: null })
    const cached = this.loginCache
    const ttl = this.connState === 'connected' || cached?.login.state === 'online' ? ONLINE_CACHE_MS : LOGIN_CACHE_MS
    if (!fresh && cached !== undefined && this.now() - cached.at < ttl) return Promise.resolve(cached.login)
    if (!fresh && this.loginInFlight !== undefined) return this.loginInFlight
    const read = (async (): Promise<Login> => {
      const token = this.token()
      const login = this.toLogin(token === undefined ? { kind: 'unauthorized' } : await door.status(token))
      this.loginCache = { at: this.now(), login }
      this.noteLogin(login)
      return login
    })().finally(() => { if (this.loginInFlight === read) this.loginInFlight = undefined })
    this.loginInFlight = read
    return read
  }

  /** Log a change of the login picture once, by state name only: never the code or the link. */
  private noteLogin(login: Login): void {
    const key = login.door === 'ok' ? `login:${login.state}` : `door:${login.door}`
    if (key === this.lastLoginKey) return
    this.lastLoginKey = key
    if (login.door !== 'ok') {
      this.deps.logger.info(`qq-recorder: login door: ${login.door}`)
      return
    }
    const wording: Record<string, string> = {
      online: `logged in${login.uin === null ? '' : ` as ${login.uin}`}`,
      offline: 'offline, needs a new login',
      qr: 'waiting for a scan',
      scanned: 'scanned, completing',
      'logging-in': 'logging in',
      preparing: 'preparing a QR code',
      restarting: 'reconnecting to Tencent',
      unknown: 'in a state this version does not know',
    }
    this.deps.logger.info(`qq-recorder: NapCat login: ${wording[login.state ?? 'unknown'] ?? 'unknown'}`)
  }

  // ---- plumbing ----

  private setConnection(state: Status['connection']['state']): void {
    if (state === this.connState) return
    this.connState = state
    this.connSince = this.now()
    this.emit({ type: 'status', status: this.status() })
  }

  private track(work: Promise<void>): void {
    const tracked = work.catch((error: unknown) => {
      this.deps.logger.info(`qq-recorder: background work failed: ${errorText(error)}`)
    }).finally(() => this.inflight.delete(tracked))
    this.inflight.add(tracked)
  }

  /** The connection loop's wait; a login that turned out to be back, or a new configuration, ends it early. */
  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.abort.signal.removeEventListener('abort', done)
        if (this.wakeRetry === done) this.wakeRetry = undefined
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.wakeRetry = done
      this.abort.signal.addEventListener('abort', done, { once: true })
    })
  }

  /** A pause that ends early only when the recorder stops. */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.abort.signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.abort.signal.addEventListener('abort', done, { once: true })
    })
  }

  private credentialState = ''

  /** The protocol end's token; undefined while it is missing. Never logged. */
  private token(): string | undefined {
    const name = this.config?.tokenEnv
    const value = name === undefined ? '' : this.deps.secret(name)?.trim() ?? ''
    const state = value === '' ? 'missing' : 'present'
    if (state !== this.credentialState) {
      this.credentialState = state
      this.deps.logger.info(state === 'missing'
        ? `qq-recorder: ${name ?? 'the token variable'} is not set; QQ stays offline and re-checks every 30 s`
        : 'qq-recorder: the OneBot access token was found')
    }
    return value === '' ? undefined : value
  }

  /** Stay connected while the recorder runs. */
  private async run(): Promise<void> {
    let failures = 0
    while (!this.stopping) {
      if (this.config === undefined) {
        this.setConnection('waiting-config')
        await this.pause(WAIT_CONFIG_MS)
        continue
      }
      const token = this.token()
      if (token === undefined) {
        this.setConnection('waiting-token')
        await this.pause(30_000)
        continue
      }
      const client = new OneBotClient({ url: this.config.url, token, ...this.deps.oneBot })
      const connAbort = new AbortController()
      const onStop = (): void => { connAbort.abort() }
      this.abort.signal.addEventListener('abort', onStop, { once: true })
      this.connAbort = connAbort
      this.client = client
      this.reconfigured = false
      let upAt: number | undefined
      try {
        await client.run({
          event: (event) => { this.track(this.handleEvent(event)) },
          open: () => {
            upAt = this.now()
            this.disconnectedSince = undefined
            this.botOfflineAt = undefined
            this.attempt = 0
            this.lastError = undefined
            this.openedAt = this.now()
            this.setConnection('connected')
            this.deps.logger.info(`qq-recorder: connected to the protocol end at ${this.config?.url ?? ''}`)
            this.track(this.onOpen())
          },
          close: (reason) => {
            this.lastError = `the connection closed (${reason})`
            this.deps.logger.info(`qq-recorder: the protocol end connection closed (${reason})`)
          },
        }, connAbort.signal)
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- stop() and reconfigure() set these during the await.
        if (this.stopping) return
      } catch (error: unknown) {
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- stop() and reconfigure() set these during the await.
        if (this.stopping) return
        this.lastError = errorText(error)
        this.deps.logger.info(`qq-recorder: could not reach the protocol end: ${errorText(error)}`)
      } finally {
        this.abort.signal.removeEventListener('abort', onStop)
        this.client = undefined
        this.connAbort = undefined
      }
      if (upAt !== undefined) {
        this.lastDisconnectAt = this.now()
        this.touchAlive()
      }
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- stop() and reconfigure() set these during the await.
      if (this.reconfigured) {
        failures = 0
        this.setConnection('starting')
        continue
      }
      this.disconnectedSince ??= this.now()
      failures = upAt !== undefined && this.now() - upAt >= STABLE_MS ? 1 : failures + 1
      this.attempt = failures
      this.setConnection('reconnecting')
      const wait = Math.min(FIRST_RETRY_MS * 2 ** (failures - 1), MAX_RETRY_MS)
      this.deps.logger.info(`qq-recorder: reconnecting in ${wait / 1000} s (attempt ${failures})`)
      await this.pause(wait)
    }
  }

  private get connectionStateFile(): string {
    return join(this.dataDir, 'connection-state.json')
  }

  private loadConnectionState(): void {
    try {
      const saved = JSON.parse(readFileSync(this.connectionStateFile, 'utf8')) as Record<string, unknown>
      for (const key of ['lastAliveAt', 'lastGroupListAt', 'lastBackfillAt'] as const) {
        const value = saved[key]
        if (typeof value === 'number' && Number.isFinite(value)) this.connectionState[key] = value
      }
    } catch {
      // A first start, or an unreadable file: nothing is known, so nothing is skipped.
    }
  }

  private saveConnectionState(): void {
    try {
      writeFileSync(this.connectionStateFile, JSON.stringify(this.connectionState), { mode: 0o600 })
    } catch (error: unknown) {
      if (!this.connectionStateWarned) this.deps.logger.error(`qq-recorder: could not remember the connection state: ${errorText(error)}`)
      this.connectionStateWarned = true
    }
  }

  private touchAlive(): void {
    this.connectionState.lastAliveAt = this.now()
    this.saveConnectionState()
  }

  /** After a connection opens: who we are, which groups, and what was missed. */
  private async onOpen(): Promise<void> {
    const client = this.client
    if (client === undefined) return
    const { reconnectQuietMs } = this.live
    const last = this.connectionState.lastAliveAt
    this.quietOpen = reconnectQuietMs > 0 && last !== undefined && this.now() - last < reconnectQuietMs
    if (this.quietOpen && last !== undefined) {
      this.deps.logger.info(`qq-recorder: the last connection was connected ${Math.round((this.now() - last) / 60_000)} min ago; not backfilling and not fetching the group list this time`)
    }
    this.touchAlive()
    try {
      const me = await client.call<{ user_id?: number | string; nickname?: string }>('get_login_info')
      this.selfId = String(me.user_id ?? '')
      this.deps.logger.info(`qq-recorder: logged in as ${this.selfId}`)
      this.emit({ type: 'status', status: this.status() })
    } catch (error: unknown) {
      this.deps.logger.info(`qq-recorder: get_login_info failed: ${errorText(error)}`)
    }
    if (!this.quietOpen) await this.refreshGroups()
    if (this.live.backfill.enabled && !this.quietOpen) await this.backfillOnOpen(client)
  }

  /**
   * Catch up on what was missed, gently: not after a connection that follows the previous drop closely, at most
   * `maxGroups` groups per connection, one small page per group, and a pause between groups.
   */
  private async backfillOnOpen(client: OneBotClient): Promise<void> {
    const { skipWithinMs, maxGroups, minIntervalMs } = this.live.backfill
    if (skipWithinMs > 0 && this.lastDisconnectAt !== undefined && this.now() - this.lastDisconnectAt < skipWithinMs) {
      this.deps.logger.info(`qq-recorder: the previous connection dropped ${Math.round((this.now() - this.lastDisconnectAt) / 60_000)} min ago; not backfilling this time`)
      return
    }
    const lastBackfill = this.connectionState.lastBackfillAt
    if (minIntervalMs > 0 && lastBackfill !== undefined && this.now() - lastBackfill < minIntervalMs) {
      this.deps.logger.info(`qq-recorder: the last backfill was ${Math.round((this.now() - lastBackfill) / 60_000)} min ago; not backfilling this time`)
      return
    }
    const ids = [...this.recordedIds]
    if (ids.length === 0) return
    this.connectionState.lastBackfillAt = this.now()
    this.saveConnectionState()
    const start = this.backfillCursor % ids.length
    const turn = [...ids.slice(start), ...ids.slice(0, start)].slice(0, maxGroups)
    this.backfillCursor = (start + turn.length) % ids.length
    if (turn.length < ids.length) this.deps.logger.info(`qq-recorder: backfilling ${turn.length} of ${ids.length} group(s) now; the others follow on later connections`)
    await this.queueBackfill(turn, client)
  }

  /** Backfill groups one at a time, behind any backfill already running, with a pause (and jitter) between two groups. */
  private queueBackfill(ids: readonly string[], client: OneBotClient): Promise<void> {
    const run = async (): Promise<void> => {
      for (const groupId of ids) {
        if (this.superseded(client)) return
        const wait = this.lastBackfillEnd + this.backfillGap() - Date.now()
        if (this.lastBackfillEnd > 0 && wait > 0) await this.delay(wait)
        if (this.superseded(client)) return
        await this.backfill(groupId).catch((error: unknown) => {
          this.deps.logger.info(`qq-recorder: backfill of group ${groupId} failed: ${errorText(error)}`)
        })
        this.lastBackfillEnd = Date.now()
      }
    }
    this.backfillTail = this.backfillTail.then(run, run)
    return this.backfillTail
  }

  private superseded(client: OneBotClient): boolean {
    return this.stopping || this.client !== client
  }

  private backfillGap(): number {
    const gap = this.live.backfill.gapMs
    return gap + Math.random() * gap / 2
  }

  private async refreshGroups(): Promise<void> {
    const client = this.client
    if (client === undefined) return
    const last = this.connectionState.lastGroupListAt
    if (last !== undefined && this.now() - last < GROUP_REFRESH_MS) return
    try {
      const list = await client.call<Array<{ group_id: number | string; group_name?: string; member_count?: number }>>('get_group_list')
      const now = this.now()
      for (const group of list) {
        const groupId = String(group.group_id)
        this.store.upsertGroup({ groupId, name: group.group_name ?? groupId, memberCount: group.member_count }, now)
      }
      this.connectionState.lastGroupListAt = now
      this.saveConnectionState()
      const missing = [...this.recordedIds].filter(id => !list.some(group => String(group.group_id) === id))
      this.deps.logger.info(`qq-recorder: the account is in ${list.length} group(s); ${this.recordedIds.size - missing.length} of the ${this.recordedIds.size} listed one(s) found${missing.length === 0 ? '' : `; not a member of ${missing.join(', ')}`}`)
    } catch (error: unknown) {
      this.deps.logger.info(`qq-recorder: get_group_list failed: ${errorText(error)}`)
    }
  }

  /** Fetch a group's history backwards until it meets a message already stored, or the cap. */
  private async backfill(groupId: string): Promise<void> {
    const client = this.client
    if (client === undefined) return
    let seq: string | undefined
    let fetched = 0
    let added = 0
    while (fetched < this.live.backfill.maxMessages && this.client === client) {
      let data: { messages?: OneBotEvent[] }
      try {
        data = await client.call<{ messages?: OneBotEvent[] }>('get_group_msg_history', { group_id: Number(groupId), count: Math.min(50, this.live.backfill.maxMessages - fetched), ...seq === undefined ? {} : { message_seq: Number(seq) } })
      } catch (error: unknown) {
        if (seq !== undefined || !NO_HISTORY.test(errorText(error))) throw error
        this.deps.logger.info(`qq-recorder: group ${groupId} has no history to backfill`)
        return
      }
      const messages = data.messages ?? []
      if (messages.length === 0) break
      let known = false
      for (const message of [...messages].reverse()) {
        fetched += 1
        if (this.store.hasMessage(groupId, String(message.message_id))) known = true
        else if (this.record({ ...message, post_type: 'message', message_type: 'group', group_id: groupId }, true)) added += 1
      }
      const oldest = messages[0]?.message_seq === undefined ? undefined : String(messages[0].message_seq)
      if (known || oldest === undefined || oldest === seq) break
      seq = oldest
    }
    if (added > 0) this.deps.logger.info(`qq-recorder: backfilled ${added} message(s) of group ${groupId}`)
  }

  // ---- events from the protocol end ----

  private async handleEvent(event: OneBotEvent): Promise<void> {
    if (event.post_type === 'message') {
      if (event.message_type === 'group') {
        this.record(event, false)
      } else {
        this.counters.private += 1
      }
      return
    }
    if (event.post_type !== 'notice') return
    if (event.notice_type === 'group_recall' && this.config?.honorRecall === true) {
      await this.onRecall(String(event.group_id ?? ''), String(event.message_id ?? ''))
    } else if (event.notice_type === 'bot_offline') {
      this.botOfflineAt = this.now()
      this.deps.logger.info('qq-recorder: the protocol end reports the account went offline')
      this.emit({ type: 'bot-offline', at: this.botOfflineAt })
      this.emit({ type: 'status', status: this.status() })
    }
  }

  private async onRecall(groupId: string, messageId: string): Promise<void> {
    if (!this.recordedIds.has(groupId)) return
    const paths = this.store.recall(groupId, messageId)
    if (paths === undefined) return
    for (const path of paths) await removeMedia(path)
    this.deps.logger.info(`qq-recorder: a message of group ${groupId} was recalled; its text and ${paths.length} file(s) were dropped`)
  }

  /** Record a group message when its group is listed. @returns whether a new row was stored. */
  private record(event: OneBotEvent, backfilled: boolean): boolean {
    const groupId = String(event.group_id ?? '')
    const userId = String(event.user_id ?? event.sender?.user_id ?? '')
    if (groupId === '' || userId === '' || event.message_id === undefined) return false
    if (userId === this.selfId && this.selfId !== '') return false
    if (!this.recordedIds.has(groupId)) {
      this.counters.dropped += 1
      this.unlistedCounts.set(groupId, (this.unlistedCounts.get(groupId) ?? 0) + 1)
      if (!this.seenUnlisted.has(groupId)) {
        this.seenUnlisted.add(groupId)
        this.deps.logger.info(`qq-recorder: not recording group ${groupId}${this.store.groupName(groupId) === undefined ? '' : ` (${this.store.groupName(groupId)})`}: it is not in groups`)
      }
      return false
    }
    const parsed = parseMessage(event.message)
    const sender = event.sender ?? {}
    const at = typeof event.time === 'number' ? event.time * 1000 : this.now()
    const row = this.store.insertMessage({
      groupId, messageId: String(event.message_id), seq: event.message_seq === undefined ? undefined : String(event.message_seq), at,
      userId, nickname: sender.nickname ?? '', card: sender.card ?? '', role: sender.role ?? '', text: parsed.text, replyTo: parsed.replyTo,
      kinds: parsed.kinds, raw: JSON.stringify(event.message ?? []), backfilled,
    }, parsed.media, this.now())
    if (row === undefined) return false
    this.counters.messages += 1
    this.deps.logger.debug(`qq-recorder: recorded message ${event.message_id} of group ${groupId} from ${displayName(sender, userId)} (${Array.from(parsed.text).length} chars, ${parsed.media.length} media)`)
    for (const media of this.store.mediaOf(row)) {
      const item: MediaJob = {
        rowId: row, groupId, at, mediaId: media.id, kind: media.kind,
        url: media.url ?? undefined, file: media.file ?? undefined, name: media.name ?? undefined,
      }
      // A backfilled message is old: its files are not fetched (that is more traffic to the CDN and the account), only noted.
      if (backfilled) this.store.setMediaError(media.id, 'not fetched for a backfilled message')
      else this.enqueue(() => this.fetchMedia(item))
    }
    if (!backfilled) this.noteMessage(groupId, row)
    return true
  }

  // ---- media ----

  private enqueue(job: () => Promise<void>): void {
    this.downloadQueue.push(job)
    this.pump()
  }

  private pump(): void {
    while (this.downloadsRunning < MEDIA_CONCURRENCY && this.downloadQueue.length > 0) {
      const job = this.downloadQueue.shift()
      if (job === undefined) break
      this.downloadsRunning += 1
      this.track(job().finally(() => { this.downloadsRunning -= 1; this.pump() }))
    }
  }

  private overBudget(): boolean {
    const maxTotal = this.live.media.maxTotalBytes
    if (this.store.mediaBytes() < maxTotal) return false
    if (this.now() - this.budgetWarnedAt > 3_600_000) {
      this.budgetWarnedAt = this.now()
      this.deps.logger.info(`qq-recorder: downloads reached media.maxTotalBytes (${maxTotal}); new media is not downloaded`)
    }
    return true
  }

  private async fetchMedia(item: MediaJob): Promise<void> {
    const { rowId, groupId, at, mediaId, kind, url, name } = item
    const media = this.live.media
    try {
      if (kind === 'image') {
        if (!media.images || url === undefined || this.overBudget()) return
        if (!isAllowedMediaUrl(url, media.hostSuffixes)) {
          this.store.setMediaError(mediaId, 'the address is not on media.hostSuffixes')
          return
        }
        const bytes = await fetchCapped(url, media.maxImageBytes, media.timeoutMs, this.deps.fetch)
        const saved = await saveMedia(this.dataDir, groupId, at, bytes, detectExtension(bytes, 'image', name))
        this.store.setMediaFile(mediaId, { localPath: saved.path, sha256: saved.sha256, bytes: saved.bytes })
        this.counters.media += 1
      } else if (kind === 'voice') {
        await this.fetchVoice(item)
      }
    } catch (error: unknown) {
      this.store.setMediaError(mediaId, errorText(error))
      this.deps.logger.debug(`qq-recorder: could not fetch ${kind} of message row ${rowId}: ${errorText(error)}`)
    }
  }

  /** Fetch a voice message as MP3 through the protocol end (which decodes QQ's SILK) and keep it. */
  private async fetchVoice(item: MediaJob): Promise<void> {
    const { rowId, groupId, at, mediaId, url, file, name } = item
    const live = this.live
    if (!live.voice.download || this.overBudget()) return
    let bytes: Buffer | undefined
    const client = this.client
    if (client !== undefined && file !== undefined) {
      try {
        const data = await client.call<{ base64?: string; file?: string }>('get_record', { file, out_format: 'mp3' })
        if (typeof data.base64 === 'string' && data.base64 !== '') bytes = Buffer.from(data.base64, 'base64')
      } catch (error: unknown) {
        this.deps.logger.debug(`qq-recorder: get_record failed for message row ${rowId}: ${errorText(error)}`)
      }
    }
    if (bytes === undefined && url !== undefined && isAllowedMediaUrl(url, live.media.hostSuffixes)) {
      bytes = await fetchCapped(url, live.voice.maxBytes, live.media.timeoutMs, this.deps.fetch)
    }
    if (bytes === undefined) {
      this.store.setMediaError(mediaId, 'the protocol end gave no audio')
      return
    }
    if (bytes.length > live.voice.maxBytes) {
      this.store.setMediaError(mediaId, `audio exceeds ${live.voice.maxBytes} bytes`)
      return
    }
    const saved = await saveMedia(this.dataDir, groupId, at, bytes, detectExtension(bytes, 'voice', name))
    this.store.setMediaFile(mediaId, { localPath: saved.path, sha256: saved.sha256, bytes: saved.bytes })
    this.counters.voices += 1
  }

  // ---- schedule ----

  /** Media retention, the group list, and the statistics line, until the recorder stops. */
  private async scheduled(): Promise<void> {
    let lastRetention = 0
    let lastGroups = this.now()
    await this.delay(30_000)
    while (!this.stopping) {
      try {
        if (this.config !== undefined) {
          if (this.now() - lastRetention >= RETENTION_CHECK_MS) {
            lastRetention = this.now()
            await this.prune()
          }
          if (this.client?.connected === true && this.now() - lastGroups >= GROUP_REFRESH_MS) {
            lastGroups = this.now()
            await this.refreshGroups()
          }
        }
        this.logStats()
      } catch (error: unknown) {
        this.deps.logger.error(`qq-recorder: scheduled work failed: ${errorText(error)}`)
      }
      await this.delay(SCHEDULE_MS)
    }
  }

  private logStats(): void {
    const c = this.counters
    if (this.unlistedCounts.size > 0 && c.dropped > 0) {
      const top = this.groups().filter(group => !group.recorded).slice(0, 30).map(group => `${group.groupId} ${group.name} ${group.unlistedSeen}`).join(' | ')
      this.deps.logger.info(`qq-recorder: messages seen per unlisted group since ${new Date(this.startedAt).toISOString()} (counts only, nothing kept): ${top}`)
    }
    if (c.messages + c.dropped + c.private + c.media + c.voices === 0) return
    this.deps.logger.info(`qq-recorder: since the last report: ${c.messages} message(s) recorded, ${c.media} image(s) and ${c.voices} voice(s) saved, ${c.dropped} from unlisted groups dropped, ${c.private} private message(s) ignored; downloads hold ${this.store.mediaBytes()} bytes`)
    this.counters.messages = this.counters.media = this.counters.voices = this.counters.dropped = this.counters.private = 0
  }

  /** Apply the retention windows: raw messages older than `retention.textDays`, downloads older than `media.retainDays`. */
  async prune(): Promise<void> {
    const { retainDays } = this.live.media
    if (retainDays > 0) {
      const expired = this.store.expiredMedia(this.now() - retainDays * 86_400_000)
      for (const item of expired) {
        await removeMedia(item.localPath)
        this.store.clearMediaFile(item.id)
      }
      if (expired.length > 0) this.deps.logger.info(`qq-recorder: removed ${expired.length} download(s) older than ${retainDays} day(s)`)
    }
    const { textDays } = this.live.retention
    if (textDays > 0) {
      const gone = this.store.pruneMessages(this.now() - textDays * 86_400_000)
      for (const path of gone.files) await removeMedia(path)
      if (gone.messages > 0) this.deps.logger.info(`qq-recorder: deleted ${gone.messages} message(s) older than ${textDays} day(s) and ${gone.files.length} file(s)`)
    }
  }
}
