/**
 * QQ group observer: a personal QQ account, reached through a OneBot v11 protocol end (NapCat) on this machine,
 * lurks in the groups the owner lists. The channel records their messages, downloads their images, transcribes
 * their voice messages when asked, digests them on a schedule, and lets the agent read all of it. It never speaks:
 * sending is off, and turns on only per group, for code that asks for it. Nothing is a chat entrance for the agent.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { ForkNotifier } from '@deepseek-ai/dsh-fork-event-bus'
// Type-only: the `loader/volatile-update` event the group list follows.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-title'
import z from '@deepseek-ai/schemastery'
import { DigestRunner, type DigestConfig } from './digest.ts'
import { DEFAULT_MEDIA_HOST_SUFFIXES, detectExtension, fetchCapped, isAllowedMediaUrl, removeMedia, saveMedia } from './media.ts'
import { LoginDoor, type DoorResult } from './login.ts'
import { isPrivateAddress, isPrivateUrl, OneBotClient, type OneBotEvent } from './onebot.ts'
import type { QqConnection, QqLoginReading } from './status.ts'
import { displayName, parseMessage } from './text.ts'
import { QqStore, type DigestRow, type GroupStats, type MessageRow } from './store.ts'

export * from './digest.ts'
export * from './login.ts'
export * from './media.ts'
export * from './onebot.ts'
export * from './status.ts'
export * from './store.ts'
export * from './text.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The QQ group observer. */
    forkQq: QqObserver
  }
}

/** Channel configuration. */
export interface Config {
  /** WebSocket address of the protocol end (NapCat's OneBot server); it must be on this machine or the tailnet. */
  url: string
  /** Credential holding the protocol end's access token. */
  tokenEnv: string
  /**
   * Group numbers to record. Empty records nothing; messages of every other group are dropped on arrival. Volatile: the
   * Settings page's QQ section adds and removes groups at run time and the observer follows without a restart.
   */
  groups: Volatile<string[]>
  /** Directory of the database and downloads; defaults to `<DSH_HOME>/fork-qq`. */
  dataDir?: string
  /** Image downloads: what is fetched, from where, and how much is kept. */
  media: {
    /** Download the images of recorded messages. */
    images: boolean
    /** Largest image downloaded, in bytes. */
    maxImageBytes: number
    /** Stop downloading once the downloads together reach this many bytes. */
    maxTotalBytes: number
    /** Delete downloads of messages older than this many days; 0 keeps them. 30 by default. */
    retainDays: number
    /** Hosts media may be fetched from, as suffixes. */
    hostSuffixes: string[]
    /** Deadline of one download, in milliseconds. */
    timeoutMs: number
  }
  /** Keep voice messages and, with `asr.enabled`, transcribe them. */
  voice: {
    /** Fetch the audio of voice messages. */
    download: boolean
    /** Largest audio kept, in bytes. */
    maxBytes: number
  }
  /** Voice transcription. */
  asr: {
    /** Send voice messages to `ctx.forkVoice.transcribe`. Off by default; it needs fork-voice with transcription on. */
    enabled: boolean
  }
  /** How long raw messages are kept. Digests are not affected and can be deleted by group or date. */
  retention: {
    /** Delete messages (text, raw segments, media rows) older than this many days; 0 keeps them. 30 by default. */
    textDays: number
  }
  /** Drop the text and files of a message its sender recalled. */
  honorRecall: boolean
  /** Fetch what was missed while disconnected. */
  backfill: {
    /** Fetch history after each connection. */
    enabled: boolean
    /** Messages fetched per group at most. */
    maxMessages: number
  }
  /** Sending to a group. Off, and a group must be listed too; nothing in this package calls it on its own. */
  send: {
    /** Allow `sendGroupMessage` at all. */
    enabled: boolean
    /** Groups sending is allowed in, on top of `enabled`. */
    groups: string[]
    /** Seconds between two sends to one group, at least. */
    minIntervalSec: number
    /** Sends per group per day, at most. */
    maxPerDay: number
  }
  /** Scheduled digests of the recorded groups, made by one-turn Sessions. */
  digest: {
    /** Digest each recorded group on a schedule. */
    enabled: boolean
    /** Hours between digests of one group. */
    everyHours: number
    /** A group with fewer new messages than this waits for the next round. */
    minMessages: number
    /** Characters of transcript per model call; a longer backlog is cut into several calls. */
    maxPromptChars: number
    /** Model calls one group may use in one round. */
    maxCallsPerRound: number
    /** Show members to the model, and so in the digests, as stable aliases (`群友#a3f9`), never names or QQ numbers. */
    aliasMembers: boolean
    /** Ask for the section on what members know or argued, by alias. Off by default: no per-member profiles. */
    profiles: boolean
    /** Digests kept per group; the oldest are deleted when a new one is stored. */
    keepPerGroup: number
    /** Longest digest stored, in characters. */
    maxDigestChars: number
    /** Provider route of the digest Session's model; the profile's default when omitted. */
    provider?: string
    /** Model id on that route; the profile's default when omitted. */
    model?: string
    /** Agent preset of the digest Session; the bundle defines `qq-digest` with a persona and no tools. */
    agentPreset: string
    /** Permission preset set on the digest Session. */
    permissionPreset: string
    /** Absolute working directory of the digest Sessions. */
    workspacePath: string
    /** IANA zone the transcript's times are written in. */
    timeZone: string
    /** How long to wait for one model call, in milliseconds. */
    timeoutMs: number
  }
  /** Tell the owner when the protocol end has been unreachable this long, in milliseconds; 0 turns it off. */
  offlineNoticeMs: number
  /**
   * While an outage lasts, remind the owner again after this long, in milliseconds; 0 never repeats. What was told is kept
   * on disk, so a reload or deploy in the middle of an outage does not tell again. 24 hours by default.
   */
  offlineRepeatMs: number
  /** Where the Settings page lives, quoted in the owner notice (the event service's address); unset names the page without a link. */
  settingsUrl?: string
  /** The login door: the window onto NapCat's login that the Settings page's QQ section uses. */
  login: {
    /** Ask the door at all. */
    enabled: boolean
    /** The door's address; it must be on this machine or the tailnet. */
    url: string
    /** Deadline of one call to the door, in milliseconds. */
    timeoutMs: number
  }
}

