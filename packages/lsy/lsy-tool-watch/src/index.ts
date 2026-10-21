/**
 * Model-facing `watch_create`, `watch_list`, and `watch_delete` tools over the
 * lsy event bus and GitHub sensor. Mounting the plugin registers them in the
 * mounting scope, so a preset decides which agents may change what the
 * service monitors; watches are global to the instance, not to a Session.
 * @module @deepseek-ai/dsh-lsy-tool-watch
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { LsySubscriptionError, type Subscription, type SubscriptionView } from '@deepseek-ai/dsh-lsy-event-bus'
import { REPO_STREAMS, streamId, type CredentialStatus, type PollStatus, type RepoProbe, type RepoStream, type WatchedRepo } from '@deepseek-ai/dsh-lsy-github-sensor'
import { defineTool, type GenericCallView } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

/** Plugin name registered with the Loader. */
export const name = 'lsy-tool-watch'

/** Host services this plugin consumes; the bus and the sensor are resolved per scope. */
export const inject = ['tools']

/** Longest coalesce window a call may ask for: one day. */
const MAX_COALESCE_SECONDS = 86_400
/** Highest hourly batch limit a call may ask for. */
const MAX_PER_HOUR = 60

/** Defaults applied to watches the model creates. */
export interface Config {
  /** Absolute Workspace of Sessions that `session` watches start, unless the call names one. */
  defaultWorkspacePath: string
  /** Agent preset of those Sessions. */
  defaultAgentPreset: string
  /** Permission preset of those Sessions. */
  defaultPermissionPreset: string
  /** Seconds after the first new event during which later events join the same batch. */
  defaultCoalesceSeconds: number
  /** Batches per rolling hour of a `notify` watch. */
  defaultNotifyMaxPerHour: number
  /** Batches per rolling hour of a `session` watch. */
  defaultSessionMaxPerHour: number
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  defaultWorkspacePath: z.string().default('/Users/dsh-runtime/work'),
  defaultAgentPreset: z.string().default('unattended'),
  defaultPermissionPreset: z.string().default('danger-full-access'),
  defaultCoalesceSeconds: z.natural().max(MAX_COALESCE_SECONDS).default(60),
  defaultNotifyMaxPerHour: z.natural().min(1).max(MAX_PER_HOUR).default(12),
  defaultSessionMaxPerHour: z.natural().min(1).max(MAX_PER_HOUR).default(4),
})

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/
const REPO_NAME = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
const NOTIFICATION_KINDS = ['github.notification.*']
const KIND_OF_STREAM: Record<RepoStream, string> = { releases: 'github.release', tags: 'github.tag', commits: 'github.commit' }
/** Bounds of the event data embedded in a started Session's prompt. */
const SESSION_PROMPT_EVENTS = 50
const SESSION_TEXT_CHARS = 2000
/** Characters of session instructions quoted in an audit note. */
const AUDIT_INSTRUCTION_CHARS = 200

const CREATE_KEYS = [
  'id', 'github_repo', 'streams', 'branch', 'github_notifications', 'action', 'instructions', 'workspace_path', 'coalesce_seconds', 'max_per_hour',
] as const

const ERROR_CODES = [
  'invalid_arguments', 'invalid_id', 'invalid_target', 'invalid_streams', 'invalid_action', 'invalid_workspace', 'invalid_limits',
  'duplicate_id', 'repo_unavailable', 'watch_not_found', 'config_owned', 'internal_error',
] as const

/** Stable error code of a refused call. */
export type WatchErrorCode = typeof ERROR_CODES[number]

/** A refused call. */
export interface WatchError {
  code: WatchErrorCode
  message: string
}

const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true, enum: ERROR_CODES },
    message: { type: 'string', required: true },
  },
} as const

const STRING_LIST = { type: 'array', items: { type: 'string' } } as const

