/**
 * Real Loader composition of the QQ channel: a test-only cordis.yml mounts the shipped `fork-qq`, `fork-tool-qq`, and
 * `fork-qq-login` through their exports; the qq-recorder is the real recorder and the real server, started in this test, and
 * only NapCat is replaced by the fake protocol end. What a restart, a reload, or a stop of DSH does to the one OneBot
 * connection is the point of every case.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import * as ToolQq from '../../fork-tool-qq/src/index.ts'
import * as QqLogin from '../../fork-qq-login/src/index.ts'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as qqModule from '../src/index.ts'
import { FEATURE_MINOR } from '../src/protocol.ts'
import { startRecorderServer, type RecorderServer } from '../src/server.ts'
import Storage from '@deepseek-ai/dsh-storage'
import { mountFacility } from './digest-harness.ts'
import { groupMessage } from './fake-onebot.ts'
import { bootRecorder, shutdown, sleep, until, type Booted } from './recorder-harness.ts'

const GROUP = '123456789'
const NEW_GROUP = '987654321'
const RECORDER_TOKEN = 'recorder-token-0123456789abcdef'
const ONEBOT = 'onebot-token-0123456789abcdef'

interface Rig extends Booted { server: RecorderServer; socketPath: string }
type Route = (request: Request) => Promise<Response>
interface App {
  root: string
  logs: string[]
  context: Context
  routes: Map<string, Route>
  claims: Set<string>
  call(name: string, args: unknown, options?: { cwd: string }): Promise<string>
  entry(name: string): { id: string }
}

const rigs: Rig[] = []
const apps: App[] = []
const originalMinor = { ...FEATURE_MINOR }

afterEach(async () => {
  Object.assign(FEATURE_MINOR, originalMinor)
  await Promise.all(apps.splice(0).map(app => app.context.fiber.dispose()))
  await Promise.all(rigs.splice(0).map(rig => rig.server.close()))
  expect(await shutdown()).toEqual([])
})

/** The real recorder and its real server, with NapCat faked. The recorder waits for DSH to push its settings. */
async function startRig(options: { protocolMinor?: number; protocolMajor?: number; fetch?: typeof fetch } = {}): Promise<Rig> {
  const h = await bootRecorder({ config: false, ...options.fetch === undefined ? {} : { fetch: options.fetch } })
  h.fake.handlers.set('get_group_list', () => [
    { group_id: Number(GROUP), group_name: '技术群', member_count: 80 },
    { group_id: Number(NEW_GROUP), group_name: '闲聊群', member_count: 300 },
  ])
  const socketPath = join(h.dir, 'run', 'qq-recorder.sock')
  const server = await startRecorderServer({
    recorder: h.recorder, logger: { debug() {}, info() {}, error: (m) => { h.logs.push({ type: 'error', text: m }) } },
    socketPath, token: RECORDER_TOKEN, healthPort: 0, build: 'composition', ...options.protocolMinor === undefined ? {} : { protocolMinor: options.protocolMinor }, ...options.protocolMajor === undefined ? {} : { protocolMajor: options.protocolMajor },
  })
  const rig = Object.assign(h, { server, socketPath })
  rigs.push(rig)
  return rig
}