/** Configuration schema. */
export const Config = z.object({
  url: z.string().default('ws://127.0.0.1:3001'),
  tokenEnv: z.string().role('credential-ref').default('FORK_QQ_ONEBOT_TOKEN'),
  groups: z.array(z.string()).default([]).volatile(),
  dataDir: z.string(),
  media: z.object({
    images: z.boolean().default(true),
    maxImageBytes: z.natural().min(1024).default(15 * 1024 * 1024),
    maxTotalBytes: z.natural().min(1024).default(5 * 1024 ** 3),
    retainDays: z.natural().default(30),
    hostSuffixes: z.array(z.string()).default([...DEFAULT_MEDIA_HOST_SUFFIXES]),
    timeoutMs: z.natural().min(1000).default(30_000),
  }),
  voice: z.object({
    download: z.boolean().default(true),
    maxBytes: z.natural().min(1024).default(10 * 1024 * 1024),
  }),
  asr: z.object({ enabled: z.boolean().default(false) }),
  retention: z.object({ textDays: z.natural().default(30) }),
  honorRecall: z.boolean().default(true),
  backfill: z.object({
    enabled: z.boolean().default(true),
    maxMessages: z.natural().min(1).default(300),
  }),
  send: z.object({
    enabled: z.boolean().default(false),
    groups: z.array(z.string()).default([]),
    minIntervalSec: z.natural().min(1).default(60),
    maxPerDay: z.natural().min(1).default(10),
  }),
  digest: z.object({
    enabled: z.boolean().default(true),
    everyHours: z.natural().min(1).default(24),
    minMessages: z.natural().min(1).default(15),
    maxPromptChars: z.natural().min(2000).default(60_000),
    maxCallsPerRound: z.natural().min(1).default(5),
    aliasMembers: z.boolean().default(true),
    profiles: z.boolean().default(false),
    keepPerGroup: z.natural().min(1).default(200),
    maxDigestChars: z.natural().min(500).default(3000),
    provider: z.string(),
    model: z.string(),
    agentPreset: z.string().default('qq-digest'),
    permissionPreset: z.string().default('read-only'),
    workspacePath: z.string().default('/Users/dsh-runtime/qq-digest'),
    timeZone: z.string().default('Asia/Shanghai'),
    timeoutMs: z.natural().min(10_000).default(15 * 60_000),
  }),
  offlineNoticeMs: z.natural().default(10 * 60_000),
  offlineRepeatMs: z.natural().default(24 * 3_600_000),
  settingsUrl: z.string(),
  login: z.object({
    enabled: z.boolean().default(true),
    url: z.string().default('http://127.0.0.1:3002'),
    timeoutMs: z.natural().min(500).default(5000),
  }),
})

/** First retry delay after a failed connection; doubles up to {@link MAX_RETRY_MS}. */
const FIRST_RETRY_MS = 2000
const MAX_RETRY_MS = 120_000
/** A connection that stayed up this long resets the retry delay. */
const STABLE_MS = 60_000
/** Group list refresh period. */
const GROUP_REFRESH_MS = 3_600_000
/** Digest schedule check and media retention check periods. */
const DIGEST_CHECK_MS = 10 * 60_000
const RETENTION_CHECK_MS = 6 * 3_600_000
/** Downloads running at once. */
const MEDIA_CONCURRENCY = 2
/** The login half of a panel answer is shared this long, so open pages cost the door at most one call each. */
const LOGIN_CACHE_MS = 1500
/** NapCat logged in while the observer is still backing off: reconnect at once, but not more often than this. */
const WAKE_GAP_MS = 10_000

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

/** Fail at load on configuration that cannot work. */
function assertConfig(config: Config): void {
  if (!isPrivateUrl(config.url)) throw new Error('fork-qq: url must be a ws:// or wss:// address on this machine (127.0.0.1, localhost) or the tailnet (100.64.0.0/10, *.ts.net)')
  if (config.dataDir !== undefined && !isAbsolute(config.dataDir)) throw new Error('fork-qq: dataDir must be an absolute path')
  if (!isPrivateAddress(config.login.url, ['http:', 'https:'])) throw new Error('fork-qq: login.url must be an http(s) address on this machine (127.0.0.1, localhost) or the tailnet (100.64.0.0/10, *.ts.net)')
  if (config.settingsUrl !== undefined && !/^https?:\/\//.test(config.settingsUrl)) throw new Error('fork-qq: settingsUrl must be an http(s) address')
  if (!isAbsolute(config.digest.workspacePath)) throw new Error('fork-qq: digest.workspacePath must be an absolute path')
  for (const id of [...config.groups.get(), ...config.send.groups]) {
    if (!/^[0-9]{3,20}$/.test(id)) throw new Error(`fork-qq: ${JSON.stringify(id)} is not a group number (digits only)`)
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.digest.timeZone })
  } catch {
    throw new Error(`fork-qq: digest.timeZone "${config.digest.timeZone}" is not a valid IANA time zone`)
  }
}

/** Human-readable error text. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A send the channel refused. */
export class SendRefused extends Error {}

/** One group in {@link QqObserver.groupOverview}. */
export interface GroupOverview {
  groupId: string
  name: string
  memberCount: number | null
  /** Whether the group is on the `groups` list. */
  recorded: boolean
  messages: number
  firstAt: number | null
  lastAt: number | null
  lastDigestAt: number | null
}

/**
 * The observer. Provides `ctx.forkQq`, whose read methods the agent tools use; its connection to the protocol end
 * and its writes to the database are the only things it does on its own.
 */
