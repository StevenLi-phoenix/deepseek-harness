/**
 * QQ group observer, DSH's half. A personal QQ account, reached through a OneBot v11 protocol end (NapCat) on this
 * machine, lurks in the groups the owner lists. The connection and the recording belong to the `qq-recorder` service (an
 * AMS service of its own process, see `./recorder.ts`), so a DSH restart, deploy, or settings save never drops the
 * connection. This plugin is the recorder's client: it pushes the settings, reads the recorded messages through the
 * recorder's API, digests them on a schedule with one-turn Sessions, keeps the digests and group notes in its own storage
 * domain, lets the agent read all of it, and tells the owner when the protocol end stays unreachable. It never speaks:
 * sending is refused, and nothing is a chat entrance for the agent.
 */

import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { ForkNotifier } from '@deepseek-ai/dsh-fork-event-bus'
// Type-only: the `loader/volatile-update` event the group list follows.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-storage-domain'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_MEDIA_HOST_SUFFIXES, isPrivateAddress, isPrivateUrl } from './address.ts'
import { RecorderClient, RecorderUnavailable } from './client.ts'
import { DigestStore, qqDomain, type DigestRecord } from './digest-storage.ts'
import { DigestRunner, senderKey, type DigestConfig, type MessageReader, type ToolOutcome } from './digest.ts'
import { FEATURE_MINOR, type Group, type Login, type Message, type RecorderConfig } from './protocol.ts'
import type { QqConnection, QqLoginReading, RefreshRefusal } from './status.ts'

export * from './address.ts'
export * from './client.ts'
export * from './digest-storage.ts'
export * from './digest.ts'
export * from './pii.ts'
export * from './protocol.ts'
export * from './status.ts'

/** A stored message, as the recorder reports it. */
export type MessageRow = Message
/** A stored digest. */
export type DigestRow = DigestRecord

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The QQ group observer. */
    forkQq: QqObserver
  }
}