const TARGET_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'github_repo' },
        repo: { type: 'string', required: true },
        streams: { type: 'array', required: true, items: { type: 'string', enum: REPO_STREAMS } },
        branch: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: { kind: { type: 'string', required: true, const: 'github_notifications' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'event_filter' },
        sources: { ...STRING_LIST, required: true },
        kinds: { ...STRING_LIST, required: true },
        subjects: { ...STRING_LIST, required: true },
      },
    },
  ],
} as const

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pending_events: { type: 'integer', required: true },
    batches_last_hour: { type: 'integer', required: true },
    next_batch_at: { type: 'string' },
    last_batch: {
      type: 'object',
      additionalProperties: false,
      properties: {
        at: { type: 'string', required: true },
        events: { type: 'integer', required: true },
        status: { type: 'string', required: true, enum: ['dispatched', 'delivered', 'completed', 'failed'] },
        outcome: { type: 'string' },
        silent: { type: 'boolean' },
        error: { type: 'string' },
      },
    },
    polling: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stream: { type: 'string', required: true },
          polled: { type: 'boolean', required: true },
          baseline: { type: 'boolean', required: true },
          last_poll: {
            type: 'object',
            additionalProperties: false,
            properties: {
              at: { type: 'string', required: true },
              ok: { type: 'boolean', required: true },
              detail: { type: 'string' },
            },
          },
        },
      },
    },
  },
} as const

const VIEW_PROPERTIES = {
  id: { type: 'string', required: true },
  origin: { type: 'string', required: true, enum: ['config', 'agent'] },
  target: { ...TARGET_SCHEMA, required: true },
  action: { type: 'string', required: true, enum: ['notify', 'session'] },
  instructions: { type: 'string' },
  workspace_path: { type: 'string' },
  coalesce_seconds: { type: 'number', required: true },
  max_per_hour: { type: 'integer', required: true },
  created_at: { type: 'string' },
  status: { ...STATUS_SCHEMA, required: true },
} as const

const VIEW_SCHEMA = { type: 'object', additionalProperties: false, properties: VIEW_PROPERTIES } as const

const TOKEN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    configured: { type: 'boolean', required: true },
  },
} as const

const CREATE_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: { ...VIEW_PROPERTIES, warnings: { ...STRING_LIST, required: true } },
    },
    ERROR_SCHEMA,
  ],
} as const

const LIST_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        watches: { type: 'array', required: true, items: VIEW_SCHEMA },
        credentials: {
          type: 'object',
          required: true,
          additionalProperties: false,
          properties: {
            github_token: { ...TOKEN_SCHEMA, required: true },
            github_notifications_token: { ...TOKEN_SCHEMA, required: true },
            notifications_polling: { type: 'boolean', required: true },
          },
        },
      },
    },
    ERROR_SCHEMA,
  ],
} as const

const DELETE_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        deleted: { type: 'boolean', required: true, const: true },
      },
    },
    ERROR_SCHEMA,
  ],
} as const

const CREATE_DESCRIPTION =
  'Watch an external source and react when something new appears there. '
  + 'Give exactly one target: github_repo (owner/name, with streams releases, tags, and/or commits; default releases) '
  + 'or github_notifications: true (the owner\'s GitHub notification threads). '
  + 'Items that already exist when the watch is created are recorded as a baseline and never reported. '
  + 'New items are deduplicated and batched: a batch collects what arrives within coalesce_seconds of its first item, and at most max_per_hour batches run per hour. '
  + 'action "notify" sends the owner one WeChat message per batch listing the new items. '
  + 'action "session" starts an unattended agent with your instructions plus the batch\'s event data; its final answer is sent to the owner over WeChat, '
  + 'and a final answer of exactly NO_REPLY sends nothing. '
  + 'Watches persist across restarts until watch_delete. For time-based checks use schedule_create instead.'

const LIST_DESCRIPTION =
  'List every watch, including ones defined in the deployment configuration, with its target, action, and status '
  + '(pending events, recent batches, whether each stream is polled and has its baseline), and whether the GitHub tokens are configured.'

const DELETE_DESCRIPTION =
  'Delete a watch created with watch_create: its repository stops being polled and its pending events are dropped. '
  + 'Watches defined in the deployment configuration cannot be deleted.'

/** One watch target as the model sees it. */
type TargetView =
  | { kind: 'github_repo'; repo: string; streams: RepoStream[]; branch?: string }
  | { kind: 'github_notifications' }
  | { kind: 'event_filter'; sources: string[]; kinds: string[]; subjects: string[] }

/** Polling state of one stream behind a watch. */
interface PollingView {
  stream: string
  polled: boolean
  baseline: boolean
  last_poll?: { at: string; ok: boolean; detail?: string }
}

