/**
 * Mounts BiliAccount and the owner relay over memory storage, a shared credential double, fake Sessions,
 * a recording notifier, and the fake Bilibili.
 */
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import type { SessionCreateRequest, SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import LsyEventBus, { Config as BusConfig, type LsyAgentMessage, type LsyNote } from '@deepseek-ai/dsh-lsy-event-bus'
import OwnerRelay from '@deepseek-ai/dsh-owner-relay'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { vi, type Mock } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import BiliAccount, { Config } from '../src/index.ts'
import type { BiliView } from '../src/view.ts'
import { FakeBili } from './fake-bili.ts'

/** A log line the plugin wrote. */
export interface LogLine {
  type: string
  text: string
}

/** One exact route the plugin registered. */
export interface Route {
  path: string
  methods: readonly string[]
  requestBody: string
  fetch: (request: Request) => Promise<Response>
}

/** Every context a test mounted, for disposal. */
export const contexts: Context[] = []
/** Every log line of every mount, for the secret check. */
export const allLogs: LogLine[] = []

/** Credential store shared across re-mounts, like the file the real provider keeps. */
export function credentialStore() {
  const records = new Map<string, CredentialRecord>()
  const provider = {
    readRecord: (key: CredentialKey) => Promise.resolve(records.get(key)),
    modifyRecord: async (key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) => {
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return next ?? records.get(key)
    },
  }
  return { records, provider }
}

/** Session Controller double: Sessions are live and idle once created unless told otherwise. */
export function fakeSessions() {
  const state = {
    created: [] as SessionCreateRequest[],
    prompts: [] as SessionPromptRequest[],
    /** Messages injected into Sessions, as [sessionId, text]. */
    injected: [] as [string, string][],
    live: new Set<string>(),
    status: new Map<string, string>(),
    /** The model route of each Session's last request. */
    headers: new Map<string, { provider: string; model: string }>(),
    /** An explicit model pick not yet used, per Session. */
    picks: new Map<string, { provider: string; model: string }>(),
  }
  const controller = {
    create: (request: SessionCreateRequest) => {
      state.created.push(request)
      // The account's Sessions are bili-N; a WeChat chat Session (preset `unattended`) is chat-N.
      const prefix = request.agentPreset === 'unattended' ? 'chat' : 'bili'
      const sessionId = `${prefix}-${state.created.filter(created => (created.agentPreset === 'unattended') === (prefix === 'chat')).length}`
      state.live.add(sessionId)
      return Promise.resolve({ sessionId })
    },
    resolveAgent: (sessionId: string) => Promise.resolve(state.live.has(sessionId)
      ? { agent: {
        session: {
          id: sessionId,
          requestHeader: () => { const config = state.headers.get(sessionId); return config === undefined ? undefined : { config } },
        },
        status: state.status.get(sessionId) ?? 'idle',
        inject: (message: { content: { type: string; text?: string }[] }) => { state.injected.push([sessionId, message.content[0]?.text ?? '']) },
      } }
      : { error: Object.assign(new Error(`session/not-found: ${sessionId}`), { code: 'session/not-found' }) }),
    prompt: (request: SessionPromptRequest) => {
      state.prompts.push(request)
      return Promise.resolve({ accepted: true })
    },
  }
  return { state, controller }
}

/** Mount the memory storage backend and the domain facility on `ctx`. */
async function mountStorage(ctx: Context, pool: MemoryMediaPool): Promise<void> {
  await ctx.plugin(Timer)
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  ctx.effect(() => async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => { await facility.closeAll(); unmount() }
  })
}

/** Options of one mount. */
export interface HarnessOptions {
  config?: Record<string, unknown>
  pool?: MemoryMediaPool
  credentials?: ReturnType<typeof credentialStore>
  bili?: FakeBili
  sessions?: ReturnType<typeof fakeSessions>
  notes?: LsyNote[]
  /** `false` mounts no recording notifier, so a test can mount the real WeChat channel. */
  notifier?: false
  /** The recording notifier's `tellMainAgent`; omitted, the notifier has none. */
  mainAgent?: (message: LsyAgentMessage) => Promise<string>
  /** Mount the real event bus too, with its defaults. */
  bus?: boolean
  workspace?: string
  /** The profile default model route, read on every call. */
  defaultModel?: { provider: string; model: string }
}

/**
 * Mount the plugin.
 * @param options - shared state for re-mounts and configuration overrides.
 */