export class QqObserver extends Service {
  static inject = ['sessionController', 'permissionPresets', 'sessionTitle', 'credentials']
  static Config = Config

  readonly dataDir: string
  readonly store: QqStore
  private readonly abort = new AbortController()
  private readonly inflight = new Set<Promise<void>>()
  private recordedCache: { source: readonly string[]; ids: ReadonlySet<string> } | undefined
  private readonly digest: DigestRunner
  private client: OneBotClient | undefined
  private loop: Promise<void> | undefined
  private stopping = false
  private selfId = ''
  private credentialState = ''
  private readonly seenUnlisted = new Set<string>()
  /** Messages seen per unlisted group since start: a count only, nothing of them is kept. */
  private readonly unlistedCounts = new Map<string, number>()
  private readonly startedAt = Date.now()
  private readonly lastSend = new Map<string, number>()
  private readonly sentToday = new Map<string, { day: string; count: number }>()
  private downloadsRunning = 0
  private readonly downloadQueue: Array<() => Promise<void>> = []
  private budgetWarnedAt = 0
  private disconnectedSince: number | undefined
  /** When the owner was last told of the current outage; kept in `outage-notice.json`, cleared when the connection comes back. */
  private lastNoticeAt: number | undefined
  private connState: QqConnection['state'] = 'starting'
  private connSince: number | undefined
  private attempt = 0
  private lastError: string | undefined
  private readonly door: LoginDoor | undefined
  private loginCache: { at: number; login: QqLoginReading } | undefined
  private loginInFlight: Promise<QqLoginReading> | undefined
  private lastLoginKey = ''
  private lastWakeAt = 0
  private wakeRetry: (() => void) | undefined
  private readonly counters = { messages: 0, media: 0, voices: 0, dropped: 0, private: 0 }
  /** Replaced by tests. */
  now: () => number = Date.now

  /**
   * @param ctx - Host services: Sessions for the digest, and credentials for the token.
   * @param config - Connection, group list, media, voice, digest, and send settings.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'forkQq')
    assertConfig(config)
    this.dataDir = config.dataDir ?? join(resolveDshHome(undefined, process.env), 'fork-qq')
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    this.store = new QqStore(join(this.dataDir, 'qq.db'))
    this.loadNotice()
    const d = config.digest
    const digestConfig: DigestConfig = {
      enabled: d.enabled,
      everyHours: d.everyHours,
      minMessages: d.minMessages,
      maxPromptChars: d.maxPromptChars,
      maxCallsPerRound: d.maxCallsPerRound,
      model: d.provider !== undefined && d.model !== undefined ? { provider: d.provider, model: d.model } : undefined,
      agentPreset: d.agentPreset,
      permissionPreset: d.permissionPreset,
      workspacePath: d.workspacePath,
      timeZone: d.timeZone,
      timeoutMs: d.timeoutMs,
      aliasMembers: d.aliasMembers,
      profiles: d.profiles,
      keepPerGroup: d.keepPerGroup,
      maxDigestChars: d.maxDigestChars,
    }
    this.digest = new DigestRunner(ctx, this.store, digestConfig, this.dataDir, id => this.store.groupName(id) ?? id, () => this.now())
    ctx.logger.info(`fork-qq: recording ${config.groups.get().length} group(s)${config.groups.get().length === 0 ? ' (the list is empty: every message is dropped; add group numbers to groups)' : ''}; sending ${config.send.enabled ? `on for ${config.send.groups.length} group(s)` : 'off'}; voice transcription ${config.asr.enabled ? 'on' : 'off'}; digests ${d.enabled ? `every ${d.everyHours} h` : 'off'}; data in ${this.dataDir}`)

    this.door = config.login.enabled ? new LoginDoor({ url: config.login.url, timeoutMs: config.login.timeoutMs }) : undefined
    let listed = this.recordedIds
    ctx.on('loader/volatile-update', () => {
      const before = listed
      listed = this.recordedIds
      if (before !== listed) this.onGroupsChanged(before)
    })

    ctx.effect(() => {
      this.loop = this.run()
      const schedule = this.schedule()
      return async () => {
        this.stopping = true
        this.abort.abort(new Error('fork-qq is stopping'))
        await Promise.allSettled([this.loop, schedule])
        await Promise.allSettled([...this.inflight])
        this.store.close()
      }
    }, 'forkQq.lifecycle()')
  }

  // ---- the group list ----

  /** The groups on the list now; the list is volatile, so this follows the Settings page. */
  private get recordedIds(): ReadonlySet<string> {
    const source = this.config.groups.get()
    if (this.recordedCache?.source !== source) this.recordedCache = { source, ids: new Set(source) }
    return this.recordedCache.ids
  }

  /** The list changed while running: say what was added and removed, and fetch what an added group missed. */
  private onGroupsChanged(before: ReadonlySet<string>): void {
    const now = this.recordedIds
    const added = [...now].filter(id => !before.has(id))
    const removed = [...before].filter(id => !now.has(id))
    for (const id of added) {
      this.seenUnlisted.delete(id)
      this.ctx.logger.info(`fork-qq: now recording group ${id}${this.store.groupName(id) === undefined ? '' : ` (${this.store.groupName(id)})`}`)
    }
    for (const id of removed) this.ctx.logger.info(`fork-qq: no longer recording group ${id}; what is stored ages out with retention`)
    const client = this.client
    if (client === undefined || !this.config.backfill.enabled) return
    for (const id of added) {
      this.track(this.backfill(id).catch((error: unknown) => {
        this.ctx.logger.warn(`fork-qq: backfill of group ${id} failed: ${errorText(error)}`)
      }))
    }
  }