/** One watch as the model sees it. */
export interface WatchView {
  id: string
  origin: 'config' | 'agent'
  target: TargetView
  action: 'notify' | 'session'
  instructions?: string
  workspace_path?: string
  coalesce_seconds: number
  max_per_hour: number
  created_at?: string
  status: {
    pending_events: number
    batches_last_hour: number
    next_batch_at?: string
    last_batch?: { at: string; events: number; status: 'dispatched' | 'delivered' | 'completed' | 'failed'; outcome?: string; silent?: boolean; error?: string }
    polling?: PollingView[]
  }
}

/** Arguments of `watch_create` after schema validation. */
interface CreateArgs {
  id: string
  github_repo?: string
  streams?: RepoStream[]
  branch?: string
  github_notifications?: boolean
  action?: 'notify' | 'session'
  instructions?: string
  workspace_path?: string
  coalesce_seconds?: number
  max_per_hour?: number
}

/** ISO 8601 text of an epoch-milliseconds time. */
function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/** Deterministic model content: the canonical JSON of the result value. */
function renderValue(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}

/** Pure generic pending card. */
function present(title: string, kind: 'read' | 'other', rawInput?: string): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

/** Stable error for failures not safe to expose. */
function internalError(): WatchError {
  return { code: 'internal_error', message: 'The watch operation failed.' }
}

/** Human-readable error text for logs. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** True for a safe integer within the bounds. */
function isIntegerIn(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max
}

/** Validate `watch_create` arguments beyond the types and enums the parameter schema enforces. */
function validateCreate(args: CreateArgs): WatchError | undefined {
  const unknown = Object.keys(args).filter(key => !(CREATE_KEYS as readonly string[]).includes(key))
  if (unknown.length > 0) {
    return { code: 'invalid_arguments', message: `Unknown argument(s) ${unknown.join(', ')}; watch_create accepts ${CREATE_KEYS.join(', ')}.` }
  }
  if (!ID_PATTERN.test(args.id)) {
    return { code: 'invalid_id', message: 'id must be 1-63 lowercase letters, digits, or hyphens, starting with a letter or digit.' }
  }
  if (args.github_notifications === false) {
    return { code: 'invalid_target', message: 'github_notifications must be true when given; omit it to watch a repository.' }
  }
  if ((args.github_repo === undefined) === (args.github_notifications === undefined)) {
    return { code: 'invalid_target', message: 'Give exactly one target: github_repo or github_notifications: true.' }
  }
  if (args.github_notifications === true && (args.streams !== undefined || args.branch !== undefined)) {
    return { code: 'invalid_target', message: 'streams and branch apply only to github_repo.' }
  }
  if (args.github_repo !== undefined && !REPO_NAME.test(args.github_repo)) {
    return { code: 'invalid_target', message: 'github_repo must be owner/name, for example deepseek-ai/deepseek-harness.' }
  }
  const streams = args.streams ?? ['releases']
  if (streams.length === 0) {
    return { code: 'invalid_streams', message: `streams must list at least one of ${REPO_STREAMS.join(', ')}.` }
  }
  if (args.branch !== undefined && (args.branch.trim() === '' || !streams.includes('commits'))) {
    return { code: 'invalid_streams', message: 'branch must be a non-empty branch name and applies only to the commits stream; add "commits" to streams.' }
  }
  const action = args.action ?? 'notify'
  if (action === 'session' && (args.instructions === undefined || args.instructions.trim() === '')) {
    return { code: 'invalid_action', message: 'action "session" needs instructions for the agent it starts.' }
  }
  if (action === 'notify' && (args.instructions !== undefined || args.workspace_path !== undefined)) {
    return { code: 'invalid_action', message: 'instructions and workspace_path apply only to action "session".' }
  }
  if (args.workspace_path !== undefined && !args.workspace_path.startsWith('/')) {
    return { code: 'invalid_workspace', message: 'workspace_path must be an absolute path.' }
  }
  if (args.coalesce_seconds !== undefined && !isIntegerIn(args.coalesce_seconds, 0, MAX_COALESCE_SECONDS)) {
    return { code: 'invalid_limits', message: `coalesce_seconds must be a whole number from 0 to ${MAX_COALESCE_SECONDS}.` }
  }
  if (args.max_per_hour !== undefined && !isIntegerIn(args.max_per_hour, 1, MAX_PER_HOUR)) {
    return { code: 'invalid_limits', message: `max_per_hour must be a whole number from 1 to ${MAX_PER_HOUR}.` }
  }
  return undefined
}