/** Channel configuration. */
export interface Config {
  /** WebSocket address of the protocol end (NapCat's OneBot server); it must be on this machine or the tailnet. The recorder connects. */
  url: string
  /** Name of the recorder's secret holding the protocol end's access token. */
  tokenEnv: string
  /**
   * Group numbers to record. Empty records nothing; messages of every other group are dropped on arrival. Volatile: the
   * Settings page's QQ section adds and removes groups at run time and the recorder follows without a restart.
   */
  groups: Volatile<string[]>
  /** Ignored: the recorder owns its data directory (`QQ_RECORDER_DATA_DIR` in its declaration). */
  dataDir?: string
  /** The qq-recorder service this plugin talks to. */
  recorder: {
    /** Unix socket of the recorder; defaults to `<DSH_HOME>/run/qq-recorder.sock`. */
    socket?: string
    /** Credential holding the bearer token shared with the recorder. */
    tokenEnv: string
    /** Deadline of one request, in milliseconds. */
    timeoutMs: number
  }
  /** Image downloads: what is fetched, from where, and how much is kept. Applied by the recorder. */
  media: {
    /** Download the images of recorded messages. */
    images: Volatile<boolean>
    /** Largest image downloaded, in bytes. */
    maxImageBytes: Volatile<number>
    /** Stop downloading once the downloads together reach this many bytes. */
    maxTotalBytes: Volatile<number>
    /** Delete downloads of messages older than this many days; 0 keeps them. 30 by default. */
    retainDays: Volatile<number>
    /** Hosts media may be fetched from, as suffixes. */
    hostSuffixes: Volatile<string[]>
    /** Deadline of one download, in milliseconds. */
    timeoutMs: Volatile<number>
  }
  /** Keep voice messages. */
  voice: {
    /** Fetch the audio of voice messages. */
    download: Volatile<boolean>
    /** Largest audio kept, in bytes. */
    maxBytes: Volatile<number>
  }
  /** Voice transcription. The recorder does not transcribe yet; `enabled` is refused at load. */
  asr: {
    enabled: Volatile<boolean>
  }
  /** How long raw messages are kept. Digests are not affected and can be deleted by group or date. */
  retention: {
    /** Delete messages (text, raw segments, media rows) older than this many days; 0 keeps them. 30 by default. */
    textDays: Volatile<number>
  }
  /** Drop the text and files of a message its sender recalled. */
  honorRecall: Volatile<boolean>
  /** Fetch what was missed while disconnected. Applied by the recorder. */
  backfill: {
    /** Fetch history after each connection. */
    enabled: Volatile<boolean>
    /** Messages fetched per group at most. 20 by default: one small page. */
    maxMessages: Volatile<number>
    /** Groups caught up per connection at most; the next connection continues with the following ones. 5 by default. */
    maxGroups: Volatile<number>
    /** Pause between two groups' backfills, in milliseconds, plus up to half as much again of jitter. 5000 by default. */
    gapMs: Volatile<number>
    /** A connection made less than this long after the previous one dropped fetches nothing; 0 never skips. 30 minutes by default. */
    skipWithinMs: Volatile<number>
    /** A backfill runs at most this often, also across recorder restarts; 0 never holds one back. 30 minutes by default. */
    minIntervalMs: Volatile<number>
  }
  /** Sending to a group. Refused: the recorder has no send endpoint, so `enabled` fails the load. */
  send: {
    enabled: boolean
    groups: string[]
    minIntervalSec: number
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
    /** Tool calls (`qq_digest_write`, `qq_group_note`) one digest Session may make, refused ones included. 12 by default. */
    maxToolCalls: number
    /** Archive each digest Session when its turn ends, so it does not fill the sidebar (its log stays). True by default. */
    archiveSessions: boolean
    /**
     * Keep one Session per recorded group across rounds, condensed by the preset's compaction, and replace it every
     * `retention.textDays` days; false runs a new one-shot Session per round. True by default.
     */
    resident: boolean
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
  offlineNoticeMs: Volatile<number>
  /**
   * A connection made less than this long after the previous one was last alive skips the group list and the backfill.
   * The recorder keeps the time on disk, so it holds across a recorder restart; 0 never skips. 10 minutes by default.
   */
  reconnectQuietMs: Volatile<number>
  /**
   * While an outage lasts, remind the owner again after this long, in milliseconds; 0 never repeats. What was told is kept
   * in this plugin's storage, so a reload or deploy in the middle of an outage does not tell again. 24 hours by default.
   */
  offlineRepeatMs: Volatile<number>
  /** Where the Settings page lives, quoted in the owner notice (the event service's address); unset names the page without a link. */
  settingsUrl: Volatile<string | undefined>
  /** The login door: the window onto NapCat's login that the Settings page's QQ section uses. The recorder asks it. */
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
  recorder: z.object({
    socket: z.string(),
    tokenEnv: z.string().role('credential-ref').default('FORK_QQ_RECORDER_TOKEN'),
    timeoutMs: z.natural().min(500).default(10_000),
  }),
  media: z.object({
    images: z.boolean().default(true).volatile(),
    maxImageBytes: z.natural().min(1024).default(15 * 1024 * 1024).volatile(),
    maxTotalBytes: z.natural().min(1024).default(5 * 1024 ** 3).volatile(),
    retainDays: z.natural().default(30).volatile(),
    hostSuffixes: z.array(z.string()).default([...DEFAULT_MEDIA_HOST_SUFFIXES]).volatile(),
    timeoutMs: z.natural().min(1000).default(30_000).volatile(),
  }),
  voice: z.object({
    download: z.boolean().default(true).volatile(),
    maxBytes: z.natural().min(1024).default(10 * 1024 * 1024).volatile(),
  }),
  asr: z.object({ enabled: z.boolean().default(false).volatile() }),
  retention: z.object({ textDays: z.natural().default(30).volatile() }),
  honorRecall: z.boolean().default(true).volatile(),
  backfill: z.object({
    enabled: z.boolean().default(true).volatile(),
    maxMessages: z.natural().min(1).default(20).volatile(),
    maxGroups: z.natural().min(1).default(5).volatile(),
    gapMs: z.natural().default(5000).volatile(),
    skipWithinMs: z.natural().default(30 * 60_000).volatile(),
    minIntervalMs: z.natural().default(30 * 60_000).volatile(),
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
    maxToolCalls: z.natural().min(1).default(12),
    archiveSessions: z.boolean().default(true),
    resident: z.boolean().default(true),
    provider: z.string(),
    model: z.string(),
    agentPreset: z.string().default('qq-digest'),
    permissionPreset: z.string().default('read-only'),
    workspacePath: z.string().default('/Users/dsh-runtime/work/qq'),
    timeZone: z.string().default('Asia/Shanghai'),
    timeoutMs: z.natural().min(10_000).default(15 * 60_000),
  }),
  offlineNoticeMs: z.natural().default(10 * 60_000).volatile(),
  reconnectQuietMs: z.natural().default(10 * 60_000).volatile(),
  offlineRepeatMs: z.natural().default(24 * 3_600_000).volatile(),
  settingsUrl: z.string().volatile(),
  login: z.object({
    enabled: z.boolean().default(true),
    url: z.string().default('http://127.0.0.1:3002'),
    timeoutMs: z.natural().min(500).default(5000),
  }),
})