  /**
   * Every group the account is in, as the Settings page's group list offers them: the recorded ones first, then the
   * others by how many messages they showed since the observer started.
   * @returns one entry per group, with the count of dropped messages (a number, nothing of them is kept).
   */
  groupChoices(): Array<{ groupId: string; name: string; memberCount: number | null; recorded: boolean; seen: number }> {
    const seen = new Map(this.unlistedActivity().map(group => [group.groupId, group.messages]))
    const known = new Map(this.store.groups().map(group => [group.groupId, group]))
    for (const id of this.recordedIds) if (!known.has(id)) known.set(id, { groupId: id, name: id, memberCount: null, updatedAt: 0 })
    return [...known.values()].map(group => ({
      groupId: group.groupId,
      name: group.name,
      memberCount: group.memberCount,
      recorded: this.recordedIds.has(group.groupId),
      seen: seen.get(group.groupId) ?? 0,
    })).sort((a, b) => Number(b.recorded) - Number(a.recorded) || b.seen - a.seen || a.name.localeCompare(b.name))
  }

  // ---- reading, for the tools ----

  /**
   * Every group the account is in, with what is recorded of it.
   * @returns recorded groups first, then the others.
   */
  groupOverview(): GroupOverview[] {
    const stats = new Map<string, GroupStats>(this.store.stats().map(stat => [stat.groupId, stat]))
    const known = new Map(this.store.groups().map(group => [group.groupId, group]))
    for (const id of this.recordedIds) if (!known.has(id)) known.set(id, { groupId: id, name: id, memberCount: null, updatedAt: 0 })
    return [...known.values()].map((group) => {
      const stat = stats.get(group.groupId)
      return {
        groupId: group.groupId, name: group.name, memberCount: group.memberCount, recorded: this.recordedIds.has(group.groupId),
        messages: stat?.messages ?? 0,
        firstAt: stat?.firstAt ?? null,
        lastAt: stat?.lastAt ?? null,
        lastDigestAt: stat?.lastDigestAt ?? null,
      }
    }).sort((a, b) => Number(b.recorded) - Number(a.recorded) || b.messages - a.messages || a.name.localeCompare(b.name))
  }

  /**
   * How many messages each group that is not recorded has shown since the observer started: a count, nothing else.
   * @returns group number, name, and count, busiest first.
   */
  unlistedActivity(): Array<{ groupId: string; name: string; messages: number }> {
    return [...this.unlistedCounts]
      .map(([groupId, messages]) => ({ groupId, name: this.store.groupName(groupId) ?? groupId, messages }))
      .sort((a, b) => b.messages - a.messages)
  }

  /**
   * Display name of a group.
   * @param groupId - group number.
   * @returns the name the account last saw, or the number.
   */
  groupName(groupId: string): string {
    return this.store.groupName(groupId) ?? groupId
  }

  /**
   * Whether a group is on the `groups` list.
   * @param groupId - group number.
   * @returns true for a recorded group.
   */
  isRecorded(groupId: string): boolean {
    return this.recordedIds.has(groupId)
  }

  /**
   * Recent messages of a recorded group, oldest first.
   * @param groupId - group number; an unrecorded group yields nothing.
   * @param options - window in hours, at most `limit` messages, optionally one member's QQ number.
   * @returns the messages.
   */
  recentMessages(groupId: string, options: { hours: number; limit: number; userId?: string }): MessageRow[] {
    if (!this.recordedIds.has(groupId)) return []
    const sinceMs = this.now() - options.hours * 3_600_000
    return this.store.recent(groupId, { sinceMs, limit: options.limit, ...options.userId === undefined ? {} : { userId: options.userId } })
  }

  /**
   * Search the recorded groups' messages, newest first.
   * @param query - words to find.
   * @param options - one group, or all recorded groups, and at most `limit` matches.
   * @returns the matching messages.
   */
  searchMessages(query: string, options: { groupId?: string; limit: number }): MessageRow[] {
    if (options.groupId !== undefined && !this.recordedIds.has(options.groupId)) return []
    return this.store.search(query, options).filter(row => this.recordedIds.has(row.groupId))
  }

  /**
   * Newest digests of the recorded groups.
   * @param options - one group, or all recorded groups, a window in days, and at most `limit` digests.
   * @returns the digests, newest first.
   */
  digests(options: { groupId?: string; days: number; limit: number }): DigestRow[] {
    if (options.groupId !== undefined && !this.recordedIds.has(options.groupId)) return []
    const sinceMs = this.now() - options.days * 86_400_000
    return this.store.digests({ ...options.groupId === undefined ? {} : { groupId: options.groupId }, sinceMs, limit: options.limit })
      .filter(row => this.recordedIds.has(row.groupId))
  }

  // ---- sending (off by default) ----

  /**
   * Send text to a group. Refused unless `send.enabled` is true and the group is in `send.groups`, and held to
   * `send.minIntervalSec` between sends and `send.maxPerDay` a day for that group. Nothing in this package calls it.
   * @param groupId - group number.
   * @param text - what to send.
   * @throws {@link SendRefused} when a rule says no, or the protocol end is not connected.
   */
  async sendGroupMessage(groupId: string, text: string): Promise<void> {
    const rules = this.config.send
    if (!rules.enabled) throw new SendRefused('sending is turned off (send.enabled is false)')
    if (!rules.groups.includes(groupId)) throw new SendRefused(`group ${groupId} is not in send.groups`)
    if (this.client === undefined || !this.client.connected) throw new SendRefused('not connected to the protocol end')
    const now = this.now()
    if (now - (this.lastSend.get(groupId) ?? 0) < rules.minIntervalSec * 1000) throw new SendRefused(`less than ${rules.minIntervalSec} s since the last send to group ${groupId}`)
    const day = new Date(now).toISOString().slice(0, 10)
    const today = this.sentToday.get(groupId)
    const count = today?.day === day ? today.count : 0
    if (count >= rules.maxPerDay) throw new SendRefused(`group ${groupId} already got ${rules.maxPerDay} messages today`)
    await this.client.call('send_group_msg', { group_id: Number(groupId), message: [{ type: 'text', data: { text } }] })
    this.lastSend.set(groupId, now)
    this.sentToday.set(groupId, { day, count: count + 1 })
    this.ctx.logger.info(`fork-qq: sent ${Array.from(text).length} chars to group ${groupId} (${count + 1} today)`)
  }

