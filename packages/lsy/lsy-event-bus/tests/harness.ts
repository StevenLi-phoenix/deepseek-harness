/** Shared bus test fixtures: memory storage, notifier, owner relay, and webhook runtime doubles, and Session event emission. */
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { VerifiedWebhookDelivery, WebhookRule } from '@deepseek-ai/dsh-webhook'
import { vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import LsyEventBus, { type Config } from '../src/index.ts'
import type { LsyEventInput, LsyNote, LsyNotifier } from '../src/types.ts'

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

export const baseConfig: Config = {
  subscriptions: [
    { id: 'releases', sources: ['github'], kinds: ['github.release'], subjects: [], action: 'notify', coalesceMs: 60_000, maxPerHour: 2 },
  ],
  suppress: { actors: ['dsh-bot'], markers: ['Dsh-Agent:'] },
  retainEvents: 100,
  retainBatches: 100,
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
  notifier?: false | Partial<LsyNotifier>
  /** Claiming channel per Session, served as `ctx.ownerRelay.ownerOf()`; omitted mounts no relay. */
  claims?: ReadonlyMap<string, string>
  runtime?: FakeRuntime | false
}

/**
 * Mount a bus over memory storage with notifier and webhook runtime doubles.
 * @param options - config, shared media pool, and double selection.
 * @returns context, bus, recorded notes, runtime double, pool, and a Session event emitter.
 */
export async function harness(options: HarnessOptions = {}) {
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
  const notes: LsyNote[] = []
  if (options.notifier !== false) {
    ctx.provide('lsyNotifier', { send: async (note: LsyNote) => { notes.push(note) }, ...options.notifier })
  }
  const claims = options.claims
  if (claims !== undefined) ctx.provide('ownerRelay' as never, { ownerOf: (id: string) => claims.get(id) } as never)
  const runtime = options.runtime === false ? fakeRuntime() : options.runtime ?? fakeRuntime()
  if (options.runtime !== false) ctx.provide('webhookRuntime', runtime as never)
  await ctx.plugin(LsyEventBus, options.config ?? baseConfig)
  await vi.advanceTimersByTimeAsync(0)
  const emit = (sessionId: string, event: unknown): void => {
    (ctx.emit as (...args: unknown[]) => void)('session/event', { id: sessionId }, event)
  }
  return { ctx, bus: ctx.lsyEventBus, notes, runtime, pool, emit }
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
export function release(n: number, overrides: Partial<LsyEventInput> = {}): LsyEventInput {
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
  webhook: (deliveryId: string, source = 'triage') => ({ type: 'user/message', seq: 1, data: { role: 'user', content: [], source: { kind: 'webhook', provider: 'lsy-event', source, deliveryId, ruleId: 'lsy-event', form: 'notice' } } }),
  schedule: (text: string) => ({ type: 'user/message', seq: 1, data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'schedule' } } }),
  assistant: (text: string) => ({ type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } } }),
  turnEnd: (kind = 'completed') => ({ type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind } } }),
}
