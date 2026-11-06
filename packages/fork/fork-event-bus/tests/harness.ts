/** Bus test fixtures: memory storage, service doubles (notifier, relay, webhook, Session controller, Workspaces), Session events. */
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { VerifiedWebhookDelivery, WebhookRule } from '@deepseek-ai/dsh-webhook'
import { vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import ForkEventBus, { type Config } from '../src/index.ts'
import type { ForkEventInput, ForkNote, ForkNotifier } from '../src/types.ts'

export const HOUR = 3_600_000

export interface FakeRuntime {
  rules: WebhookRule[]
  deliveries: VerifiedWebhookDelivery[]
  register(rule: WebhookRule): () => Promise<void>
  dispatch(delivery: VerifiedWebhookDelivery): void
}

/** Webhook runtime double that records rules and deliveries. */
export function fakeRuntime(): FakeRuntime {
  const runtime: FakeRuntime = {
    rules: [],
    deliveries: [],
    register(rule) {
      runtime.rules.push(rule)
      return async () => { runtime.rules.splice(runtime.rules.indexOf(rule), 1) }
    },
    dispatch(delivery) { runtime.deliveries.push(delivery) },
  }
  return runtime
}

/** A message a persistent subscription sent into a stored Session. */
export interface Followup {
  content: Array<{ type: string; text?: string }>
  source: Record<string, unknown>
}

/** Session controller double: Sessions it knows take follow-ups; `failures` answer with an error code instead. */
export interface FakeController {
  followups: Map<string, Followup[]>
  failures: Map<string, string>
  known: Set<string>
  /** Session list rows served by `list()`. */
  rows: Array<{
    sessionId: string
    updatedAt: number
    running: boolean
    blank: boolean
    origin?: 'subagent'
    cwd?: string
    /** Omit the Host's list-metadata projection, as a cold row with an empty cache does. */
    cold?: boolean
    projections?: { values: { title?: string | null } }
  }>
  list(request: unknown, signal: AbortSignal): Promise<{ items: unknown[] }>
  resolveAgent(sessionId: string): Promise<{ agent: { followup(message: Followup): void } } | { error: { code: string; message: string } }>
}

/** A Session controller double that knows `known`. */
export function fakeController(...known: string[]): FakeController {
  const controller: FakeController = {
    followups: new Map(),
    failures: new Map(),
    known: new Set(known),
    rows: [],
    async list() {
      return {
        items: controller.rows.map(({ cold, projections, ...row }) => ({
          ...row,
          projections: {
            values: {
              ...cold === true ? {} : { sessionListMetadata: { blank: row.blank, lastPromptAt: row.updatedAt } },
              ...projections?.values,
            },
          },
        })),
      }
    },
    async resolveAgent(sessionId) {
      const failure = controller.failures.get(sessionId)
      if (failure !== undefined) return { error: { code: failure, message: `${failure} for ${sessionId}` } }
      if (!controller.known.has(sessionId)) return { error: { code: 'session/not-found', message: `session "${sessionId}" not found` } }
      const followup = (message: Followup): void => {
        controller.followups.set(sessionId, [...controller.followups.get(sessionId) ?? [], message])
      }
      return { agent: { followup } }
    },
  }
  return controller
}

/** Workspace registry double recording archives and projects. */
export interface FakeRegistry {
  archivedSessionIds: string[]
  pinnedSessionIds: string[]
  /** Sessions whose archive is refused with the Host's active-Session error. */
  active: Set<string>
  projects: Map<string, string>
  archiveSession(sessionId: string): Promise<void>
  resolveByPath(path: string): Promise<{ path: string; title: string } | undefined>
  create(path: string, title?: string): Promise<{ path: string; title: string }>
}

/** A Workspace registry double; `refuse` makes archiving reject. */
export function fakeRegistry(refuse?: string): FakeRegistry {
  const registry: FakeRegistry = {
    archivedSessionIds: [],
    pinnedSessionIds: [],
    active: new Set(),
    projects: new Map(),
    async archiveSession(sessionId) {
      if (refuse !== undefined) throw new Error(refuse)
      if (registry.active.has(sessionId)) throw Object.assign(new Error(`cannot archive session '${sessionId}': the session is active (turn)`), { name: 'WorkspaceActiveSessionError' })
      registry.archivedSessionIds.push(sessionId)
    },
    async resolveByPath(path) {
      const title = registry.projects.get(path)
      return title === undefined ? undefined : { path, title }
    },
    async create(path, title) {
      registry.projects.set(path, title ?? path)
      return { path, title: title ?? path }
    },
  }
  return registry
}

export const baseConfig: Config = {
  subscriptions: [
    { id: 'releases', sources: ['github'], kinds: ['github.release'], subjects: [], action: 'notify', coalesceMs: 60_000, maxPerHour: 2 },
  ],
  suppress: { actors: ['dsh-bot'], markers: ['Dsh-Agent:'] },
  retainEvents: 100,
  retainBatches: 100, flowChangesKept: 200,
  maxTextChars: 2000,
  notifySessionResult: true,
  reportScheduledTurns: true,
  maxNoteEvents: 10,
}

export const sessionConfig: Config = withConfig(baseConfig, {
  webUrl: 'https://dsh.example/',
  subscriptions: [{
    id: 'triage',
    sources: [],
    kinds: ['github.*'],
    subjects: [],
    action: 'session',
    coalesceMs: 1_000,
    maxPerHour: 10,
    session: {
      workspacePath: '/work/space',
      agentPreset: 'unattended',
      permissionPreset: 'danger-full-access',
      instructions: 'Triage these events.',
      maxPromptEvents: 20,
      maxTextChars: 500,
    },
  }],
})

const contexts: Context[] = []

/**
 * Shallow config override.
 * @param base - config to copy.
 * @param overrides - fields to replace.
 * @returns new config.
 */
export function withConfig(base: Config, overrides: Partial<Config>): Config {
  return Object.assign({}, base, overrides)
}

/** Options of {@link harness}. */
export interface HarnessOptions {
  config?: Config
  pool?: MemoryMediaPool
  /** `false` mounts no notifier; an object replaces the recording double. */
  notifier?: false | Partial<ForkNotifier>
  /** Claiming channel per Session, served as `ctx.ownerRelay.ownerOf()`; omitted mounts no relay. */
  claims?: ReadonlyMap<string, string>
  runtime?: FakeRuntime | false
  controller?: FakeController
  registry?: FakeRegistry
  /** Collects `info` and `warn` log lines. */
  logs?: string[]
}

/**
 * Mount a bus over memory storage with notifier and webhook runtime doubles.
 * @param options - config, shared media pool, and double selection.
 * @returns context, bus, recorded notes, runtime double, pool, and a Session event emitter.
 */
export async function harness(options: HarnessOptions = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const logs = options.logs
  if (logs !== undefined) ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push(`${message.type}: ${String(message.args[0])}`) } })
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
  const notes: ForkNote[] = []
  if (options.notifier !== false) {
    ctx.provide('forkNotifier', { send: async (note: ForkNote) => { notes.push(note) }, ...options.notifier })
  }
  const claims = options.claims
  if (claims !== undefined) ctx.provide('ownerRelay' as never, { ownerOf: (id: string) => claims.get(id) } as never)
  const runtime = options.runtime === false ? fakeRuntime() : options.runtime ?? fakeRuntime()
  if (options.runtime !== false) ctx.provide('webhookRuntime', runtime as never)
  if (options.controller !== undefined) ctx.provide('sessionController', options.controller as never)
  if (options.registry !== undefined) ctx.provide('workspaceRegistry', options.registry as never)
  await ctx.plugin(ForkEventBus, options.config ?? baseConfig)
  await vi.advanceTimersByTimeAsync(0)
  const emit = (sessionId: string, event: unknown): void => {
    (ctx.emit as (...args: unknown[]) => void)('session/event', { id: sessionId }, event)
  }
  return { ctx, bus: ctx.forkEventBus, notes, runtime, pool, emit }
}

/** Dispose every context a test mounted. */
export async function disposeAll(): Promise<void> {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
}

/**
 * A release event of `octo/repo`.
 * @param n - release number.
 * @param overrides - fields to replace.
 * @returns event input.
 */
export function release(n: number, overrides: Partial<ForkEventInput> = {}): ForkEventInput {
  return {
    source: 'github',
    kind: 'github.release',
    key: `octo/repo:release:${n}`,
    subject: 'octo/repo',
    title: `v${n}.0.0`,
    url: `https://github.com/octo/repo/releases/v${n}.0.0`,
    ...overrides,
  }
}

/** Session events in the shapes the bus reads. */
export const sessionEvents = {
  webhook: (deliveryId: string, source = 'triage') => ({ type: 'user/message', seq: 1, data: { role: 'user', content: [], source: { kind: 'webhook', provider: 'fork-event', source, deliveryId, ruleId: 'fork-event', form: 'notice' } } }),
  schedule: (text: string) => ({ type: 'user/message', seq: 1, data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'schedule' } } }),
  assistant: (text: string) => ({ type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } } }),
  turnEnd: (kind = 'completed') => ({ type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind } } }),
}