/** Explain why a repository cannot be watched. */
function unavailableMessage(repo: string, probe: RepoProbe & { ok: false }, credentials: CredentialStatus): string {
  const hint = credentials.token.configured
    ? ''
    : ` ${credentials.token.ref} is not configured, so private repositories are invisible and requests share the 60/hour unauthenticated limit.`
  return `${repo} cannot be read: ${probe.message}${hint}`
}

/** True when two string lists hold the same entries in the same order. */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index])
}

/** Recover the model-facing target of a subscription; the sensor watch with the same id supplies the branch. */
function targetOf(subscription: Subscription, watch: WatchedRepo | undefined): TargetView {
  const github = sameList(subscription.sources, ['github'])
  if (github && sameList(subscription.kinds, NOTIFICATION_KINDS) && subscription.subjects.length === 0) return { kind: 'github_notifications' }
  const streams = subscription.kinds.map(kind => REPO_STREAMS.find(stream => KIND_OF_STREAM[stream] === kind))
  const [repo = '', ...others] = subscription.subjects
  if (github && others.length === 0 && REPO_NAME.test(repo) && streams.length > 0 && streams.every(stream => stream !== undefined)) {
    const branch = watch?.branch
    return { kind: 'github_repo', repo, streams, ...(branch === undefined ? {} : { branch }) }
  }
  return { kind: 'event_filter', sources: subscription.sources, kinds: subscription.kinds, subjects: subscription.subjects }
}

/** One-line description of a target for an audit note. */
function describeTarget(target: TargetView): string {
  switch (target.kind) {
    case 'github_repo':
      return `GitHub repo ${target.repo} [${target.streams.join(', ')}]${target.branch === undefined ? '' : ` on ${target.branch}`}`
    case 'github_notifications':
      return 'GitHub notifications'
    case 'event_filter':
      return `events sources [${target.sources.join(', ')}] kinds [${target.kinds.join(', ')}] subjects [${target.subjects.join(', ')}]`
  }
}

/** Audit note lines naming a watch's target, action, and (bounded, single-line) instructions. */
function auditLines(target: TargetView, action: string, instructions: string | undefined): string[] {
  const lines = [`target: ${describeTarget(target)}`, `action: ${action}`]
  if (instructions !== undefined) {
    const flat = instructions.replace(/\s+/g, ' ').trim()
    lines.push(`instructions: ${flat.length > AUDIT_INSTRUCTION_CHARS ? `${flat.slice(0, AUDIT_INSTRUCTION_CHARS)}…` : flat}`)
  }
  return lines
}

/** Audit note lines of a watch that watch_delete just removed, from the state read before removal. */
function deletedLines(subscription: SubscriptionView | undefined, repoWatch: WatchedRepo | undefined): string[] {
  if (subscription !== undefined) {
    const session = subscription.action === 'session' ? subscription.session : undefined
    return auditLines(targetOf(subscription, repoWatch), subscription.action, session === undefined ? undefined : session.instructions)
  }
  /* v8 ignore next -- watch_delete answers watch_not_found before this when neither side existed. */
  if (repoWatch === undefined) return []
  const branch = repoWatch.branch === undefined ? {} : { branch: repoWatch.branch }
  const target: TargetView = { kind: 'github_repo', repo: repoWatch.repo, streams: repoWatch.watch, ...branch }
  return auditLines(target, 'none (repository watch without a subscription)', undefined)
}

/** Sensor state the views read. */
interface SensorSnapshot {
  repos: WatchedRepo[]
  credentials: CredentialStatus
  baseline: (stream: string) => boolean
  pollStatus: (stream: string) => PollStatus | undefined
}

/** Polling state of the streams behind a target, or undefined for an event filter. */
function pollingOf(target: TargetView, sensor: SensorSnapshot): PollingView[] | undefined {
  const entry = (stream: string, id: string, polled: boolean): PollingView => {
    const status = sensor.pollStatus(id)
    const detail = status?.detail === undefined ? {} : { detail: status.detail }
    return {
      stream,
      polled,
      baseline: sensor.baseline(id),
      ...(status === undefined ? {} : { last_poll: { at: iso(status.at), ok: status.ok, ...detail } }),
    }
  }
  if (target.kind === 'github_notifications') {
    return [entry('notifications', 'notifications', sensor.credentials.notifications && sensor.credentials.notificationsToken.configured)]
  }
  if (target.kind === 'event_filter') return undefined
  const polledIds = new Set(sensor.repos.flatMap(repo => repo.streams.map(stream => stream.id)))
  const repo = { repo: target.repo, watch: target.streams, ...(target.branch === undefined ? {} : { branch: target.branch }) }
  return target.streams.map((stream) => {
    const id = streamId(repo, stream)
    return entry(stream, id, polledIds.has(id))
  })
}