  // ---- the Settings page's QQ section ----

  /** Change the connection state; the time it began is kept while the state stays the same. */
  private setConnection(state: QqConnection['state']): void {
    if (state === this.connState) return
    this.connState = state
    this.connSince = this.now()
  }

  /** The closing sentence of an owner notice: where to log in again. */
  private settingsHint(): string {
    const url = this.config.settingsUrl
    return `在 DSH 网页端「设置 → QQ」扫码重新登录${url === undefined ? '' : `：${url}`}`
  }

  /**
   * The observer's connection to the protocol end, for the Settings page's QQ section: whether the socket is up,
   * since when, how many attempts have failed in a row, and why the last one did.
   * @returns the connection state; `selfId` is the logged-in account only while connected.
   */
  connectionStatus(): QqConnection {
    const up = this.connState === 'connected'
    return {
      state: this.connState,
      since: this.connSince ?? null,
      attempt: up ? 0 : this.attempt,
      lastError: up ? null : this.lastError ?? null,
      selfId: up && this.selfId !== '' ? this.selfId : null,
    }
  }

  /**
   * How many groups the observer records, for the Settings page's QQ section.
   * @returns the size of the configured `groups` list.
   */
  recordedGroups(): number {
    return this.recordedIds.size
  }

  /**
   * NapCat's login as the login door reports it, for the Settings page's QQ section. When NapCat turns out to be
   * logged in while the observer is still backing off, the observer reconnects at once, so a scan on the page ends
   * in "connected" within seconds. Answers are shared for 1.5 s.
   * @param options - `fresh` skips the shared answer.
   * @returns the reading; `door` says why there is no `state` when the door could not answer.
   */
  async loginStatus(options: { fresh?: boolean } = {}): Promise<QqLoginReading> {
    const login = await this.loginView(options.fresh === true)
    if (login.state === 'online' && (this.connState === 'reconnecting' || this.connState === 'starting') && this.now() - this.lastWakeAt >= WAKE_GAP_MS) {
      this.lastWakeAt = this.now()
      this.ctx.logger.info('fork-qq: NapCat is logged in; reconnecting now')
      this.wakeRetry?.()
    }
    return login
  }

  /**
   * Ask NapCat for a fresh login QR code (it renews the code by itself about every two minutes).
   * @returns the reading after the request, and whether the door passed the request on (it declines a second one within seconds).
   */
  async refreshLogin(): Promise<{ login: QqLoginReading; refreshed: boolean }> {
    const token = this.door === undefined ? undefined : await this.token()
    let refreshed = false
    if (this.door !== undefined && token !== undefined) {
      const answer = await this.door.refresh(token)
      refreshed = answer.refreshed
      this.loginCache = { at: this.now(), login: this.toLogin(answer.result) }
      this.noteLogin(this.loginCache.login)
    }
    this.ctx.logger.info(`fork-qq: asked NapCat for a fresh login QR from the settings page (${refreshed ? 'done' : 'not done'})`)
    return { login: await this.loginStatus(), refreshed }
  }

  private loginView(fresh: boolean): Promise<QqLoginReading> {
    if (this.door === undefined) return Promise.resolve({ door: 'disabled', state: null, uin: null, nickname: null, error: null, qrUrl: null })
    const cached = this.loginCache
    if (!fresh && cached !== undefined && this.now() - cached.at < LOGIN_CACHE_MS) return Promise.resolve(cached.login)
    if (!fresh && this.loginInFlight !== undefined) return this.loginInFlight
    const door = this.door
    const read = (async (): Promise<QqLoginReading> => {
      const token = await this.token()
      const login = this.toLogin(token === undefined ? { kind: 'unauthorized' } : await door.status(token))
      this.loginCache = { at: this.now(), login }
      this.noteLogin(login)
      return login
    })().finally(() => { if (this.loginInFlight === read) this.loginInFlight = undefined })
    this.loginInFlight = read
    return read
  }

  private toLogin(result: DoorResult): QqLoginReading {
    if (result.kind !== 'ok') return { door: result.kind, state: null, uin: null, nickname: null, error: null, qrUrl: null }
    return { door: 'ok', state: result.login, uin: result.uin, nickname: result.nickname, error: result.error, qrUrl: result.qrUrl }
  }

  /** Log a change of the login picture once, by state name only: never the code or the link. */
  private noteLogin(login: QqLoginReading): void {
    const key = login.door === 'ok' ? `login:${login.state}` : `door:${login.door}`
    if (key === this.lastLoginKey) return
    this.lastLoginKey = key
    if (login.door !== 'ok') {
      this.ctx.logger.info(`fork-qq: login door: ${login.door}`)
      return
    }
    const wording: Record<string, string> = {
      online: `logged in${login.uin === null ? '' : ` as ${login.uin}`}`,
      offline: 'offline, needs a new login',
      qr: 'waiting for a scan',
      scanned: 'scanned, completing',
      'logging-in': 'logging in',
      preparing: 'preparing a QR code',
      restarting: 'restarting its login service',
      unknown: 'in a state this version does not know',
    }
    this.ctx.logger.info(`fork-qq: NapCat login: ${wording[login.state ?? 'unknown'] ?? 'unknown'}`)
  }

  // ---- plumbing ----

  private track(work: Promise<void>): void {
    const tracked = work.catch((error: unknown) => {
      this.ctx.logger.warn(`fork-qq: background work failed: ${errorText(error)}`)
    }).finally(() => this.inflight.delete(tracked))
    this.inflight.add(tracked)
  }

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

