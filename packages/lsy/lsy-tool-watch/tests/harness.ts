/** Tool tests mount the real bus, sensor, and tool registry over memory storage, a fake GitHub, and notifier/webhook doubles. */
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import LsyEventBus, { type Config as BusConfig, type LsyNote, type LsyNotifier } from '@deepseek-ai/dsh-lsy-event-bus'
import GithubSensor, { type Config as SensorConfig } from '@deepseek-ai/dsh-lsy-github-sensor'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import ToolRuntime, { type ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { vi } from 'vitest'
import { FakeGitHub } from '../../lsy-github-sensor/tests/fake-github.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as ToolWatch from '../src/index.ts'

export const busConfig: BusConfig = {
  subscriptions: [
    { id: 'config-releases', sources: ['github'], kinds: ['github.release'], subjects: ['octo/repo'], action: 'notify', coalesceMs: 60_000, maxPerHour: 12 },
    { id: 'config-everything', sources: [], kinds: ['custom.*'], subjects: [], action: 'notify', coalesceMs: 60_000, maxPerHour: 12 },
  ],
  suppress: { actors: [], markers: ['Dsh-Agent:'] },
  retainEvents: 1000,
  retainBatches: 100,
  maxTextChars: 2000,
  notifySessionResult: true,
  reportScheduledTurns: true,
  maxNoteEvents: 10,
  webUrl: 'https://dsh.example/',
}

export const sensorConfig: SensorConfig = {
  intervalMs: 60_000,
  apiBase: 'https://api.github.test',
  tokenEnv: 'LSY_GITHUB_TOKEN',
  notificationsTokenEnv: 'LSY_GITHUB_NOTIFICATIONS_TOKEN',
  notifications: true,
  repos: [{ repo: 'octo/repo', watch: ['releases'] }],
  timeoutMs: 10_000,
  maxTextChars: 2000,
  perPage: 20,
  maxSeenPerStream: 200,
}

/** Paths the fake GitHub serves for `acme/tool`. */
export const ACME = {
  repo: '/repos/acme/tool',
  releases: '/repos/acme/tool/releases?per_page=20',
  tags: '/repos/acme/tool/tags?per_page=20',
  commits: '/repos/acme/tool/commits?per_page=20&sha=dev',
}
export const OCTO_RELEASES = '/repos/octo/repo/releases?per_page=20'
export const NOTIFICATIONS = '/notifications?per_page=50'

/** A repository body as `GET /repos/{owner}/{name}` returns it. */
export function repository(fullName: string, overrides: Record<string, unknown> = {}) {
  return { full_name: fullName, private: false, default_branch: 'main', ...overrides }
}

const contexts: Context[] = []

/** Options of {@link harness}. */
export interface HarnessOptions {
  gh?: FakeGitHub
  tokens?: Record<string, string>
  bus?: Partial<BusConfig>
  sensor?: Partial<SensorConfig>
  tool?: Partial<ToolWatch.Config>
  /** `false` mounts no notifier. */
  notifier?: false
}

/**
 * Mount the bus, the sensor, the tool registry, and the watch tools.
 * @param options - fake GitHub, tokens, and config overrides.
 * @returns context, notes, webhook deliveries and rules, the fake GitHub, and call helpers.
 */
export async function harness(options: HarnessOptions = {}) {
  const gh = options.gh ?? new FakeGitHub()
  vi.stubGlobal('fetch', gh.fetch)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Timer)
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  ctx.effect(() => async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => { await facility.closeAll(); unmount() }
  })
  const tokens = options.tokens ?? { LSY_GITHUB_TOKEN: 'repo-token', LSY_GITHUB_NOTIFICATIONS_TOKEN: 'notif-token' }
  ctx.provide('credentials', {
    resolve: async (ref: string) => tokens[ref] === undefined ? undefined : { value: tokens[ref], source: 'env' },
  } as never)
  const notes: LsyNote[] = []
  // Tests replace `send` to simulate a failing channel and add `ownsSession` to simulate the owner's chat Session.
  const notifier: LsyNotifier = { send: async (note: LsyNote) => { notes.push(note) } }
  if (options.notifier !== false) ctx.provide('lsyNotifier', notifier)
  const deliveries: unknown[] = []
  const rules: { run: (delivery: unknown, signal: AbortSignal) => unknown }[] = []
  ctx.provide('webhookRuntime', {
    register: (rule: never) => { rules.push(rule); return async () => {} },
    dispatch: (delivery: unknown) => { deliveries.push(delivery) },
  } as never)
  // Native tool presentation only reads the prompt's tool-provider seam.
  ctx.provide('systemPrompt', { tools: () => () => {} } as never)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(LsyEventBus, Object.assign({}, busConfig, options.bus))
  await ctx.plugin(GithubSensor, Object.assign({}, sensorConfig, options.sensor))
  // The plugin's Config schema fills the omitted defaults.
  await ctx.plugin(ToolWatch, (options.tool ?? {}) as never)
  await vi.advanceTimersByTimeAsync(0)

  /** Run one tool through the registry, which validates arguments and the output schema. */
  const call = async (name: string, args: unknown) => {
    const batch = await ctx.tools.execute({ signal: new AbortController().signal, calls: [{ type: 'tool-call', id: ToolCallId(`${name}-call`), name, arguments: JSON.stringify(args) }] })
    return batch.results[0]!.result
  }
  /** Run one tool body directly with a caller Agent stub. */
  const callAs = async (sessionId: string, name: string, args: unknown) => {
    const definition = ctx.tools.get(name)
    if (definition === undefined) throw new Error(`missing tool ${name}`)
    return await definition.execute(args, {
      callId: ToolCallId('body-call'),
      rootCallId: ToolCallId('body-call'),
      token: Symbol('test-body') as ToolExecutionToken,
      name,
      arguments: args,
      agent: { session: { id: sessionId } } as never,
      signal: new AbortController().signal,
      deferContext() {},
      concludeTurn() {},
    })
  }
  return { ctx, gh, notes, notifier, deliveries, rules, call, callAs, bus: ctx.lsyEventBus, sensor: ctx.lsyGithubSensor }
}

/** Dispose every context a test mounted. */
export async function disposeAll(): Promise<void> {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
}