/** A QQ group number: 3 to 20 digits. */
const GROUP_ID = /^[0-9]{3,20}$/

/** Digest schedule check period. */
const SCHEDULE_MS = 10 * 60_000
/** How often a running outage is checked against `offlineNoticeMs`. */
const OUTAGE_CHECK_MS = 60_000
/** The recorder's secret names are `FORK_QQ_` plus capitals. */
const RECORDER_SECRET = /^FORK_QQ_[A-Z0-9_]{1,40}$/

/** Fail at load on configuration that cannot work. */
function assertConfig(config: Config): void {
  if (!isPrivateUrl(config.url)) throw new Error('fork-qq: url must be a ws:// or wss:// address on this machine (127.0.0.1, localhost) or the tailnet (100.64.0.0/10, *.ts.net)')
  if (!RECORDER_SECRET.test(config.tokenEnv)) throw new Error('fork-qq: tokenEnv must name one of the recorder\'s secrets (FORK_QQ_ followed by capitals, digits, and underscores)')
  if (config.recorder.socket !== undefined && !isAbsolute(config.recorder.socket)) throw new Error('fork-qq: recorder.socket must be an absolute path')
  if (!isPrivateAddress(config.login.url, ['http:', 'https:'])) throw new Error('fork-qq: login.url must be an http(s) address on this machine (127.0.0.1, localhost) or the tailnet (100.64.0.0/10, *.ts.net)')
  if (config.settingsUrl.get() !== undefined && !/^https?:\/\//.test(config.settingsUrl.get() ?? '')) throw new Error('fork-qq: settingsUrl must be an http(s) address')
  if (!isAbsolute(config.digest.workspacePath)) throw new Error('fork-qq: digest.workspacePath must be an absolute path')
  if (config.asr.enabled.get()) throw new Error('fork-qq: asr.enabled is not supported while the qq-recorder owns the voice files; set it to false')
  if (config.send.enabled) throw new Error('fork-qq: send.enabled is not supported: the qq-recorder has no send endpoint, and QQ stays read-only')
  for (const id of config.groups.get()) {
    if (!GROUP_ID.test(id)) throw new Error(`fork-qq: ${JSON.stringify(id)} is not a group number (digits only)`)
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
 * The observer. Provides `ctx.forkQq`, whose read methods the agent tools use. The recorded data lives in the qq-recorder
 * service: every read of it is a request that fails with {@link RecorderUnavailable} while the recorder is down.
 */
export class QqObserver extends Service {
  static inject = ['sessionController', 'permissionPresets', 'sessionTitle', 'credentials', 'storageDomain']
  static Config = Config

  readonly socketPath: string
  private readonly client: RecorderClient
  private readonly abort = new AbortController()
  private readonly inflight = new Set<Promise<void>>()
  private readonly warnedInvalid = new Set<string>()
  private recordedCache: { source: readonly string[]; ids: ReadonlySet<string> } | undefined
  private store: DigestStore | undefined
  private digest: DigestRunner | undefined
  private stopping = false
  private readonly names = new Map<string, string>()
  private lastNoticeAt: number | undefined
  private importing: Promise<void> | undefined
  private importWarned = false
  /** Replaced by tests. */
  now: () => number = Date.now
  private wake: (() => void) | undefined

  /**
   * @param ctx - Host services: Sessions for the digest, credentials for the recorder token, and storage.
   * @param config - Recorder address, group list, media, digest, and notice settings.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'forkQq')
    assertConfig(config)
    this.socketPath = config.recorder.socket ?? join(resolveDshHome(undefined, process.env), 'run', 'qq-recorder.sock')
    const log = ctx.logger
    this.client = new RecorderClient({
      socketPath: this.socketPath,
      timeoutMs: config.recorder.timeoutMs,
      token: async () => {
        const credential = await ctx.credentials.resolve(credentialRef(config.recorder.tokenEnv))
        const value = credential?.value.trim() ?? ''
        return value === '' ? undefined : value
      },
      logger: { debug: m => { log.debug(m) }, info: m => { log.info(m) }, warn: m => { log.warn(m) } },
      now: () => this.now(),
    })
    if (config.dataDir !== undefined) ctx.logger.warn('fork-qq: dataDir is ignored: the qq-recorder owns the QQ database and downloads; remove it from the configuration')
    const d = config.digest
    ctx.logger.info(`fork-qq: recording ${this.recordedIds.size} group(s) through the recorder at ${this.socketPath}${this.recordedIds.size === 0 ? ' (the list is empty: every message is dropped; add group numbers to groups)' : ''}; sending off; digests ${d.enabled ? `every ${d.everyHours} h` : 'off'}`)

    const opening = ctx.storageDomain.open(qqDomain)
    ctx.effect(async () => {
      const domain = await opening
      const store = new DigestStore(domain)
      this.store = store
      const digestConfig: DigestConfig = {
        enabled: d.enabled, everyHours: d.everyHours, minMessages: d.minMessages, maxPromptChars: d.maxPromptChars,
        maxCallsPerRound: d.maxCallsPerRound,
        model: d.provider !== undefined && d.model !== undefined ? { provider: d.provider, model: d.model } : undefined,
        agentPreset: d.agentPreset, permissionPreset: d.permissionPreset, workspacePath: d.workspacePath, timeZone: d.timeZone,
        timeoutMs: d.timeoutMs, aliasMembers: d.aliasMembers, profiles: d.profiles, keepPerGroup: d.keepPerGroup,
        maxDigestChars: d.maxDigestChars, maxToolCalls: d.maxToolCalls, archiveSessions: d.archiveSessions, resident: d.resident,
      }
      this.digest = new DigestRunner(
        ctx, store, this.reader(), digestConfig, join(resolveDshHome(undefined, process.env), 'fork-qq-digest', 'raw'), () => this.now(),
        // A resident digest Session is replaced when it is as old as the raw messages are kept.
        () => this.live.retention.textDays * 86_400_000,
      )
      const saved = Number(store.getMeta('outage-notice-at') ?? '')
      if (Number.isFinite(saved) && store.getMeta('outage-notice-at') !== undefined) this.lastNoticeAt = saved

      const stopListening = this.client.listen({
        change: () => { this.onLinkChange() },
        botOffline: () => { this.track(this.checkOutage(true)) },
      })
      const alive = setInterval(() => { this.track(this.checkOutage(false)) }, OUTAGE_CHECK_MS)
      alive.unref()
      void this.client.setConfig(this.buildConfig())
      this.client.start()
      const schedule = this.schedule()
      return async () => {
        this.stopping = true
        stopListening()
        clearInterval(alive)
        this.abort.abort(new Error('fork-qq is stopping'))
        this.wake?.()
        await schedule
        await Promise.allSettled([...this.inflight])
        await this.client.stop()
        await domain.close()
      }
    }, 'forkQq.lifecycle()')

    // The groups, the media settings, and the rest follow the Settings page without a restart: push them to the recorder.
    ctx.on('loader/volatile-update', () => {
      void this.client.setConfig(this.buildConfig())
    })

    // The event bus's auto-archive sweep leaves the groups' resident digest Sessions alone; the observer works without the bus.
    ctx.plugin({
      name: 'fork-qq-archive-protection',
      inject: ['forkEventBus'],
      apply: (child: Context) => {
        child.effect(
          () => child.forkEventBus.protectSessions('qq', session => this.store?.isResidentSession(session.id) === true),
          'forkQq.archiveProtection()',
        )
      },
    })
  }

  /**
   * The settings the Settings page and the profile patch may change without a restart, read afresh at each use.
   * Everything not read here is fixed when the plugin starts.
   */
  private get live() {
    return {
      retention: { textDays: this.config.retention.textDays.get() },
      offlineNoticeMs: this.config.offlineNoticeMs.get(),
      offlineRepeatMs: this.config.offlineRepeatMs.get(),
      settingsUrl: this.config.settingsUrl.get(),
    }
  }

  /** The recorder's settings as they stand now. */
  private buildConfig(): RecorderConfig {
    const { media, voice, backfill, login } = this.config
    const body = {
      url: this.config.url,
      tokenEnv: this.config.tokenEnv,
      groups: [...this.recordedIds],
      media: {
        images: media.images.get(), maxImageBytes: media.maxImageBytes.get(), maxTotalBytes: media.maxTotalBytes.get(),
        retainDays: media.retainDays.get(), hostSuffixes: [...media.hostSuffixes.get()], timeoutMs: media.timeoutMs.get(),
      },
      voice: { download: voice.download.get(), maxBytes: voice.maxBytes.get() },
      retention: { textDays: this.config.retention.textDays.get() },
      honorRecall: this.config.honorRecall.get(),
      backfill: {
        enabled: backfill.enabled.get(), maxMessages: backfill.maxMessages.get(), maxGroups: backfill.maxGroups.get(),
        gapMs: backfill.gapMs.get(), skipWithinMs: backfill.skipWithinMs.get(), minIntervalMs: backfill.minIntervalMs.get(),
      },
      reconnectQuietMs: this.config.reconnectQuietMs.get(),
      login: { enabled: login.enabled, url: login.url, timeoutMs: login.timeoutMs },
    }
    const revision = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 12)
    return { revision, ...body }
  }

  /** The recorder's API as the digest reads it. */
  private reader(): MessageReader {
    return {
      page: (groupId, after, limit) => this.client.page(groupId, after, limit),
      lookup: (groupId, ids) => this.client.lookup(groupId, ids),
      members: async (groupId) => (this.client.supports('members') ? this.client.members(groupId) : undefined),
      groupName: groupId => this.groupName(groupId),
    }
  }

  // ---- the group list ----

  /** The groups on the list now; the list is volatile, so this follows the Settings page. */
  private get recordedIds(): ReadonlySet<string> {
    const source = this.config.groups.get()
    if (this.recordedCache?.source !== source) {
      // The schema only says string[]; startup refuses a bad entry (assertConfig), but a run-time save does not pass there.
      const bad = source.filter(id => !GROUP_ID.test(id) && !this.warnedInvalid.has(id))
      for (const id of bad) this.warnedInvalid.add(id)
      if (bad.length > 0) this.ctx.logger.warn(`fork-qq: ignoring ${bad.map(id => JSON.stringify(id.slice(0, 24))).join(', ')} in groups: not a group number (3 to 20 digits)`)
      this.recordedCache = { source, ids: new Set(source.filter(id => GROUP_ID.test(id))) }
    }
    return this.recordedCache.ids
  }

  /** Remember the names the recorder reported, for the synchronous {@link groupName}. */
  private learn(groups: readonly Group[]): void {
    for (const group of groups) this.names.set(group.groupId, group.name)
  }

  /**
   * Every group the account is in, as the Settings page's group list offers them: the recorded ones first, then the
   * others by how many messages they showed since the recorder started.
   * @returns one entry per group, with the count of dropped messages (a number, nothing of them is kept).
   * @throws {@link RecorderUnavailable} while the recorder is down.
   */
  async groupChoices(): Promise<Array<{ groupId: string; name: string; memberCount: number | null; recorded: boolean; seen: number }>> {
    const groups = await this.client.groups()
    this.learn(groups)
    return groups.map(group => ({
      groupId: group.groupId, name: group.name, memberCount: group.memberCount, recorded: this.recordedIds.has(group.groupId), seen: group.unlistedSeen,
    }))
  }

  // ---- reading, for the tools ----

  /**
   * Every group the account is in, with what is recorded of it.
   * @returns recorded groups first, then the others.
   * @throws {@link RecorderUnavailable} while the recorder is down.
   */
  async groupOverview(): Promise<GroupOverview[]> {
    const groups = await this.client.groups()
    this.learn(groups)
    const digested = this.store?.lastDigestTimes() ?? new Map<string, number>()
    return groups.map(group => ({
      groupId: group.groupId, name: group.name, memberCount: group.memberCount, recorded: this.recordedIds.has(group.groupId),
      messages: group.messages, firstAt: group.firstAt, lastAt: group.lastAt, lastDigestAt: digested.get(group.groupId) ?? null,
    })).sort((a, b) => Number(b.recorded) - Number(a.recorded) || b.messages - a.messages || a.name.localeCompare(b.name))
  }

  /**
   * Display name of a group, from what the recorder last reported.
   * @param groupId - group number.
   * @returns the name, or the number when none is known yet.
   */
  groupName(groupId: string): string {
    return this.names.get(groupId) ?? groupId
  }

  /**
   * `qq_digest_write` for the tools of the digest preset: stage the calling Session's digest.
   * @param sessionId - the calling Session.
   * @param groupId - the group the model names; it must be the group the Session is digesting.
   * @param text - the digest.
   * @returns what to tell the model.
   */
  digestWrite(sessionId: string | undefined, groupId: string, text: string): ToolOutcome {
    return this.digest?.writeDigest(sessionId, groupId, text) ?? { ok: false, error: 'this tool works only inside a QQ digest turn' }
  }

  /**
   * `qq_group_note` for the tools of the digest preset: add or remove a note of the group the calling Session is digesting.
   * @param sessionId - the calling Session.
   * @param groupId - the group the model names; it must be the group the Session is digesting.
   * @param op - `add` or `remove`.
   * @param text - the note, or for `remove` its `#id` or exact text.
   * @returns what to tell the model.
   */
  async groupNote(sessionId: string | undefined, groupId: string, op: string, text: string): Promise<ToolOutcome> {
    return this.digest === undefined ? { ok: false, error: 'this tool works only inside a QQ digest turn' } : this.digest.groupNote(sessionId, groupId, op, text)
  }

  /**
   * The group a digest Session is digesting, for a tool that takes the group from the Session.
   * @param sessionId - the calling Session.
   * @returns the group number while the Session's turn runs; otherwise undefined.
   */
  groupOfSession(sessionId: string | undefined): string | undefined {
    return this.digest?.groupOfSession(sessionId)
  }

  /**
   * The text of the messages the calling digest Session was shown this turn, for a tool that checks a quotation word for word.
   * @param sessionId - the calling Session.
   * @returns the stored one-line texts while the turn runs; otherwise undefined.
   */
  recentTextOf(sessionId: string | undefined): readonly string[] | undefined {
    return this.digest?.recentTextOf(sessionId)
  }

  /**
   * The notes of a recorded group: what the QQ channel remembers of its habits.
   * @param groupId - group number; an unrecorded group yields nothing.
   * @returns the notes, oldest first.
   */
  groupNotes(groupId: string): Array<{ id: number; text: string; createdAt: number }> {
    return this.recordedIds.has(groupId) ? this.store?.notes(groupId) ?? [] : []
  }

  /**
   * Evidence for a claim about a group's chat, without exposing who said what: for each message id the group still
   * holds, a stable sender key (a salted hash of the member within this group, never the QQ number), its time, and its
   * stored one-line text, so a caller can check a quotation word for word.
   * @param groupId - group number; an unrecorded group yields nothing.
   * @param messageIds - OneBot message ids, at most 200 are looked at.
   * @returns one entry per message found: recorded, not recalled, and still inside the retention window.
   * @throws {@link RecorderUnavailable} while the recorder is down.
   */
  async evidenceOf(groupId: string, messageIds: readonly string[]): Promise<Array<{ messageId: string; senderKey: string; at: number; text: string }>> {
    if (!this.recordedIds.has(groupId) || this.store === undefined) return []
    const { textDays } = this.live.retention
    const since = textDays > 0 ? this.now() - textDays * 86_400_000 : 0
    const salt = await this.store.ensureSalt()
    const rows = await this.client.lookup(groupId, messageIds.slice(0, 200))
    return rows.filter(row => !row.recalled && row.at >= since)
      .map(row => ({ messageId: row.messageId, senderKey: senderKey(groupId, row.userId, salt), at: row.at, text: row.text }))
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
   * @throws {@link RecorderUnavailable} while the recorder is down.
   */
  async recentMessages(groupId: string, options: { hours: number; limit: number; userId?: string }): Promise<MessageRow[]> {
    if (!this.recordedIds.has(groupId)) return []
    return this.client.recent(groupId, { sinceMs: this.now() - options.hours * 3_600_000, limit: options.limit, ...options.userId === undefined ? {} : { userId: options.userId } })
  }

  /**
   * Search the recorded groups' messages, newest first.
   * @param query - words to find.
   * @param options - one group, or all recorded groups, and at most `limit` matches.
   * @returns the matching messages.
   * @throws {@link RecorderUnavailable} while the recorder is down.
   */
  async searchMessages(query: string, options: { groupId?: string; limit: number }): Promise<MessageRow[]> {
    if (options.groupId !== undefined && !this.recordedIds.has(options.groupId)) return []
    const rows = await this.client.search(query, options)
    return rows.filter(row => this.recordedIds.has(row.groupId))
  }

  /**
   * Newest digests of the recorded groups.
   * @param options - one group, or all recorded groups, a window in days, and at most `limit` digests.
   * @returns the digests, newest first.
   */
  digests(options: { groupId?: string; days: number; limit: number }): DigestRow[] {
    if (options.groupId !== undefined && !this.recordedIds.has(options.groupId)) return []
    const sinceMs = this.now() - options.days * 86_400_000
    return (this.store?.digests({ ...options.groupId === undefined ? {} : { groupId: options.groupId }, sinceMs, limit: options.limit }) ?? [])
      .filter(row => this.recordedIds.has(row.groupId))
  }

  /**
   * Delete stored digests: the observer's learned knowledge. Raw messages age out by themselves.
   * @param options - one group and/or those made before `beforeMs`; at least one is required.
   * @returns how many digests were deleted.
   */
  async forgetDigests(options: { groupId?: string; beforeMs?: number }): Promise<number> {
    const count = await this.store?.deleteDigests(options) ?? 0
    this.ctx.logger.info(`fork-qq: deleted ${count} digest(s)${options.groupId === undefined ? '' : ` of group ${options.groupId}`}${options.beforeMs === undefined ? '' : ' made before a cutoff'}`)
    return count
  }

  // ---- sending (refused) ----

  /**
   * Sending is not offered: the recorder has no send endpoint, and the channel is read-only.
   * @param groupId - group number.
   * @param _text - what to send.
   * @throws {@link SendRefused} always.
   */
  sendGroupMessage(groupId: string, _text: string): Promise<void> {
    return Promise.reject(new SendRefused(`sending to group ${groupId} is not available: the QQ channel is read-only`))
  }

  // ---- the Settings page's QQ section ----

  /** The closing sentence of an owner notice: where to log in again. */
  private settingsHint(): string {
    const url = this.live.settingsUrl
    return `在 DSH 网页端「设置 → QQ」扫码重新登录${url === undefined ? '' : `：${url}`}`
  }

  /**
   * Which optional capabilities of the recorder in front of this DSH are available: a recorder of an older minor version
   * lacks some, and only those features degrade.
   * @returns each feature of the protocol and whether the recorder offers it.
   */
  features(): Record<string, boolean> {
    return Object.fromEntries(Object.keys(FEATURE_MINOR).map(feature => [feature, this.client.supports(feature)]))
  }

  /**
   * The observer's connection to the protocol end, for the Settings page's QQ section: whether the socket is up,
   * since when, how many attempts have failed in a row, and why the last one did; or that the recorder itself is not there.
   * @returns the connection state; `selfId` is the logged-in account only while connected.
   */
  connectionStatus(): QqConnection {
    return this.client.connection()
  }

  /**
   * How many groups the observer records, for the Settings page's QQ section.
   * @returns the size of the configured `groups` list.
   */
  recordedGroups(): number {
    return this.recordedIds.size
  }

  private toReading(login: Login): QqLoginReading {
    const door = login.door === 'unknown' ? 'invalid' : login.door
    return { door, state: login.state, uin: login.uin, nickname: login.nickname, error: login.error, qrUrl: login.qrUrl }
  }

  private recorderDownReading(): QqLoginReading {
    return { door: 'recorder-down', state: null, uin: null, nickname: null, error: null, qrUrl: null }
  }

  /**
   * NapCat's login as the recorder's login door reports it, for the Settings page's QQ section.
   * @param options - `fresh` skips the recorder's shared answer.
   * @returns the reading; `door` says why there is no `state` when the door could not answer, or `recorder-down`.
   */
  async loginStatus(options: { fresh?: boolean } = {}): Promise<QqLoginReading> {
    try {
      return this.toReading(await this.client.login(options.fresh === true))
    } catch (error: unknown) {
      if (error instanceof RecorderUnavailable) return this.recorderDownReading()
      throw error
    }
  }

  /**
   * Ask NapCat for a fresh login QR code through the recorder (it refuses while QQ is logged in and for ten minutes after
   * the connection came up).
   * @returns the reading after the request, whether the door passed the request on, and why not when it did not.
   */
  async refreshLogin(): Promise<{ login: QqLoginReading; refreshed: boolean; reason: RefreshRefusal | null }> {
    try {
      const answer = await this.client.refreshLogin()
      return { login: this.toReading(answer.login), refreshed: answer.refreshed, reason: answer.reason === 'unknown' ? 'unreachable' : answer.reason }
    } catch (error: unknown) {
      if (error instanceof RecorderUnavailable) return { login: this.recorderDownReading(), refreshed: false, reason: 'unreachable' }
      throw error
    }
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
        if (this.wake === done) this.wake = undefined
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.wake = done
      this.abort.signal.addEventListener('abort', done, { once: true })
    })
  }

  /** The link to the recorder changed: carry the digest state over once, and look at the outage clock. */
  private onLinkChange(): void {
    if (this.client.link() === 'ok') this.track(this.importLegacy())
    this.track(this.checkOutage(false))
  }

  /** Copy the digest state the recorder holds from before the move, once. */
  private importLegacy(): Promise<void> {
    const store = this.store
    if (store === undefined || store.imported || this.importing !== undefined) return this.importing ?? Promise.resolve()
    if (!this.client.supports('legacyState')) return Promise.resolve()
    const run = (async (): Promise<void> => {
      try {
        const legacy = await this.client.legacyState()
        const result = await store.importLegacy(legacy, this.now())
        if (result.imported) {
          this.ctx.logger.info(`fork-qq: took over ${result.digests} digest(s), ${result.notes} note(s), and ${result.sessions} resident Session(s) from the recorder's old tables`)
          if (legacy.outageNoticeAt !== null) this.lastNoticeAt = legacy.outageNoticeAt
        }
        this.importWarned = false
      } catch (error: unknown) {
        if (!this.importWarned) this.ctx.logger.warn(`fork-qq: could not take over the old digest state yet: ${errorText(error)}; digests wait for it`)
        this.importWarned = true
      }
    })().finally(() => { this.importing = undefined })
    this.importing = run
    return run
  }

  /** Digest rounds, until the plugin stops. A round waits for the link and for the one-time import. */
  private async schedule(): Promise<void> {
    await this.pause(30_000)
    while (!this.stopping) {
      try {
        if (this.config.digest.enabled && this.digest !== undefined) {
          await this.importLegacy()
          if (this.client.link() !== 'ok') {
            this.ctx.logger.info(`fork-qq: digest round skipped: the recorder is ${this.client.link()}`)
          } else if (this.store?.imported !== true && this.client.supports('legacyState')) {
            this.ctx.logger.info('fork-qq: digest round skipped: the old digest state is not taken over yet')
          } else {
            const stored = await this.digest.runRound([...this.recordedIds], this.abort.signal)
            if (stored > 0) this.ctx.logger.info(`fork-qq: digest round stored ${stored} digest(s)`)
          }
        }
        await this.checkOutage(false)
      } catch (error: unknown) {
        this.ctx.logger.warn(`fork-qq: scheduled work failed: ${errorText(error)}`)
      }
      await this.pause(SCHEDULE_MS)
    }
  }

  // ---- the owner notice ----

  /**
   * Tell the owner when the protocol end stays unreachable, or reports the account offline. The recorder only reports the
   * facts; what to say and when is decided here. A recorder that is down is the alert chain's business, not a QQ notice.
   * @param botOffline - the recorder just reported `bot-offline`.
   */
  private async checkOutage(botOffline: boolean): Promise<void> {
    const store = this.store
    const status = this.client.status()
    if (store === undefined || status === undefined) return
    if (status.connection.state === 'connected' && status.outage.botOfflineAt === null) {
      if (this.lastNoticeAt !== undefined) {
        this.lastNoticeAt = undefined
        await store.deleteMeta('outage-notice-at')
      }
      return
    }
    if (botOffline || status.outage.botOfflineAt !== null) {
      await this.notifyOwner('QQ 号掉线了', `NapCat 报告这个 QQ 号下线（被踢或登录失效）。${this.settingsHint()}`)
      return
    }
    const since = status.outage.disconnectedSince
    const { offlineNoticeMs } = this.live
    if (since === null || offlineNoticeMs === 0 || this.now() - since < offlineNoticeMs) return
    await this.notifyOwner('QQ 协议端连不上', `fork-qq 已有 ${Math.round((this.now() - since) / 60_000)} 分钟连不上协议端，多半是 QQ 被踢下线了。${this.settingsHint()}`)
  }

  /** Whether the owner may be told now: never told of this outage, or told long enough ago to remind. */
  private noticeDue(): boolean {
    if (this.lastNoticeAt === undefined) return true
    return this.live.offlineRepeatMs > 0 && this.now() - this.lastNoticeAt >= this.live.offlineRepeatMs
  }

  private async notifyOwner(title: string, body: string): Promise<void> {
    if (!this.noticeDue()) return
    this.lastNoticeAt = this.now()
    try {
      await this.store?.setMeta('outage-notice-at', String(this.lastNoticeAt))
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
}

export default QqObserver