  /** The protocol end's token; undefined while it is missing. Never logged. */
  private async token(): Promise<string | undefined> {
    const credential = await this.ctx.credentials.resolve(credentialRef(this.config.tokenEnv))
    const value = credential?.value.trim() ?? ''
    const state = value === '' ? 'missing' : 'present'
    if (state !== this.credentialState) {
      this.credentialState = state
      this.ctx.logger.info(state === 'missing'
        ? `fork-qq: ${this.config.tokenEnv} is not set; QQ stays offline and re-checks every 30 s`
        : 'fork-qq: the OneBot access token was found')
    }
    return value === '' ? undefined : value
  }

  /** Stay connected while the plugin is active. */
  private async run(): Promise<void> {
    let failures = 0
    while (!this.stopping) {
      const token = await this.token()
      if (token === undefined) {
        this.setConnection('waiting-token')
        await this.pause(30_000)
        continue
      }
      const client = new OneBotClient({ url: this.config.url, token })
      this.client = client
      let upAt: number | undefined
      try {
        await client.run({
          event: (event) => { this.track(this.handleEvent(event)) },
          open: () => {
            upAt = this.now()
            this.disconnectedSince = undefined
            this.clearNotice()
            this.attempt = 0
            this.lastError = undefined
            this.setConnection('connected')
            this.ctx.logger.info(`fork-qq: connected to the protocol end at ${this.config.url}`)
            this.track(this.onOpen())
          },
          close: (reason) => {
            this.lastError = `the connection closed (${reason})`
            this.ctx.logger.warn(`fork-qq: the protocol end connection closed (${reason})`)
          },
        }, this.abort.signal)
        if (this.stopping) return
      } catch (error: unknown) {
        if (this.stopping) return
        this.lastError = errorText(error)
        this.ctx.logger.warn(`fork-qq: could not reach the protocol end: ${errorText(error)}`)
      } finally {
        this.client = undefined
      }
      this.disconnectedSince ??= this.now()
      this.track(this.checkOutage())
      failures = upAt !== undefined && this.now() - upAt >= STABLE_MS ? 1 : failures + 1
      this.attempt = failures
      this.setConnection('reconnecting')
      const wait = Math.min(FIRST_RETRY_MS * 2 ** (failures - 1), MAX_RETRY_MS)
      this.ctx.logger.info(`fork-qq: reconnecting in ${wait / 1000} s (attempt ${failures})`)
      await this.pause(wait)
    }
  }

  /** Tell the owner once when the protocol end stays unreachable. */
  private async checkOutage(): Promise<void> {
    const since = this.disconnectedSince
    if (since === undefined || this.config.offlineNoticeMs === 0) return
    if (this.now() - since < this.config.offlineNoticeMs) return
    await this.notifyOwner('QQ 协议端连不上', `fork-qq 已有 ${Math.round((this.now() - since) / 60_000)} 分钟连不上协议端，多半是 QQ 被踢下线了。${this.settingsHint()}`)
  }

  /** Whether the owner may be told now: never told of this outage, or told long enough ago to remind. */
  private noticeDue(): boolean {
    if (this.lastNoticeAt === undefined) return true
    return this.config.offlineRepeatMs > 0 && this.now() - this.lastNoticeAt >= this.config.offlineRepeatMs
  }

  private get noticeFile(): string {
    return join(this.dataDir, 'outage-notice.json')
  }

  /** Read what an earlier process told the owner, if the outage it was about is the one still going on. */
  private loadNotice(): void {
    try {
      const saved = JSON.parse(readFileSync(this.noticeFile, 'utf8')) as { lastNoticeAt?: unknown }
      if (typeof saved.lastNoticeAt === 'number' && Number.isFinite(saved.lastNoticeAt)) this.lastNoticeAt = saved.lastNoticeAt
    } catch {
      // No earlier notice, or an unreadable file: the owner may be told.
    }
  }

  private clearNotice(): void {
    if (this.lastNoticeAt === undefined) return
    this.lastNoticeAt = undefined
    rmSync(this.noticeFile, { force: true })
  }

  private async notifyOwner(title: string, body: string): Promise<void> {
    if (!this.noticeDue()) return
    this.lastNoticeAt = this.now()
    try {
      writeFileSync(this.noticeFile, JSON.stringify({ lastNoticeAt: this.lastNoticeAt }), { mode: 0o600 })
    } catch (error: unknown) {
      this.ctx.logger.warn(`fork-qq: could not remember the owner notice: ${errorText(error)}`)
    }
    const notifier = this.ctx.get('forkNotifier') as ForkNotifier | undefined
    if (notifier === undefined) return
    try {
      await notifier.send({ title, body, origin: 'the QQ observer (a notice, not the owner)' })
      this.ctx.logger.info(`fork-qq: told the owner (${title}); no further notice until the connection has come back`)
    } catch (error: unknown) {
      this.ctx.logger.warn(`fork-qq: could not tell the owner: ${errorText(error)}`)
    }
  }

  /** After a connection opens: who we are, which groups, and what was missed. */
  private async onOpen(): Promise<void> {
    const client = this.client
    if (client === undefined) return
    try {
      const me = await client.call<{ user_id?: number | string; nickname?: string }>('get_login_info')
      this.selfId = String(me.user_id ?? '')
      this.ctx.logger.info(`fork-qq: logged in as ${this.selfId}`)
    } catch (error: unknown) {
      this.ctx.logger.warn(`fork-qq: get_login_info failed: ${errorText(error)}`)
    }
    await this.refreshGroups()
    if (this.config.backfill.enabled) {
      for (const groupId of this.recordedIds) {
        if (this.stopping || this.client !== client) break
        await this.backfill(groupId).catch((error: unknown) => {
          this.ctx.logger.warn(`fork-qq: backfill of group ${groupId} failed: ${errorText(error)}`)
        })
      }
    }
  }