export async function harness(options: HarnessOptions = {}) {
  const bili = options.bili ?? new FakeBili()
  vi.stubGlobal('fetch', bili.fetch)
  const ctx = new Context()
  contexts.push(ctx)
  const logs: LogLine[] = []
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (message) => {
      const line = { type: message.type, text: String(message.args[0]) }
      logs.push(line)
      allLogs.push(line)
    },
  })
  const pool = options.pool ?? new MemoryMediaPool()
  await mountStorage(ctx, pool)
  const credentials = options.credentials ?? credentialStore()
  ctx.provide('credentials', credentials.provider as never)
  const sessions = options.sessions ?? fakeSessions()
  ctx.provide('sessionController', sessions.controller as never)
  const presets: { resolve: Mock<() => object>; set: Mock<(session: unknown, preset: string) => void> } = {
    resolve: vi.fn(() => ({})), set: vi.fn(),
  }
  ctx.provide('permissionPresets', presets as never)
  const titles: { rename: Mock<(session: unknown, title: string) => void> } = { rename: vi.fn() }
  ctx.provide('sessionTitle', titles as never)
  const notes = options.notes ?? []
  if (options.notifier !== false) {
    const send = (note: LsyNote): Promise<void> => { notes.push(note); return Promise.resolve() }
    ctx.provide('lsyNotifier', (options.mainAgent === undefined ? { send } : { send, tellMainAgent: options.mainAgent }) as never)
  }
  // The relay carries the account's answers to its DM channel, as the event bundle mounts it.
  await ctx.plugin(OwnerRelay)
  if (options.bus === true) await ctx.plugin(LsyEventBus, BusConfig({} as never))
  if (options.defaultModel !== undefined) {
    const defaultModel = options.defaultModel
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ ...defaultModel }) } as never)
  }
  ctx.provide('sessionProjections', {
    stateOf: (session: { id: string }, key: string) => (key === 'modelSelection' ? { lastUsed: null, pending: sessions.state.picks.get(session.id) ?? null } : undefined),
  } as never)
  const routes: Route[] = []
  ctx.provide('connection', { fetch: { register: (route: Route) => { routes.push(route); return () => Promise.resolve() } } } as never)
  const config = Config({
    ownerMid: 200000001,
    refreshPublicKey: bili.keys.publicKey,
    inboxPollMs: 86_400_000,
    session: { workspacePath: options.workspace ?? '/tmp/bili-test-workspace' },
    ...options.config,
  } as never)
  await ctx.plugin(BiliAccount, config)
  await vi.advanceTimersByTimeAsync(0)
  const account = ctx.bili

  /** Advance fake time until `promise` settles. */
  const run = async <T>(promise: Promise<T>, maxMs = 3_600_000): Promise<T> => {
    let settled = false
    const watched = promise.finally(() => { settled = true })
    watched.catch(() => undefined)
    for (let elapsed = 0; !settled && elapsed < maxMs; elapsed += 500) await vi.advanceTimersByTimeAsync(500)
    if (!settled) throw new Error('promise did not settle')
    return await watched
  }
  const route = (): Route => {
    const found = routes.find(entry => entry.path === '/api/bili')
    if (found === undefined) throw new Error('route not registered')
    return found
  }
  /** GET the Settings view. */
  const view = async (): Promise<BiliView> => await (await route().fetch(new Request('http://127.0.0.1/api/bili'))).json() as BiliView
  /** POST one Settings action (advancing fake time while its requests are spaced); answers the raw response. */
  const post = (body: unknown, contentType = 'application/json'): Promise<Response> => run(route().fetch(new Request('http://127.0.0.1/api/bili', {
    method: 'POST', headers: { 'content-type': contentType }, body: typeof body === 'string' ? body : JSON.stringify(body),
  })))
  /** Sign in through the Settings QR login. */
  const signIn = async (): Promise<void> => {
    await post({ action: 'login' })
    for (let step = 0; step < 120 && (await view()).account.state !== 'active'; step += 1) await vi.advanceTimersByTimeAsync(1000)
    if ((await view()).account.state !== 'active') throw new Error('sign-in did not complete')
  }
  const emit = (sessionId: string, event: unknown): void => { (ctx.emit as (...args: unknown[]) => void)('session/event', { id: sessionId }, event) }
  return {
    ctx, account, bili, notes, logs, routes, sessions: sessions.state, credentials, presets, titles, pool, run, view, post, signIn, emit,
  }
}