/** Project one bus subscription and its sensor state into the model-facing view. */
function viewOf(subscription: SubscriptionView, sensor: SensorSnapshot): WatchView {
  const watch = sensor.repos.find(repo => repo.origin === 'agent' && repo.ref === subscription.id)
  const target = targetOf(subscription, watch)
  const session = subscription.action === 'session' ? subscription.session : undefined
  const last = subscription.status.lastBatch
  const polling = pollingOf(target, sensor)
  return {
    id: subscription.id,
    origin: subscription.origin,
    target,
    action: subscription.action,
    ...(session === undefined ? {} : { instructions: session.instructions, workspace_path: session.workspacePath }),
    coalesce_seconds: subscription.coalesceMs / 1000,
    max_per_hour: subscription.maxPerHour,
    ...(subscription.createdAt === undefined ? {} : { created_at: iso(subscription.createdAt) }),
    status: {
      pending_events: subscription.status.pending,
      batches_last_hour: subscription.status.batchesLastHour,
      ...(subscription.status.nextFlushAt === undefined ? {} : { next_batch_at: iso(subscription.status.nextFlushAt) }),
      ...(last === undefined ? {} : {
        last_batch: {
          at: iso(last.createdAt),
          events: last.eventCount,
          status: last.status,
          ...(last.outcome === undefined ? {} : { outcome: last.outcome }),
          ...(last.silent === undefined ? {} : { silent: last.silent }),
          ...(last.error === undefined ? {} : { error: last.error }),
        },
      }),
      ...(polling === undefined ? {} : { polling }),
    },
  }
}

/**
 * Register the three watch tools in the mounting scope once the bus and the
 * GitHub sensor resolve there.
 * @param ctx - Context owning the `tools` registry.
 * @param config - Defaults for watches the model creates.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['lsyEventBus', 'lsyGithubSensor'], (scoped) => { registerWatchTools(scoped, config) })
}

/**
 * Register `watch_create`, `watch_list`, and `watch_delete`.
 * @param ctx - Scope whose bus and sensor the tools act through.
 * @param config - Defaults for watches the model creates.
 */