  private async refreshGroups(): Promise<void> {
    const client = this.client
    if (client === undefined) return
    try {
      const list = await client.call<Array<{ group_id: number | string; group_name?: string; member_count?: number }>>('get_group_list')
      const now = this.now()
      for (const group of list) {
        const groupId = String(group.group_id)
        this.store.upsertGroup({ groupId, name: group.group_name ?? groupId, memberCount: group.member_count }, now)
      }
      const missing = [...this.recordedIds].filter(id => !list.some(group => String(group.group_id) === id))
      this.ctx.logger.info(`fork-qq: the account is in ${list.length} group(s); ${this.recordedIds.size - missing.length} of the ${this.recordedIds.size} listed one(s) found${missing.length === 0 ? '' : `; not a member of ${missing.join(', ')}`}`)
    } catch (error: unknown) {
      this.ctx.logger.warn(`fork-qq: get_group_list failed: ${errorText(error)}`)
    }
  }

  /** Fetch a group's history backwards until it meets a message already stored, or the cap. */
  private async backfill(groupId: string): Promise<void> {
    const client = this.client
    if (client === undefined) return
    let seq: string | undefined
    let fetched = 0
    let added = 0
    while (fetched < this.config.backfill.maxMessages && this.client === client) {
      const data = await client.call<{ messages?: OneBotEvent[] }>('get_group_msg_history', { group_id: Number(groupId), count: 50, ...seq === undefined ? {} : { message_seq: Number(seq) } })
      const messages = data.messages ?? []
      if (messages.length === 0) break
      let known = false
      for (const message of [...messages].reverse()) {
        fetched += 1
        if (this.store.hasMessage(groupId, String(message.message_id))) known = true
        else if (await this.record({ ...message, post_type: 'message', message_type: 'group', group_id: groupId }, true)) added += 1
      }
      const oldest = messages[0]?.message_seq === undefined ? undefined : String(messages[0].message_seq)
      if (known || oldest === undefined || oldest === seq) break
      seq = oldest
    }
    if (added > 0) this.ctx.logger.info(`fork-qq: backfilled ${added} message(s) of group ${groupId}`)
  }

  // ---- events ----

  private async handleEvent(event: OneBotEvent): Promise<void> {
    if (event.post_type === 'message') {
      if (event.message_type === 'group') {
        await this.record(event, false)
      } else {
        // Private chats are not the observer's business: not stored, not counted by content.
        this.counters.private += 1
      }
      return
    }
    if (event.post_type !== 'notice') return
    if (event.notice_type === 'group_recall' && this.config.honorRecall) {
      await this.onRecall(String(event.group_id ?? ''), String(event.message_id ?? ''))
    } else if (event.notice_type === 'bot_offline') {
      this.ctx.logger.warn('fork-qq: the protocol end reports the account went offline')
      await this.notifyOwner('QQ 号掉线了', `NapCat 报告这个 QQ 号下线（被踢或登录失效）。${this.settingsHint()}`)
    }
  }

  private async onRecall(groupId: string, messageId: string): Promise<void> {
    if (!this.recordedIds.has(groupId)) return
    const paths = this.store.recall(groupId, messageId)
    if (paths === undefined) return
    for (const path of paths) await removeMedia(path)
    this.ctx.logger.info(`fork-qq: a message of group ${groupId} was recalled; its text and ${paths.length} file(s) were dropped`)
  }