/** DSH: the Loader boots the shipped plugins from a test-only cordis.yml. */
async function bootApp(rig: Rig, pool: MemoryMediaPool, extra: string[] = []): Promise<App> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-qq-composition-'))
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const claims = new Set<string>()
  const configPath = join(root, 'cordis.yml')
  writeFileSync(configPath, [
    '- name: fixture-storage',
    '- name: fixture-hosts',
    '- name: fixture-tools',
    '- id: fork-qq',
    "  name: '@deepseek-ai/dsh-fork-qq'",
    '  config:',
    `    url: '${rig.fake.url}'`,
    `    groups: ['${GROUP}']`,
    '    recorder:',
    `      socket: '${rig.socketPath}'`,
    '    login:',
    '      enabled: false',
    '    digest:',
    '      enabled: false',
    `      workspacePath: '${join(root, 'digest')}'`,
    ...extra,
    '- id: fork-tool-qq',
    "  name: '@deepseek-ai/dsh-fork-tool-qq'",
    '- id: fork-qq-login',
    "  name: '@deepseek-ai/dsh-fork-qq-login'",
    '',
  ].join('\n'))
  const hosts = {
    name: 'fixture-hosts',
    inject: ['storage'],
    apply(ctx: Context) {
      mountFacility(ctx, pool)
      ctx.provide('credentials', { resolve: (ref: string) => Promise.resolve(ref === 'FORK_QQ_RECORDER_TOKEN' ? { value: RECORDER_TOKEN } : undefined) } as never)
      ctx.provide('sessionController', {} as never)
      ctx.provide('permissionPresets', {} as never)
      ctx.provide('sessionTitle', {} as never)
      ctx.provide('connection', {
        fetch: { register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => { routes.set(route.path,
          route.fetch); return () => { routes.delete(route.path); return Promise.resolve() } } },
      } as never)
      ctx.provide('forkEventBus', { protectSessions: (label: string) => { claims.add(label); return () => { claims.delete(label) } } } as never)
    },
  }
  const tools = {
    name: 'fixture-tools',
    async apply(ctx: Context) {
      ctx.provide('systemPrompt', { tools: () => () => {} } as never)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(NativeToolExecutor)
    },
  }
  const modules = new Map<string, unknown>([
    ['fixture-storage', Storage], ['fixture-hosts', hosts], ['fixture-tools', tools],
    ['@deepseek-ai/dsh-fork-qq', qqModule], ['@deepseek-ai/dsh-fork-tool-qq', ToolQq], ['@deepseek-ai/dsh-fork-qq-login', QqLogin],
  ])
  const context = new Context()
  const logs: string[] = []
  context.logger.exporter({ levels: { default: 3 }, export: (m) => { logs.push(String(m.args[0])) } })
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  Reflect.set(context.loader, 'internal', {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  })
  // Entries sit at the top level, as the shipped profile's do, so a volatile-only change can skip the remount.
  for (const row of parse(readFileSync(configPath, 'utf8')) as Array<Record<string, unknown>>) await context.loader.create(row as never)
  await context.loader.await()
  await until(() => context.get('forkQq') !== undefined, 'fork-qq to mount', 5000)
  expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  const app: App = {
    root, logs, context, routes, claims,
    entry: name => [...context.loader.entries()].find(entry => entry.options.name === name)!,
    call: async (name, args, options) => {
      const agent = options === undefined ? {} : { agent: { session: { id: 'main', header: { cwd: options.cwd }, requestHeader: () => undefined }, options: {} } as never }
      const batch = await context.tools.execute({ signal: new AbortController().signal, ...agent, calls: [{ type: 'tool-call', id: ToolCallId(`${name}-call`), name, arguments: JSON.stringify(args) }] })
      const result = batch.results[0]!.result as { content?: { type: string; text: string }[] }
      return result.content?.map(part => part.text).join('') ?? ''
    },
  }
  apps.push(app)
  return Object.assign(app, { cleanup: () => { rmSync(root, { recursive: true, force: true }) } })
}

/** A group message that happened just now, so the tools' time windows contain it. */
const live = (group: string, user: string, text: string) => groupMessage(group, user, text, { time: Math.floor(Date.now() / 1000) })

const linked = (app: App) => until(() => app.context.forkQq.connectionStatus().state === 'connected', 'DSH to see the connection')
const panel = async (app: App) => await (await app.routes.get('/api/fork.qq')!(new Request('http://127.0.0.1/api/fork.qq'))).json() as { connection: { state: string }; login: { door: string }; groups: Array<{ groupId: string }> }