function registerWatchTools(ctx: Context, config: Config): void {
  // Create and delete check one store and then change two; one call at a time keeps the check valid.
  let chain: Promise<unknown> = Promise.resolve()
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const result = chain.then(work)
    chain = result.catch(() => undefined)
    return result
  }

  /**
   * Tell the owner about a watch change made from a Session the notifier does not relay itself,
   * e.g. an event-started Session acting on untrusted input. Never fails the tool call.
   */
  const audit = (sessionId: string | undefined, id: string, title: string, lines: readonly string[]): void => {
    const notifier = ctx.get('lsyNotifier')
    if (notifier === undefined || (sessionId !== undefined && notifier.ownsSession?.(sessionId) === true)) return
    const body = [...lines, `Session: ${sessionId ?? 'unknown'}`].join('\n')
    void Promise.resolve()
      .then(() => notifier.send({ title, body }))
      .catch((error: unknown) => { ctx.logger.warn(`lsy-tool-watch: audit note for ${id} failed: ${errorText(error)}`) })
  }

  const snapshot = async (): Promise<SensorSnapshot> => ({
    repos: ctx.lsyGithubSensor.watchedRepos(),
    credentials: await ctx.lsyGithubSensor.credentialStatus(),
    baseline: stream => ctx.lsyGithubSensor.cursor(stream)?.initialized === true,
    pollStatus: stream => ctx.lsyGithubSensor.pollStatus(stream),
  })

  type CreateResult = WatchView & { warnings: string[] } | WatchError
  const create = async (args: CreateArgs, sessionId: string | undefined, signal: AbortSignal): Promise<CreateResult> => {
    const existing = ctx.lsyEventBus.listSubscriptions().find(subscription => subscription.id === args.id)
    if (existing !== undefined) {
      return existing.origin === 'config'
        ? { code: 'duplicate_id', message: `"${args.id}" is a watch from the deployment configuration; choose another id.` }
        : { code: 'duplicate_id', message: `A watch with id "${args.id}" already exists; watch_delete it first or choose another id.` }
    }
    const credentials = await ctx.lsyGithubSensor.credentialStatus()
    const warnings: string[] = []
    const action = args.action ?? 'notify'
    const base = {
      id: args.id,
      sources: ['github'],
      action,
      coalesceMs: (args.coalesce_seconds ?? config.defaultCoalesceSeconds) * 1000,
      maxPerHour: args.max_per_hour ?? (action === 'session' ? config.defaultSessionMaxPerHour : config.defaultNotifyMaxPerHour),
      ...(action === 'session' ? {
        session: {
          workspacePath: args.workspace_path ?? config.defaultWorkspacePath,
          agentPreset: config.defaultAgentPreset,
          permissionPreset: config.defaultPermissionPreset,
          // validateCreate already required non-blank instructions for a session watch.
          instructions: String(args.instructions).trim(),
          maxPromptEvents: SESSION_PROMPT_EVENTS,
          maxTextChars: SESSION_TEXT_CHARS,
        },
      } : {}),
    }
    const meta = sessionId === undefined ? {} : { createdBy: sessionId }

    if (args.github_repo === undefined) {
      await ctx.lsyEventBus.subscribe({ ...base, kinds: NOTIFICATION_KINDS, subjects: [] }, meta)
      if (!credentials.notifications) {
        warnings.push('GitHub notification polling is turned off in the sensor configuration (notifications: false), so this watch receives nothing until the owner turns it on.')
      } else if (!credentials.notificationsToken.configured) {
        warnings.push(`${credentials.notificationsToken.ref} is not configured, so no notification events arrive until the owner sets it (a classic token with the notifications scope).`)
      }
    } else {
      const probe = await ctx.lsyGithubSensor.probe(args.github_repo, signal)
      if (!probe.ok) return { code: 'repo_unavailable', message: unavailableMessage(args.github_repo, probe, credentials) }
      const repo = probe.fullName
      const streams = [...new Set<RepoStream>(args.streams ?? ['releases'])]
      await ctx.lsyGithubSensor.watch(args.id, { repo, watch: streams, ...(args.branch === undefined ? {} : { branch: args.branch }) })
      try {
        await ctx.lsyEventBus.subscribe({ ...base, kinds: streams.map(stream => KIND_OF_STREAM[stream]), subjects: [repo] }, meta)
      } catch (error: unknown) {
        await ctx.lsyGithubSensor.unwatch(args.id)
        if (error instanceof LsySubscriptionError && error.code === 'duplicate_id') return { code: 'duplicate_id', message: error.message }
        throw error
      }
      if (repo !== args.github_repo) warnings.push(`Watching ${repo}, GitHub's canonical name for ${args.github_repo}.`)
      if (!credentials.token.configured) {
        warnings.push(`${credentials.token.ref} is not configured: polling is unauthenticated, limited to 60 requests per hour for all watches together.`)
      }
    }
    ctx.logger.info(`lsy-tool-watch: created ${args.id}${sessionId === undefined ? '' : ` for Session ${sessionId}`}`)
    const subscription = ctx.lsyEventBus.listSubscriptions().find(entry => entry.id === args.id)
    /* v8 ignore next -- subscribe() just stored it, and calls are serialized. */
    if (subscription === undefined) throw new Error(`subscription ${args.id} vanished`)
    return { ...viewOf(subscription, await snapshot()), warnings }
  }

  ctx.tools.register(defineTool({
    name: 'watch_create',
    description: CREATE_DESCRIPTION,
    parameters: {
      id: { type: 'string', required: true, description: 'Short unique id, e.g. "harness-releases": 1-63 lowercase letters, digits, or hyphens.' },
      github_repo: { type: 'string', description: 'Target: repository owner/name to watch.' },
      streams: {
        type: 'array',
        items: { type: 'string', enum: REPO_STREAMS },
        description: 'What to watch in github_repo: new releases, tags, and/or commits. Default ["releases"].',
      },
      branch: { type: 'string', description: 'Branch for the commits stream; the default branch when omitted.' },
      github_notifications: { type: 'boolean', description: 'Target: true to watch the owner\'s GitHub notification threads (issues, pull requests, mentions, reviews).' },
      action: { type: 'string', enum: ['notify', 'session'], description: 'notify (default) messages the owner; session starts an unattended agent with instructions.' },
      instructions: { type: 'string', description: 'Required for action "session": what the agent should do with the new events.' },
      workspace_path: { type: 'string', description: `Absolute working directory for action "session"; default ${config.defaultWorkspacePath}.` },
      coalesce_seconds: { type: 'number', description: `Seconds to wait after the first new event so later ones join the same batch; default ${config.defaultCoalesceSeconds}.` },
      max_per_hour: {
        type: 'number',
        description: `Most batches per rolling hour; later ones wait. Default ${config.defaultNotifyMaxPerHour} for notify, ${config.defaultSessionMaxPerHour} for session.`,
      },
    },
    output: { schema: CREATE_OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec) {
      const invalid = validateCreate(args)
      if (invalid !== undefined) return invalid
      const sessionId = exec.agent?.session.id
      let result: CreateResult
      try {
        result = await serialize(() => create(args, sessionId, exec.signal))
      } catch (error: unknown) {
        ctx.logger.warn(`lsy-tool-watch: watch_create ${args.id} failed: ${errorText(error)}`)
        return internalError()
      }
      if (!('code' in result)) audit(sessionId, args.id, `🆕 watch created: ${args.id}`, auditLines(result.target, result.action, result.instructions))
      return result
    },
    presentCall: args => present(args.github_repo === undefined ? 'Watch GitHub notifications' : `Watch ${args.github_repo}`, 'other', args.id),
  }))

  ctx.tools.register(defineTool({
    name: 'watch_list',
    description: LIST_DESCRIPTION,
    parameters: {},
    output: { schema: LIST_OUTPUT_SCHEMA, render: renderValue },
    async execute() {
      try {
        const state = await snapshot()
        const { credentials } = state
        return {
          watches: ctx.lsyEventBus.listSubscriptions().map(subscription => viewOf(subscription, state)),
          credentials: {
            github_token: { name: credentials.token.ref, configured: credentials.token.configured },
            github_notifications_token: { name: credentials.notificationsToken.ref, configured: credentials.notificationsToken.configured },
            notifications_polling: credentials.notifications,
          },
        }
      } catch (error: unknown) {
        ctx.logger.warn(`lsy-tool-watch: watch_list failed: ${errorText(error)}`)
        return internalError()
      }
    },
    presentCall: () => present('List watches', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'watch_delete',
    description: DELETE_DESCRIPTION,
    parameters: {
      id: { type: 'string', required: true, description: 'Id of the watch, as watch_list shows it.' },
    },
    output: { schema: DELETE_OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec): Promise<{ id: string; deleted: true } | WatchError> {
      if (args.id === '' || args.id.trim() !== args.id) {
        return { code: 'invalid_id', message: 'id must be non-empty without surrounding whitespace.' }
      }
      const sessionId = exec.agent?.session.id
      try {
        return await serialize(async (): Promise<{ id: string; deleted: true } | WatchError> => {
          const subscription = ctx.lsyEventBus.listSubscriptions().find(entry => entry.id === args.id)
          const repoWatch = ctx.lsyGithubSensor.watchedRepos().find(repo => repo.origin === 'agent' && repo.ref === args.id)
          const outcome = await ctx.lsyEventBus.unsubscribe(args.id)
          if (outcome === 'config_owned') {
            return { code: 'config_owned', message: `"${args.id}" is defined in the deployment configuration; only the owner can remove it there.` }
          }
          const unwatched = await ctx.lsyGithubSensor.unwatch(args.id)
          if (outcome === 'not_found' && !unwatched) {
            return { code: 'watch_not_found', message: `No watch has id "${args.id}"; watch_list shows the existing ones.` }
          }
          ctx.logger.info(`lsy-tool-watch: deleted ${args.id}${sessionId === undefined ? '' : ` for Session ${sessionId}`}`)
          audit(sessionId, args.id, `🗑 watch deleted: ${args.id}`, deletedLines(subscription, repoWatch))
          return { id: args.id, deleted: true }
        })
      } catch (error: unknown) {
        ctx.logger.warn(`lsy-tool-watch: watch_delete ${args.id} failed: ${errorText(error)}`)
        return internalError()
      }
    },
    presentCall: args => present('Delete watch', 'other', args.id),
  }))
}