  /** Record a group message when its group is listed. @returns whether a new row was stored. */
  private async record(event: OneBotEvent, backfilled: boolean): Promise<boolean> {
    const groupId = String(event.group_id ?? '')
    const userId = String(event.user_id ?? event.sender?.user_id ?? '')
    if (groupId === '' || userId === '' || event.message_id === undefined) return false
    if (userId === this.selfId && this.selfId !== '') return false
    if (!this.recordedIds.has(groupId)) {
      this.counters.dropped += 1
      this.unlistedCounts.set(groupId, (this.unlistedCounts.get(groupId) ?? 0) + 1)
      if (!this.seenUnlisted.has(groupId)) {
        this.seenUnlisted.add(groupId)
        this.ctx.logger.info(`fork-qq: not recording group ${groupId}${this.store.groupName(groupId) === undefined ? '' : ` (${this.store.groupName(groupId)})`}: it is not in groups`)
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
    this.ctx.logger.debug(`fork-qq: recorded message ${event.message_id} of group ${groupId} from ${displayName(sender, userId)} (${Array.from(parsed.text).length} chars, ${parsed.media.length} media)`)
    for (const media of this.store.mediaOf(row)) {
      const item: MediaJob = {
        rowId: row, groupId, at, mediaId: media.id, kind: media.kind,
        url: media.url ?? undefined, file: media.file ?? undefined, name: media.name ?? undefined,
      }
      this.enqueue(() => this.fetchMedia(item))
    }
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
    if (this.store.mediaBytes() < this.config.media.maxTotalBytes) return false
    if (this.now() - this.budgetWarnedAt > 3_600_000) {
      this.budgetWarnedAt = this.now()
      this.ctx.logger.warn(`fork-qq: downloads reached media.maxTotalBytes (${this.config.media.maxTotalBytes}); new media is not downloaded`)
    }
    return true
  }

  private async fetchMedia(item: MediaJob): Promise<void> {
    const { rowId, groupId, at, mediaId, kind, url, name } = item
    const media = this.config.media
    try {
      if (kind === 'image') {
        if (!media.images || url === undefined || this.overBudget()) return
        if (!isAllowedMediaUrl(url, media.hostSuffixes)) {
          this.store.setMediaError(mediaId, 'the address is not on media.hostSuffixes')
          return
        }
        const bytes = await fetchCapped(url, media.maxImageBytes, media.timeoutMs)
        const saved = await saveMedia(this.dataDir, groupId, at, bytes, detectExtension(bytes, 'image', name))
        this.store.setMediaFile(mediaId, { localPath: saved.path, sha256: saved.sha256, bytes: saved.bytes })
        this.counters.media += 1
      } else if (kind === 'voice') {
        await this.fetchVoice(item)
      }
    } catch (error: unknown) {
      this.store.setMediaError(mediaId, errorText(error))
      this.ctx.logger.debug(`fork-qq: could not fetch ${kind} of message row ${rowId}: ${errorText(error)}`)
    }
  }

  /** Fetch a voice message as MP3 through the protocol end (which decodes QQ's SILK), keep it, and transcribe it if asked. */
  private async fetchVoice(item: MediaJob): Promise<void> {
    const { rowId, groupId, at, mediaId, url, file, name } = item
    if (!this.config.voice.download || this.overBudget()) return
    let bytes: Buffer | undefined
    const client = this.client
    if (client !== undefined && file !== undefined) {
      try {
        const data = await client.call<{ base64?: string; file?: string }>('get_record', { file, out_format: 'mp3' })
        if (typeof data.base64 === 'string' && data.base64 !== '') bytes = Buffer.from(data.base64, 'base64')
      } catch (error: unknown) {
        this.ctx.logger.debug(`fork-qq: get_record failed for message row ${rowId}: ${errorText(error)}`)
      }
    }
    if (bytes === undefined && url !== undefined && isAllowedMediaUrl(url, this.config.media.hostSuffixes)) {
      bytes = await fetchCapped(url, this.config.voice.maxBytes, this.config.media.timeoutMs)
    }
    if (bytes === undefined) {
      this.store.setMediaError(mediaId, 'the protocol end gave no audio')
      return
    }
    if (bytes.length > this.config.voice.maxBytes) {
      this.store.setMediaError(mediaId, `audio exceeds ${this.config.voice.maxBytes} bytes`)
      return
    }
    const saved = await saveMedia(this.dataDir, groupId, at, bytes, detectExtension(bytes, 'voice', name))
    this.store.setMediaFile(mediaId, { localPath: saved.path, sha256: saved.sha256, bytes: saved.bytes })
    this.counters.voices += 1
    if (!this.config.asr.enabled) return
    const voice = this.ctx.get('forkVoice') as { canTranscribe(path: string): boolean; transcribe(path: string): Promise<{ text: string }> } | undefined
    if (voice === undefined || !voice.canTranscribe(saved.path)) {
      this.ctx.logger.debug(`fork-qq: voice of message row ${rowId} not transcribed: fork-voice is missing, off, or does not read this format`)
      return
    }
    const transcript = await voice.transcribe(saved.path)
    const text = transcript.text.trim()
    if (text === '') return
    this.store.setTranscript(mediaId, text)
    this.store.appendText(rowId, ` 〔语音转写：${text}〕`)
  }

  // ---- schedules ----

  /** Digest rounds and media retention, until the plugin stops. */
  private async schedule(): Promise<void> {
    let lastRetention = 0
    let lastGroups = this.now()
    await this.pause(30_000)
    while (!this.stopping) {
      try {
        if (this.config.digest.enabled) {
          const stored = await this.digest.runRound([...this.recordedIds], this.abort.signal)
          if (stored > 0) this.ctx.logger.info(`fork-qq: digest round stored ${stored} digest(s)`)
        }
        if (this.now() - lastRetention >= RETENTION_CHECK_MS) {
          lastRetention = this.now()
          await this.prune()
        }
        if (this.client?.connected === true && this.now() - lastGroups >= GROUP_REFRESH_MS) {
          lastGroups = this.now()
          await this.refreshGroups()
        }
        await this.checkOutage()
        this.logStats()
      } catch (error: unknown) {
        this.ctx.logger.warn(`fork-qq: scheduled work failed: ${errorText(error)}`)
      }
      await this.pause(DIGEST_CHECK_MS)
    }
  }

  private logStats(): void {
    const c = this.counters
    if (this.unlistedCounts.size > 0 && c.dropped > 0) {
      const top = this.unlistedActivity().slice(0, 30).map(group => `${group.groupId} ${group.name} ${group.messages}`).join(' | ')
      this.ctx.logger.info(`fork-qq: messages seen per unlisted group since ${new Date(this.startedAt).toISOString()} (counts only, nothing kept): ${top}`)
    }
    if (c.messages + c.dropped + c.private + c.media + c.voices === 0) return
    this.ctx.logger.info(`fork-qq: since the last report: ${c.messages} message(s) recorded, ${c.media} image(s) and ${c.voices} voice(s) saved, ${c.dropped} from unlisted groups dropped, ${c.private} private message(s) ignored; downloads hold ${this.store.mediaBytes()} bytes`)
    this.counters.messages = this.counters.media = this.counters.voices = this.counters.dropped = this.counters.private = 0
  }

  /** Apply the retention windows: raw messages older than `retention.textDays`, downloads older than `media.retainDays`. */
  private async prune(): Promise<void> {
    const { retainDays } = this.config.media
    if (retainDays > 0) {
      const expired = this.store.expiredMedia(this.now() - retainDays * 86_400_000)
      for (const item of expired) {
        await removeMedia(item.localPath)
        this.store.clearMediaFile(item.id)
      }
      if (expired.length > 0) this.ctx.logger.info(`fork-qq: removed ${expired.length} download(s) older than ${retainDays} day(s)`)
    }
    const { textDays } = this.config.retention
    if (textDays > 0) {
      const gone = this.store.pruneMessages(this.now() - textDays * 86_400_000)
      for (const path of gone.files) await removeMedia(path)
      if (gone.messages > 0) this.ctx.logger.info(`fork-qq: deleted ${gone.messages} message(s) older than ${textDays} day(s) and ${gone.files.length} file(s)`)
    }
  }

  /**
   * Delete stored digests: the observer's learned knowledge. Raw messages age out by themselves.
   * @param options - one group and/or those made before `beforeMs`; at least one is required.
   * @returns how many digests were deleted.
   */
  forgetDigests(options: { groupId?: string; beforeMs?: number }): number {
    const count = this.store.deleteDigests(options)
    this.ctx.logger.info(`fork-qq: deleted ${count} digest(s)${options.groupId === undefined ? '' : ` of group ${options.groupId}`}${options.beforeMs === undefined ? '' : ' made before a cutoff'}`)
    return count
  }
}

export default QqObserver