describe('QQ channel through the real Loader and the real recorder', () => {
  it('(a) holds exactly one OneBot connection, and DSH reads through the recorder', { timeout: 30_000 }, async () => {
    const rig = await startRig()
    const app = await bootApp(rig, new MemoryMediaPool())
    await linked(app)
    await sleep(400)
    expect(rig.fake.connections).toBe(1)
    expect(rig.fake.authorizations).toEqual([`Bearer ${ONEBOT}`])
    rig.fake.push(live(GROUP, '10001', '部署前先看监控'))
    await until(() => rig.recorder.recent(GROUP, { sinceMs: 0, limit: 5 }).length === 1, 'the recorded message')
    expect(await app.call('qq_recent', { group: GROUP })).toContain('部署前先看监控')
    expect(await app.call('qq_groups', {})).toContain('技术群')
    const shown = await panel(app)
    expect(shown.connection.state).toBe('connected')
    expect(shown.groups.map(group => group.groupId)).toContain(GROUP)
  })

  it('(b) a reload of a non-volatile field leaves one connection, and qq_recent sees messages sent after the reload', { timeout: 30_000 }, async () => {
    const rig = await startRig()
    const app = await bootApp(rig, new MemoryMediaPool())
    await linked(app)
    rig.fake.push(live(GROUP, '10001', '重载之前的消息'))
    await until(() => rig.recorder.recent(GROUP, { sinceMs: 0, limit: 5 }).length === 1, 'the first message')
    const entry = app.entry('@deepseek-ai/dsh-fork-qq')
    await app.context.loader.update(entry.id, { config: { url: rig.fake.url, groups: [GROUP], recorder: { socket: rig.socketPath }, login: { enabled: false }, digest: { enabled: false, everyHours: 12, workspacePath: join(app.root, 'digest') } } })
    await app.context.loader.await()
    expect(app.logs.filter(line => line.startsWith('fork-qq: recording '))).toHaveLength(2)
    await linked(app)
    rig.fake.push(live(GROUP, '10001', '重载之后的消息'))
    await until(() => rig.recorder.recent(GROUP, { sinceMs: 0, limit: 5 }).length === 2, 'the second message')
    const text = await app.call('qq_recent', { group: GROUP })
    expect(text).toContain('重载之前的消息')
    expect(text).toContain('重载之后的消息')
    expect(rig.fake.connections).toBe(1)
    expect(rig.logs.filter(line => line.text.includes('connected to the protocol end'))).toHaveLength(1)
  })

  it('(c) disposing the whole app and booting it again still leaves one connection, and keeps what DSH stored', { timeout: 30_000 }, async () => {
    const rig = await startRig()
    const pool = new MemoryMediaPool()
    const first = await bootApp(rig, pool)
    await linked(first)
    rig.fake.push(live(GROUP, '10001', '重启之前'))
    await until(() => rig.recorder.recent(GROUP, { sinceMs: 0, limit: 5 }).length === 1, 'the message')
    await first.context.fiber.dispose()
    expect(rig.recorder.status().connection.state).toBe('connected')
    const second = await bootApp(rig, pool)
    await linked(second)
    rig.fake.push(live(GROUP, '10001', '重启之后'))
    await until(() => rig.recorder.recent(GROUP, { sinceMs: 0, limit: 5 }).length === 2, 'the message after the restart')
    expect(await second.call('qq_recent', { group: GROUP })).toContain('重启之后')
    await sleep(300)
    expect(rig.fake.connections).toBe(1)
    expect(rig.fake.callsOf('get_login_info')).toHaveLength(1)
  })

  it('(d) changing the groups records the new group without a reconnect', { timeout: 30_000 }, async () => {
    const rig = await startRig()
    const app = await bootApp(rig, new MemoryMediaPool())
    await linked(app)
    rig.fake.push(live(NEW_GROUP, '10002', '加入之前'))
    await until(() => rig.recorder.groups().some(group => group.groupId === NEW_GROUP && group.unlistedSeen === 1), 'the dropped message')
    const entry = app.entry('@deepseek-ai/dsh-fork-qq')
    await app.context.loader.update(entry.id, { config: { url: rig.fake.url, groups: [GROUP, NEW_GROUP], recorder: { socket: rig.socketPath }, login: { enabled: false }, digest: { enabled: false, workspacePath: join(app.root, 'digest') } } })
    await app.context.loader.await()
    await until(() => rig.recorder.status().recordedGroups === 2, 'the recorder to follow the new list')
    rig.fake.push(live(NEW_GROUP, '10002', '加入之后'))
    await until(() => rig.recorder.recent(NEW_GROUP, { sinceMs: 0, limit: 5 }).length === 1, 'the new group\'s message')
    expect(rig.fake.connections).toBe(1)
    expect(rig.logs.some(line => line.text.includes(`now recording group ${NEW_GROUP}`))).toBe(true)
    // A volatile-only change is committed into the running plugin: it was built once, and no connection was involved.
    expect(app.logs.filter(line => line.startsWith('fork-qq: recording '))).toHaveLength(1)
  })

  it('(e) with the recorder stopped, Settings and the tools say recorder-down, and recover when it is back', { timeout: 40_000 }, async () => {
    const rig = await startRig()
    const app = await bootApp(rig, new MemoryMediaPool())
    await linked(app)
    await rig.server.close()
    await until(() => app.context.forkQq.connectionStatus().state === 'recorder-down', 'DSH to notice the recorder is gone')
    const shown = await panel(app)
    expect(shown.connection.state).toBe('recorder-down')
    expect(shown.login.door).toBe('recorder-down')
    expect(await app.call('qq_groups', {})).toContain('QQ recorder is not running')
    expect(await app.call('qq_recent', { group: GROUP })).toContain('QQ recorder is not running')
    // The recorder itself is not stopped by this: the connection to QQ is still the same one.
    expect(rig.fake.connections).toBe(1)
    const again = await startRecorderServer({ recorder: rig.recorder, logger: { debug() {}, info() {}, error() {} },
      socketPath: rig.socketPath, token: RECORDER_TOKEN })
    rig.server = again
    await until(() => app.context.forkQq.connectionStatus().state === 'connected', 'DSH to find the recorder again', 20_000)
    expect(await app.call('qq_groups', {})).toContain('技术群')
  })

  it('(f) a recorder of an older minor version degrades only the capability that needs a newer one', { timeout: 30_000 }, async () => {
    FEATURE_MINOR['members'] = 1
    const rig = await startRig({ protocolMinor: 0 })
    const app = await bootApp(rig, new MemoryMediaPool())
    await linked(app)
    expect(app.context.forkQq.features()).toMatchObject({ events: true, members: false, legacyState: true, media: false })
    expect(app.context.forkQq.connectionStatus().state).toBe('connected')
    rig.fake.push(live(GROUP, '10001', '旧版记录器照常读'))
    await until(() => rig.recorder.recent(GROUP, { sinceMs: 0, limit: 5 }).length === 1, 'the message')
    expect(await app.call('qq_recent', { group: GROUP })).toContain('旧版记录器照常读')
  })

  it('(f2) a recorder of another major version is shown as protocol-mismatch in Settings and the tools, never a crash', { timeout: 30_000 }, async () => {
    const rig = await startRig({ protocolMajor: 2 })
    const app = await bootApp(rig, new MemoryMediaPool())
    await until(() => app.context.forkQq.connectionStatus().state === 'protocol-mismatch', 'DSH to see the mismatch')
    expect((await panel(app)).connection.state).toBe('protocol-mismatch')
    expect(await app.call('qq_groups', {})).toContain('another protocol version')
    // The pushed settings were never sent: a recorder that speaks another protocol is left alone.
    expect(rig.recorder.status().configRevision).toBeNull()
    expect(rig.fake.connections).toBe(0)
  })

  it('(h) qq_image fetches a saved picture through the recorder into the workspace; images off, and an older recorder, say so', { timeout: 40_000 }, async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('composition-pixels')])
    const rig = await startRig({ fetch: vi.fn(async () => new Response(png)) })
    const app = await bootApp(rig, new MemoryMediaPool())
    await linked(app)
    const workspace = mkdtempSync(join(tmpdir(), 'qq-image-ws-'))
    try {
      rig.fake.push(groupMessage(GROUP, '10001', [{ type: 'text', data: { text: '看这个' } }, { type: 'image', data: { url: 'https://gchat.qpic.cn/a.png', file: 'a.png' } }], { time: Math.floor(Date.now() / 1000) }))
      await until(() => rig.recorder.store.mediaOf(1).some(m => m.localPath !== null), 'the picture')
      const recent = await app.call('qq_recent', { group: GROUP })
      const ref = /\[图片#(m[0-9a-z]+)\]/.exec(recent)?.[1]
      expect(ref, recent).toBeDefined()
      const saved = await app.call('qq_image', { ref }, { cwd: workspace })
      const path = join(workspace, '.qq-media', `${ref!}.png`)
      expect(saved).toContain(path)
      expect(readFileSync(path)).toEqual(png)
      expect(statSync(path).mode & 0o777).toBe(0o600)
      // The owner switches images off: the recorder no longer hands the file out.
      const entry = app.entry('@deepseek-ai/dsh-fork-qq')
      await app.context.loader.update(entry.id, { config: { url: rig.fake.url, groups: [GROUP], media: { images: false }, recorder: { socket: rig.socketPath }, login: { enabled: false }, digest: { enabled: false, workspacePath: join(app.root, 'digest') } } })
      await app.context.loader.await()
      await until(() => rig.recorder.status().configRevision !== null && rig.logs.some(line => line.text.includes('config applied') && line.text.length > 0), 'the new settings')
      await sleep(300)
      expect(await app.call('qq_image', { ref }, { cwd: workspace })).toContain('media.images is off')
      expect(existsSync(join(workspace, '.qq-media', 'nope.png'))).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
    // A recorder from before pictures: the tool says to deploy the matching one, and nothing is requested.
    const old = await startRig({ protocolMinor: 0 })
    const oldApp = await bootApp(old, new MemoryMediaPool())
    await linked(oldApp)
    expect(oldApp.context.forkQq.features()).toMatchObject({ media: false, events: true })
    expect(await oldApp.call('qq_image', { ref: 'm1' }, { cwd: tmpdir() })).toContain('too old to serve pictures')
  })

  it('(g) disposing removes the routes, the event stream, and the archive claim', { timeout: 30_000 }, async () => {
    const rig = await startRig()
    const app = await bootApp(rig, new MemoryMediaPool())
    await linked(app)
    expect([...app.routes.keys()].sort()).toEqual(['/api/fork.qq', '/api/fork.qq.refresh'])
    expect(rig.server.streamCount()).toBe(1)
    expect([...app.claims]).toEqual(['qq'])
    const names = app.context.tools.definitions().map(tool => tool.name).filter(name => name.startsWith('qq_'))
    expect(names).toContain('qq_recent')
    await app.context.fiber.dispose()
    expect(app.routes.size).toBe(0)
    expect(app.claims.size).toBe(0)
    await until(() => rig.server.streamCount() === 0, 'the event stream to close')
    expect(rig.fake.connections).toBe(1)
  })
})
