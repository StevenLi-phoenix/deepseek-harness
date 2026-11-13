import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { equalExceptVolatile } from '../../../../vendor/loader/src/config/diff.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config, ImageNotSaved, isPrivateAddress, QqObserver, SendRefused, type DigestRow } from '../src/index.ts'
import { RecorderClient, RecorderError, RecorderUnavailable } from '../src/client.ts'
import type { Group, Login, Message } from '../src/protocol.ts'
import { QqStore } from '../src/store.ts'
import { startRecorderServer, type RecorderServer } from '../src/server.ts'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { mountMemoryStorage } from './digest-harness.ts'
import { groupMessage } from './fake-onebot.ts'
import { bootRecorder, shutdown, sleep, until, type Booted } from './recorder-harness.ts'

const GROUP = '123456789'
const OTHER = '987654321'
const RECORDER_TOKEN = 'recorder-token-0123456789abcdef'
const HOUR = 3_600_000

interface Rig extends Booted { server: RecorderServer; socketPath: string; url: string }
const contexts: Context[] = []
const servers: RecorderServer[] = []
const tmp: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map(server => server.close()))
  for (const dir of tmp.splice(0)) rmSync(dir, { recursive: true, force: true })
  expect(await shutdown()).toEqual([])
})

async function rig(options: { prepare?: (dataDir: string) => void; online?: boolean } = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'qq-observer-rig-'))
  tmp.push(dir)
  options.prepare?.(join(dir, 'data'))
  const h = await bootRecorder({ dir, config: false })
  const socketPath = join(dir, 'run', 'qq-recorder.sock')
  const server = await startRecorderServer({ recorder: h.recorder, logger: { debug() {}, info() {}, error() {} }, socketPath,
    token: RECORDER_TOKEN })
  servers.push(server)
  return Object.assign(h, { server, socketPath, url: h.fake.url })
}

/** DSH's observer over `r`, with in-memory storage that may be shared between boots. */
async function boot(r: Rig,
  options: {
    config?: Record<string, unknown>
    pool?: MemoryMediaPool
    notifier?: { send: ReturnType<typeof vi.fn> }
    url?: string
    sessions?: (ctx: Context) => object
    bus?: object
  } = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const logs: Array<{ type: string; text: string }> = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (m) => { logs.push({ type: m.type, text: String(m.args[0]) }) } })
  await mountMemoryStorage(ctx, options.pool ?? new MemoryMediaPool())
  ctx.provide('credentials', { resolve: (ref: string) => Promise.resolve(ref === 'QQ_RECORDER_TOKEN' ? { value: RECORDER_TOKEN } : undefined) } as never)
  ctx.provide('sessionController', (options.sessions?.(ctx) ?? {}) as never)
  ctx.provide('permissionPresets', { resolve: vi.fn(), set: vi.fn() } as never)
  ctx.provide('sessionTitle', { rename: vi.fn() } as never)
  if (options.notifier !== undefined) ctx.provide('ownerNotifier', options.notifier as never)
  if (options.bus !== undefined) ctx.provide('eventBus', options.bus as never)
  await ctx.plugin(QqObserver, {
    url: r.fake.url, groups: [GROUP], recorder: { socket: r.socketPath }, login: { enabled: false },
    digest: { enabled: false, workspacePath: join(tmpdir(), 'qq-observer-ws') }, ...options.config,
  })
  const observer = ctx.qq
  await until(() => observer.connectionStatus().state === 'connected', 'the recorder and QQ')
  return { ctx, observer, logs }
}

describe('QqObserver reading through the recorder', () => {
  it('lists every group with the recorded ones first and the digest time merged in, and names them', async () => {
    const r = await rig()
    const h = await boot(r)
    r.fake.push(groupMessage(GROUP, '10001', 'hello', { time: Math.floor(Date.now() / 1000) }))
    await until(() => r.recorder.recent(GROUP, { sinceMs: 0, limit: 5 }).length === 1, 'the row')
    const overview = await h.observer.groupOverview()
    expect(overview.map(group => [group.groupId, group.name, group.recorded, group.messages, group.lastDigestAt])).toEqual([
      [GROUP, '技术群', true, 1, null],
      [OTHER, '闲聊群', false, 0, null],
    ])
    expect(h.observer.groupName(GROUP)).toBe('技术群')
    expect(h.observer.groupName('555555')).toBe('555555')
    expect(await h.observer.groupChoices()).toEqual([
      { groupId: GROUP, name: '技术群', memberCount: 80, recorded: true, seen: 0 },
      { groupId: OTHER, name: '闲聊群', memberCount: 300, recorded: false, seen: 0 },
    ])
  })

  it('serves reads only for recorded groups', async () => {
    const r = await rig()
    const h = await boot(r)
    r.fake.push(groupMessage(GROUP, '10001', '关于数据库迁移的讨论', { time: Math.floor(Date.now() / 1000) }))
    await until(() => r.recorder.recent(GROUP, { sinceMs: 0, limit: 5 }).length === 1, 'the row')
    expect(await h.observer.searchMessages('数据库迁移', { limit: 5 })).toHaveLength(1)
    expect(await h.observer.searchMessages('数据库迁移', { groupId: OTHER, limit: 5 })).toEqual([])
    expect(await h.observer.recentMessages(OTHER, { hours: 99999, limit: 5 })).toEqual([])
    expect(h.observer.digests({ groupId: OTHER, days: 30, limit: 5 })).toEqual([])
    expect(h.observer.isRecorded(GROUP)).toBe(true)
    expect(h.observer.isRecorded(OTHER)).toBe(false)
  })

  it('follows the group list the Settings page changes, ignoring entries that are not group numbers, and says so once', async () => {
    const r = await rig()
    const h = await boot(r)
    type Ref = Parameters<typeof import('@deepseek-ai/cosmokit').updateVolatile>[0]
    const { createVolatile, updateVolatile } = await import('@deepseek-ai/cosmokit')
    const move = (groups: string[]) => {
      updateVolatile((Reflect.get(h.observer, 'config') as { groups: Ref }).groups, createVolatile(groups))
      h.ctx.emit('loader/volatile-update' as never)
    }
    move([GROUP, OTHER, 'abc', '12', '9'.repeat(21), ' 123456 '])
    expect(h.observer.recordedGroups()).toBe(2)
    expect(h.observer.isRecorded('abc')).toBe(false)
    await until(() => r.recorder.status().recordedGroups === 2, 'the recorder to follow')
    move([GROUP, OTHER, 'abc', '12', '9'.repeat(21), ' 123456 '])
    const warned = h.logs.filter(line => line.text.includes('ignoring') && line.text.includes('not a group number'))
    expect(warned).toHaveLength(1)
    expect(warned[0]!.text).toContain('abc')
    expect(r.fake.connections).toBe(1)
  })

  describe('evidenceOf', () => {
    const post = async (r: Rig, group: string, user: string, id: number) => {
      r.fake.push(groupMessage(group, user, `消息${id}`, { message_id: id, time: Math.floor(Date.now() / 1000) }))
      await until(() => r.recorder.store.byMessageId(group, String(id)) !== undefined, `message ${id}`)
    }

    it('answers with a stable sender key and the time, never the QQ number, only for messages the group holds', async () => {
      const r = await rig()
      const h = await boot(r, { config: { groups: [GROUP, OTHER] } })
      await until(() => r.recorder.status().recordedGroups === 2, 'both groups')
      await post(r, GROUP, '10001', 7001)
      await post(r, GROUP, '10002', 7002)
      await post(r, GROUP, '10001', 7003)
      await post(r, OTHER, '10001', 7004)
      const found = await h.observer.evidenceOf(GROUP, ['7001', '7002', '7003', '7004', '9999'])
      expect(found.map(entry => entry.messageId)).toEqual(['7001', '7002', '7003'])
      expect(found[0]!.senderKey).toBe(found[2]!.senderKey)
      expect(found[0]!.senderKey).not.toBe(found[1]!.senderKey)
      expect(found[0]!.senderKey).toMatch(/^[0-9a-f]{16}$/)
      expect(JSON.stringify(found)).not.toContain('10001')
      expect(found.map(entry => entry.text)).toEqual(['消息7001', '消息7002', '消息7003'])
      expect((await h.observer.evidenceOf(OTHER, ['7004']))[0]!.senderKey).not.toBe(found[0]!.senderKey)
    })

    it('answers nothing for an unrecorded group, a recalled message, or a message past retention', async () => {
      const r = await rig()
      const h = await boot(r)
      await post(r, GROUP, '10001', 7101)
      expect(await h.observer.evidenceOf(OTHER, ['7101'])).toEqual([])
      r.recorder.store.recall(GROUP, '7101')
      expect(await h.observer.evidenceOf(GROUP, ['7101'])).toEqual([])
      await post(r, GROUP, '10001', 7102)
      expect(await h.observer.evidenceOf(GROUP, ['7102'])).toHaveLength(1)
      h.observer.now = () => Date.now() + 31 * 86_400_000
      expect(await h.observer.evidenceOf(GROUP, ['7102'])).toEqual([])
    })
  })

  it('never sends: every send is refused, and nothing reaches the protocol end', async () => {
    const r = await rig()
    const h = await boot(r)
    await expect(h.observer.sendGroupMessage(GROUP, 'hi')).rejects.toBeInstanceOf(SendRefused)
    expect(r.fake.callsOf('send_group_msg')).toEqual([])
  })

  it('deletes digests by group or date through the tool\'s method, and the Settings route of the unfinished ones stays empty', async () => {
    const r = await rig()
    const h = await boot(r)
    await expect(h.observer.forgetDigests({})).rejects.toThrow('needs a group or a date')
    expect(await h.observer.forgetDigests({ groupId: GROUP })).toBe(0)
    const none: DigestRow[] = h.observer.digests({ days: 30, limit: 5 })
    expect(none).toEqual([])
  })
})

describe('QqObserver takes over the old digest state', () => {
  it('imports it once when the recorder first answers, and keeps the alias salt so old aliases stay', async () => {
    const r = await rig({
      prepare: (dataDir) => {
        mkdirSync(dataDir, { recursive: true })
        new QqStore(join(dataDir, 'qq.db')).close()
        const db = new DatabaseSync(join(dataDir, 'qq.db'))
        db.exec(`INSERT INTO digests (group_id, from_row, to_row, message_count, text, model, created_at) VALUES ('${GROUP}', 1, 9, 9, '旧摘要', 'm', ${Date.now() - 1000});
          INSERT INTO meta (key, value) VALUES ('alias-salt', 'old-salt');`)
        db.close()
        writeFileSync(join(dataDir, 'outage-notice.json'), JSON.stringify({ lastNoticeAt: Date.now() }))
      },
    })
    const pool = new MemoryMediaPool()
    const h = await boot(r, { pool })
    await until(() => h.logs.some(line => line.text.includes('took over 1 digest(s)')), 'the import')
    expect(h.observer.digests({ groupId: GROUP, days: 30, limit: 5 }).map(d => d.text)).toEqual(['旧摘要'])
    await h.ctx.fiber.dispose()
    const again = await boot(r, { pool })
    await sleep(300)
    expect(again.logs.filter(line => line.text.includes('took over'))).toEqual([])
    expect(again.observer.digests({ groupId: GROUP, days: 30, limit: 5 })).toHaveLength(1)
  })
})

describe('QqObserver owner notices', () => {
  const check = (h: { observer: QqObserver }) => h.observer['checkOutage'](false)

  async function down() {
    const notifier = { send: vi.fn(async () => {}) }
    const r = await rig()
    const h = await bootDown(r, { notifier, config: { settingsUrl: 'https://dsh.example.test/' } })
    return { r, h, notifier }
  }

  /** Boot against a recorder whose protocol end never answers (its address is closed). */
  async function bootDown(r: Rig,
    options: { notifier?: { send: ReturnType<typeof vi.fn> }; pool?: MemoryMediaPool; config?: Record<string, unknown> }) {
    const url = r.url
    await r.fake.close().catch(() => {})
    const ctx = new Context()
    contexts.push(ctx)
    const logs: Array<{ type: string; text: string }> = []
    ctx.logger.exporter({ levels: { default: 3 }, export: (m) => { logs.push({ type: m.type, text: String(m.args[0]) }) } })
    await mountMemoryStorage(ctx, options.pool ?? new MemoryMediaPool())
    ctx.provide('credentials', { resolve: (ref: string) => Promise.resolve(ref === 'QQ_RECORDER_TOKEN' ? { value: RECORDER_TOKEN } : undefined) } as never)
    ctx.provide('sessionController', {} as never)
    ctx.provide('permissionPresets', {} as never)
    ctx.provide('sessionTitle', {} as never)
    if (options.notifier !== undefined) ctx.provide('ownerNotifier', options.notifier as never)
    await ctx.plugin(QqObserver, { url, groups: [GROUP], recorder: { socket: r.socketPath }, login: { enabled: false }, digest: { enabled: false, workspacePath: join(tmpdir(), 'ws') }, ...options.config })
    const observer = ctx.qq
    await until(() => observer.connectionStatus().state === 'reconnecting', 'the failing connection')
    await until(() => r.recorder.status().outage.disconnectedSince !== null, 'the outage clock')
    return { ctx, observer, logs }
  }

  it('sends one notice per outage however long it lasts, pointing at the Settings page', async () => {
    const { h, notifier } = await down()
    h.observer.now = () => Date.now() + HOUR
    await check(h); await check(h); await check(h)
    expect(notifier.send).toHaveBeenCalledTimes(1)
    const sent = JSON.stringify(notifier.send.mock.calls[0])
    expect(sent).toContain('QQ 协议端连不上')
    expect(sent).toContain('设置')
    expect(sent).toContain('https://dsh.example.test/')
    expect(h.logs.filter(line => line.text.includes('told the owner'))).toHaveLength(1)
  })

  it('stays quiet within the offline threshold, and when the threshold is 0', async () => {
    const quick = await down()
    await check(quick.h)
    expect(quick.notifier.send).not.toHaveBeenCalled()
    const r = await rig()
    const notifier = { send: vi.fn(async () => {}) }
    const off = await bootDown(r, { notifier, config: { offlineNoticeMs: 0 } })
    off.observer.now = () => Date.now() + HOUR
    await check(off)
    expect(notifier.send).not.toHaveBeenCalled()
  })

  it('remembers in its storage that the owner was told, so a reload or deploy mid-outage does not tell again', async () => {
    const pool = new MemoryMediaPool()
    const notifier = { send: vi.fn(async () => {}) }
    const r = await rig()
    const first = await bootDown(r, { notifier, pool })
    first.observer.now = () => Date.now() + HOUR
    await check(first)
    expect(notifier.send).toHaveBeenCalledTimes(1)
    await first.ctx.fiber.dispose()
    const second = await bootDown(r, { notifier, pool })
    second.observer.now = () => Date.now() + HOUR
    await check(second)
    expect(notifier.send).toHaveBeenCalledTimes(1)
  })

  it('reminds again once the outage has outlived the repeat window, and never when the window is 0', async () => {
    const notifier = { send: vi.fn(async () => {}) }
    const r = await rig()
    const h = await bootDown(r, { notifier })
    h.observer.now = () => Date.now() + HOUR
    await check(h)
    h.observer.now = () => Date.now() + 25 * HOUR
    await check(h)
    expect(notifier.send).toHaveBeenCalledTimes(2)
    const never = { send: vi.fn(async () => {}) }
    const r2 = await rig()
    const h2 = await bootDown(r2, { notifier: never, config: { offlineRepeatMs: 0 } })
    h2.observer.now = () => Date.now() + HOUR
    await check(h2)
    h2.observer.now = () => Date.now() + 48 * HOUR
    await check(h2)
    expect(never.send).toHaveBeenCalledTimes(1)
  })

  it('tells the owner when the account goes offline, once', async () => {
    const notifier = { send: vi.fn(async () => {}) }
    const r = await rig()
    const h = await boot(r, { notifier })
    r.fake.push({ post_type: 'notice', notice_type: 'bot_offline', user_id: 99999, tag: 'KickedOffLine' })
    await until(() => notifier.send.mock.calls.length === 1, 'the notice')
    expect(JSON.stringify(notifier.send.mock.calls[0])).toContain('QQ 号掉线了')
    await check(h)
    expect(notifier.send).toHaveBeenCalledTimes(1)
  })

  it('does not call a stopped recorder a QQ outage: the alert chain tells the owner of that, not this notice', async () => {
    const notifier = { send: vi.fn(async () => {}) }
    const r = await rig()
    const h = await boot(r, { notifier })
    await r.server.close()
    await until(() => h.observer.connectionStatus().state === 'recorder-down', 'recorder-down')
    h.observer.now = () => Date.now() + 48 * HOUR
    await check(h)
    expect(notifier.send).not.toHaveBeenCalled()
  })
})

describe('QqObserver owner notice failures', () => {
  const check = (h: { observer: QqObserver }) => h.observer['checkOutage'](false)
  const outage = async (options: { notifier?: { send: ReturnType<typeof vi.fn> }; pool?: MemoryMediaPool }) => {
    const r = await rig()
    const url = r.url
    await r.fake.close().catch(() => {})
    const ctx = new Context()
    contexts.push(ctx)
    const logs: Array<{ type: string; text: string }> = []
    ctx.logger.exporter({ levels: { default: 3 }, export: (m) => { logs.push({ type: m.type, text: String(m.args[0]) }) } })
    await mountMemoryStorage(ctx, options.pool ?? new MemoryMediaPool())
    ctx.provide('credentials', { resolve: (ref: string) => Promise.resolve(ref === 'QQ_RECORDER_TOKEN' ? { value: RECORDER_TOKEN } : undefined) } as never)
    ctx.provide('sessionController', {} as never)
    ctx.provide('permissionPresets', {} as never)
    ctx.provide('sessionTitle', {} as never)
    if (options.notifier !== undefined) ctx.provide('ownerNotifier', options.notifier as never)
    await ctx.plugin(QqObserver, { url, groups: [GROUP], recorder: { socket: r.socketPath }, login: { enabled: false }, digest: { enabled: false, workspacePath: join(tmpdir(), 'ws') } })
    await until(() => ctx.qq.connectionStatus().state === 'reconnecting', 'the failing connection')
    await until(() => r.recorder.status().outage.disconnectedSince !== null, 'the outage clock')
    ctx.qq.now = () => Date.now() + HOUR
    return { ctx, observer: ctx.qq, logs }
  }

  it('still tells the owner when the notice cannot be written down', async () => {
    const pool = new MemoryMediaPool()
    const notifier = { send: vi.fn(async () => {}) }
    const h = await outage({ notifier, pool })
    pool.failNextWrites = 1
    await check(h)
    expect(h.logs.some(line => line.type === 'warn' && line.text === 'qq: could not remember the owner notice: injected write failure')).toBe(true)
    expect(notifier.send).toHaveBeenCalledTimes(1)
  })

  it('records the outage as noticed even when no notifier is mounted', async () => {
    const h = await outage({})
    await check(h)
    expect(h.logs.some(line => line.text.includes('told the owner'))).toBe(false)
    expect(h.observer['store']!.getMeta('outage-notice-at')).toBeDefined()
  })

  it('logs a notifier that fails, and does not try again for the same outage', async () => {
    const notifier = { send: vi.fn(async () => { throw new Error('push down') }) }
    const h = await outage({ notifier })
    await check(h)
    await check(h)
    expect(h.logs.some(line => line.type === 'warn' && line.text === 'qq: could not tell the owner: push down')).toBe(true)
    expect(notifier.send).toHaveBeenCalledTimes(1)
  })
})

describe('QqObserver digest rounds', () => {
  const sessionsAnswering = (text: string) => (ctx: Context) => {
    let count = 0
    const emit = (session: object, event: object): void => { (ctx.emit as (...args: unknown[]) => void)('session/event', session, event) }
    return {
      create: async () => { count += 1; return { sessionId: `digest-${count}` } },
      resolveAgent: async (id: string) => ({ agent: { session: { id } } }),
      selectModel: async () => ({}),
      prompt: async (request: { sessionId: string }) => {
        queueMicrotask(() => {
          emit({ id: request.sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
          emit({ id: request.sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
        })
        return { accepted: true }
      },
    }
  }
  const digestConfig = (dir: string) => ({ digest: { enabled: true, minMessages: 1, everyHours: 1, workspacePath: join(dir, 'ws'), timeoutMs: 10_000 } })
  const wake = async (h: { observer: QqObserver }) => {
    await until(() => h.observer['wake'] !== undefined, 'the schedule to wait')
    h.observer['wake']!()
  }
  const say = async (r: Rig, id: number) => {
    r.fake.push(groupMessage(GROUP, '10001', `第${id}条`, { message_id: id, time: Math.floor(Date.now() / 1000) }))
    await until(() => r.recorder.store.byMessageId(GROUP, String(id)) !== undefined, `message ${id}`)
  }

  it('runs a round when it is due, tells the event bus of the digest, and keeps the resident Session for the next round', async () => {
    const r = await rig()
    const dir = mkdtempSync(join(tmpdir(), 'qq-observer-digest-'))
    tmp.push(dir)
    const publish = vi.fn(async () => {})
    const bus = { protectSessions: () => () => {}, publish }
    const h = await boot(r, { config: digestConfig(dir), sessions: sessionsAnswering('## 话题\n聊了部署'), bus })
    await until(() => h.observer['store']?.imported === true, 'the old state to be taken over')
    await say(r, 8001)
    await wake(h)
    await until(() => h.logs.some(line => line.text === 'qq: digest round stored 1 digest(s)'), 'the first round')
    expect(h.observer.digests({ groupId: GROUP, days: 1, limit: 5 }).map(row => row.text)).toEqual(['## 话题\n聊了部署'])
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ source: 'qq', kind: 'qq.digest.new', subject: GROUP, text: '## 话题\n聊了部署' }))
    await say(r, 8002)
    h.observer.now = () => Date.now() + 25 * HOUR
    await until(() => h.observer['wake'] !== undefined, 'the schedule to wait')
    await wake(h)
    await until(() => h.logs.filter(line => line.text === 'qq: digest round stored 1 digest(s)').length === 2, 'the second round')
    expect(publish).toHaveBeenCalledTimes(2)
    // Nothing new since: the next round stores nothing and says nothing.
    const round = vi.spyOn(h.observer['digest']!, 'runRound')
    await until(() => h.observer['wake'] !== undefined, 'the schedule to wait')
    await wake(h)
    await until(() => round.mock.calls.length === 1, 'the third round')
    expect(await round.mock.results[0]!.value).toBe(0)
    await until(() => h.observer['wake'] !== undefined, 'the schedule to wait again')
    expect(h.logs.filter(line => line.text === 'qq: digest round stored 1 digest(s)')).toHaveLength(2)
  })

  it('skips a round while the recorder is down', async () => {
    const r = await rig()
    const dir = mkdtempSync(join(tmpdir(), 'qq-observer-digest-'))
    tmp.push(dir)
    const h = await boot(r, { config: digestConfig(dir), sessions: sessionsAnswering('x') })
    await until(() => h.observer['store']?.imported === true, 'the old state to be taken over')
    await r.server.close()
    await until(() => h.observer.connectionStatus().state === 'recorder-down', 'recorder-down')
    await wake(h)
    await until(() => h.logs.some(line => line.text.startsWith('qq: digest round skipped: the recorder is ')), 'the skipped round')
  })

  it('waits with its rounds until the old digest state is taken over, and says why only once', async () => {
    vi.spyOn(RecorderClient.prototype, 'legacyState').mockRejectedValue(new Error('legacy boom'))
    const r = await rig()
    const dir = mkdtempSync(join(tmpdir(), 'qq-observer-digest-'))
    tmp.push(dir)
    const h = await boot(r, { config: digestConfig(dir), sessions: sessionsAnswering('x') })
    await until(() => h.logs.some(line => line.text.includes('could not take over the old digest state yet: legacy boom')), 'the first failure')
    await wake(h)
    await until(() => h.logs.some(line => line.text === 'qq: digest round skipped: the old digest state is not taken over yet'), 'the skipped round')
    expect(h.logs.filter(line => line.text.includes('could not take over'))).toHaveLength(1)
    expect(h.observer['store']!.imported).toBe(false)
  })

  it('logs scheduled work that fails, whatever it threw', async () => {
    const r = await rig()
    const h = await boot(r)
    vi.spyOn(h.observer['client'], 'status').mockImplementation(() => { throw 'status exploded' })
    await wake(h)
    await until(() => h.logs.some(line => line.text === 'qq: scheduled work failed: status exploded'), 'the failure to be logged')
  })

  it('checks the outage clock every minute while it runs', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const h = await bare()
      await vi.waitFor(() => { expect(h.observer['store']).toBeDefined() })
      const check = vi.fn(async (_botOffline: boolean) => {})
      h.observer['checkOutage'] = check
      vi.advanceTimersByTime(60_000)
      expect(check).toHaveBeenCalledWith(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('logs background work that fails', async () => {
    const h = await bare()
    h.observer['track'](Promise.reject(new Error('detached failure')))
    await until(() => h.logs.some(line => line.text === 'qq: background work failed: detached failure'), 'the failure to be logged')
  })

  it('keeps the wake-up of the pause that is waiting now when an earlier one ends', async () => {
    const h = await bare()
    const first = h.observer['pause'](5)
    const second = h.observer['pause'](60_000)
    await first
    // The first pause ended on its timer; the wake-up still belongs to the second.
    expect(h.observer['wake']).toBeDefined()
    h.observer['wake']!()
    await second
  })
})

describe('QqObserver link to the recorder', () => {
  it('logs the settings the recorder refused, and a listener of the link that threw', async () => {
    const r = await rig()
    const h = await boot(r)
    const { createVolatile, updateVolatile } = await import('@deepseek-ai/cosmokit')
    type Ref = Parameters<typeof updateVolatile>[0]
    updateVolatile((Reflect.get(h.observer, 'config') as { media: { maxImageBytes: Ref } }).media.maxImageBytes, createVolatile(-1))
    h.ctx.emit('loader/volatile-update' as never)
    await until(() => h.logs.some(line => line.type === 'warn' && line.text.startsWith('qq: could not push the configuration to the recorder: ')),
      'the refusal to be logged')
    h.observer['checkOutage'] = () => { throw new Error('checkOutage crashed') }
    await r.server.close()
    await until(() => h.logs.some(line => line.text === 'qq: a recorder listener threw: checkOutage crashed'), 'the listener failure to be logged')
  })
})

describe('QqObserver taking over the old digest state', () => {
  const legacy = { digests: [], notes: [], groupSessions: [], aliasSalt: null, outageNoticeAt: null }

  it('does nothing against a recorder that cannot hand the state over', async () => {
    const h = await bare()
    await vi.waitFor(() => { expect(h.observer['store']).toBeDefined() })
    const read = vi.spyOn(h.observer['client'], 'legacyState')
    await h.observer['importLegacy']()
    expect(read).not.toHaveBeenCalled()
  })

  it('shares the import in flight, and leaves the notice clock alone when the state carried none', async () => {
    const h = await bare()
    await vi.waitFor(() => { expect(h.observer['store']).toBeDefined() })
    vi.spyOn(h.observer['client'], 'supports').mockReturnValue(true)
    let release!: () => void
    const read = vi.spyOn(h.observer['client'], 'legacyState').mockImplementation(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return legacy
    })
    const first = h.observer['importLegacy']()
    const second = h.observer['importLegacy']()
    expect(second).toBe(first)
    await vi.waitFor(() => { expect(release).toBeDefined() })
    release()
    await first
    expect(read).toHaveBeenCalledTimes(1)
    expect(h.observer['store']!.imported).toBe(true)
    expect(h.observer['lastNoticeAt']).toBeUndefined()
    expect(h.logs.some(line => line.text.includes('took over 0 digest(s)'))).toBe(true)
  })

  it('stays quiet when the store says it had nothing to import after all', async () => {
    const h = await bare()
    await vi.waitFor(() => { expect(h.observer['store']).toBeDefined() })
    vi.spyOn(h.observer['client'], 'supports').mockReturnValue(true)
    vi.spyOn(h.observer['client'], 'legacyState').mockResolvedValue(legacy)
    vi.spyOn(h.observer['store']!, 'importLegacy').mockResolvedValue({ imported: false, digests: 0, notes: 0, sessions: 0 })
    await h.observer['importLegacy']()
    expect(h.logs.some(line => line.text.includes('took over'))).toBe(false)
  })
})

describe('QqObserver start-up', () => {
  it('warns about the retired dataDir, and says an empty group list drops every message', async () => {
    const h = await bare({ config: { dataDir: '/var/old', groups: [] } })
    expect(h.logs.some(line => line.type === 'warn' && line.text.startsWith('qq: dataDir is ignored'))).toBe(true)
    expect(h.logs.some(line => line.text.includes('recording 0 group(s)') && line.text.includes('the list is empty: every message is dropped'))).toBe(true)
  })

  it('says digests are on, and starts the configured digest model without error', async () => {
    const h = await bare({ config: { digest: { enabled: true, everyHours: 6, provider: 'p', model: 'm', workspacePath: '/tmp/qq-observer-ws' } } })
    expect(h.logs.some(line => line.text.includes('digests every 6 h'))).toBe(true)
    await vi.waitFor(() => { expect(h.observer['digest'] !== undefined).toBe(true) })
  })

  it('keeps its socket under the DSH home unless told otherwise, and runs without a recorder token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qq-observer-home-'))
    tmp.push(dir)
    vi.stubEnv('DSH_HOME', dir)
    const h = await bare({ config: { recorder: {} } })
    expect(h.observer.socketPath).toBe(join(dir, 'run', 'qq-recorder.sock'))
    await until(() => h.logs.some(line => line.text.includes('the recorder token is not set')), 'the missing token to be logged')
    expect(h.observer.connectionStatus().state).toBe('recorder-down')
  })

  it('treats a blank recorder token as none', async () => {
    const h = await bare({ token: '   ' })
    await until(() => h.logs.some(line => line.text.includes('the recorder token is not set')), 'the missing token to be logged')
  })
})

describe('QqObserver configuration', () => {
  const make = (over: Record<string, unknown>) => () => new QqObserver(new Context(), Config({ digest: { workspacePath: '/tmp/d' }, ...over }))

  it('refuses an address that is not on this machine or the tailnet, a group that is not a number, and a relative path', () => {
    expect(make({ url: 'ws://192.168.1.50:3001' })).toThrow('on this machine')
    expect(make({ groups: ['abc'] })).toThrow('not a group number')
    expect(make({ recorder: { socket: 'relative.sock' } })).toThrow('absolute path')
    expect(make({ login: { url: 'http://192.168.1.50:3002' } })).toThrow('login.url')
    expect(make({ login: { url: 'ftp://127.0.0.1:3002' } })).toThrow('login.url')
    expect(make({ settingsUrl: 'javascript:alert(1)' })).toThrow('settingsUrl')
    expect(make({ digest: { workspacePath: 'relative/dir' } })).toThrow('digest.workspacePath must be an absolute path')
    expect(make({ digest: { workspacePath: '/tmp/d', timeZone: 'Mars/Olympus' } })).toThrow('digest.timeZone "Mars/Olympus" is not a valid IANA time zone')
    expect(isPrivateAddress('http://127.0.0.1:3002', ['http:', 'https:'])).toBe(true)
    expect(isPrivateAddress('https://dsh.tailc2559b.ts.net', ['http:', 'https:'])).toBe(true)
  })

  it('fails loud on what the recorder cannot do: sending, transcription, and a token variable that is not one of its secrets', () => {
    expect(make({ send: { enabled: true } })).toThrow('send.enabled is not supported')
    expect(make({ asr: { enabled: true } })).toThrow('asr.enabled is not supported')
    expect(make({ tokenEnv: 'QQ_RECORDER_TOKEN' })).toThrow('recorder\'s secrets')
  })

  const base = { url: 'ws://127.0.0.1:3001', groups: ['123456789'], digest: { workspacePath: '/tmp/x' } }
  const same = (next: Record<string, unknown>) => equalExceptVolatile(base, { ...base, ...next }, Config)

  it.each([
    ['backfill', { backfill: { enabled: false } }],
    ['media.images', { media: { images: false } }],
    ['voice.download', { voice: { download: false } }],
    ['retention.textDays', { retention: { textDays: 7 } }],
    ['honorRecall', { honorRecall: false }],
    ['offlineNoticeMs', { offlineNoticeMs: 0 }],
    ['settingsUrl', { settingsUrl: 'https://dsh.example.test/' }],
    ['reconnectQuietMs', { reconnectQuietMs: 0 }],
    ['groups', { groups: ['123456789', '987654321'] }],
  ])('commits a changed %s into the running plugin and pushes it to the recorder', (_name, change) => {
    expect(same(change)).toBe(true)
  })

  it.each([
    ['url', { url: 'ws://127.0.0.1:3002' }],
    ['digest', { digest: { workspacePath: '/tmp/x', model: 'other' } }],
    ['login', { login: { enabled: false } }],
    ['recorder', { recorder: { socket: '/tmp/other.sock' } }],
  ])('reloads the plugin (cheap: the recorder holds the connection) when %s changes', (_name, change) => {
    expect(same(change)).toBe(false)
  })
})

/** What the observer's own services need, with no recorder behind it: the socket is a path nothing listens on. */
async function bare(options: {
  config?: Record<string, unknown>
  gate?: Promise<void>
  pool?: MemoryMediaPool
  token?: string | undefined
  bus?: { protectSessions: (label: string, check: (session: { id: string }) => boolean) => () => void; publish?: ReturnType<typeof vi.fn> }
  notifier?: { send: ReturnType<typeof vi.fn> }
  sessions?: object
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qq-observer-bare-'))
  tmp.push(dir)
  const ctx = new Context()
  contexts.push(ctx)
  const logs: Array<{ type: string; text: string }> = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (m) => { logs.push({ type: m.type, text: String(m.args[0]) }) } })
  await mountMemoryStorage(ctx, options.pool ?? new MemoryMediaPool(), options.gate)
  const resolve = (ref: string) => Promise.resolve(ref === 'QQ_RECORDER_TOKEN' && options.token !== undefined ? { value: options.token } : undefined)
  ctx.provide('credentials', { resolve } as never)
  ctx.provide('sessionController', (options.sessions ?? {}) as never)
  ctx.provide('permissionPresets', { resolve: vi.fn(), set: vi.fn() } as never)
  ctx.provide('sessionTitle', { rename: vi.fn() } as never)
  if (options.bus !== undefined) ctx.provide('eventBus', options.bus as never)
  if (options.notifier !== undefined) ctx.provide('ownerNotifier', options.notifier as never)
  await ctx.plugin(QqObserver, {
    url: 'ws://127.0.0.1:1', groups: [GROUP], recorder: { socket: join(dir, 'none.sock') }, login: { enabled: false },
    digest: { enabled: false, workspacePath: join(dir, 'ws') }, ...options.config,
  })
  return { ctx, observer: ctx.qq, logs, dir }
}

const group = (groupId: string, name: string, over: Partial<Group> = {}): Group => (
  { groupId, name, memberCount: null, recorded: false, messages: 0, firstAt: null, lastAt: null, unlistedSeen: 0, ...over }
)

describe('QqObserver before its storage is open', () => {
  it('answers the digest tools and every read with nothing rather than an error, and protects no Session', async () => {
    let open!: () => void
    const gate = new Promise<void>((resolve) => { open = resolve })
    const checks: Array<(session: { id: string }) => boolean> = []
    const bus = {
      protectSessions: (_label: string, check: (session: { id: string }) => boolean) => { checks.push(check); return () => {} },
    }
    try {
      const h = await bare({ gate, bus })
      await vi.waitFor(() => { expect(checks).toHaveLength(1) })
      const none = { ok: false, error: 'this tool works only inside a QQ digest turn' }
      expect(h.observer.digestWrite('s', GROUP, 'text')).toEqual(none)
      expect(await h.observer.groupNote('s', GROUP, 'add', 'x')).toEqual(none)
      expect(h.observer.groupOfSession('s')).toBeUndefined()
      expect(h.observer.recentTextOf('s')).toBeUndefined()
      expect(h.observer.groupNotes(GROUP)).toEqual([])
      expect(await h.observer.evidenceOf(GROUP, ['1'])).toEqual([])
      expect(h.observer.digests({ days: 1, limit: 5 })).toEqual([])
      expect(await h.observer.forgetDigests({ groupId: GROUP })).toBe(0)
      expect(h.logs.some(line => line.text === `qq: deleted 0 digest(s) of group ${GROUP}`)).toBe(true)
      expect(checks[0]!({ id: 'digest-1' })).toBe(false)
      vi.spyOn(h.observer['client'], 'groups').mockResolvedValue([group(GROUP, '技术群', { recorded: true })])
      expect((await h.observer.groupOverview())[0]).toMatchObject({ groupId: GROUP, lastDigestAt: null })
    } finally {
      open()
    }
  })

  it('protects the resident digest Session of a group once storage is open, and no other', async () => {
    const checks: Array<(session: { id: string }) => boolean> = []
    const bus = {
      protectSessions: (_label: string, check: (session: { id: string }) => boolean) => { checks.push(check); return () => {} },
    }
    const h = await bare({ bus })
    await vi.waitFor(() => { expect(h.observer['store']).toBeDefined() })
    await h.observer['store']!.setGroupSession(GROUP, { sessionId: 'resident-1', createdAt: 1, generation: 1 })
    expect(checks[0]!({ id: 'resident-1' })).toBe(true)
    expect(checks[0]!({ id: 'other' })).toBe(false)
  })
})

describe('QqObserver with its storage open', () => {
  it('lists the notes of a recorded group only, and keeps its retention window off when set to 0 days', async () => {
    const h = await bare({ config: { retention: { textDays: 0 } } })
    await vi.waitFor(() => { expect(h.observer['store']).toBeDefined() })
    await h.observer['store']!.addNote(GROUP, '常聊显卡', 5)
    expect(h.observer.groupNotes(GROUP)).toEqual([{ id: 1, groupId: GROUP, text: '常聊显卡', createdAt: 5 }])
    expect(h.observer.groupNotes(OTHER)).toEqual([])
    expect(await h.observer.groupNote(undefined, GROUP, 'add', 'x')).toEqual({ ok: false, error: 'this tool works only inside a QQ digest turn' })
    const old: Message = {
      cursor: 'c1', groupId: GROUP, messageId: '7', at: 1, userId: '10001', nickname: '', card: '', role: 'member', replyTo: null, kinds: 'text',
      recalled: false, media: [], text: '很久以前',
    }
    vi.spyOn(h.observer['client'], 'lookup').mockResolvedValue([old])
    expect(await h.observer.evidenceOf(GROUP, ['7'])).toEqual([expect.objectContaining({ messageId: '7', at: 1, text: '很久以前' })])
  })

  it('says which digests were deleted by group and cutoff, and finds the groups\' digest times', async () => {
    const h = await bare()
    await vi.waitFor(() => { expect(h.observer['store']).toBeDefined() })
    expect(await h.observer.forgetDigests({ groupId: GROUP, beforeMs: 5 })).toBe(0)
    expect(h.logs.some(line => line.text === `qq: deleted 0 digest(s) of group ${GROUP} made before a cutoff`)).toBe(true)
    expect(await h.observer.forgetDigests({ beforeMs: 5 })).toBe(0)
    expect(h.logs.some(line => line.text === 'qq: deleted 0 digest(s) made before a cutoff')).toBe(true)
  })

  it('lists recorded groups first, then by message count, then by name', async () => {
    const h = await bare({ config: { groups: [GROUP, '555555'] } })
    vi.spyOn(h.observer['client'], 'groups').mockResolvedValue([
      group('777', 'b 群', { messages: 0 }), group('888', 'a 群', { messages: 0 }), group('999', '热闹群', { messages: 9 }),
      group('555555', '小群', { messages: 1 }), group(GROUP, '大群', { messages: 5 }),
    ])
    expect((await h.observer.groupOverview()).map(entry => entry.groupId)).toEqual([GROUP, '555555', '999', '888', '777'])
  })

  it('asks the recorder for one member\'s messages and for a search', async () => {
    const h = await bare()
    const recent = vi.spyOn(h.observer['client'], 'recent').mockResolvedValue([])
    await h.observer.recentMessages(GROUP, { hours: 2, limit: 7, userId: '10001' })
    await h.observer.recentMessages(GROUP, { hours: 2, limit: 7 })
    expect(recent.mock.calls.map(call => (call[1] as { userId?: string }).userId)).toEqual(['10001', undefined])
    expect(recent.mock.calls[0]![1]).toMatchObject({ limit: 7 })
    expect(Object.hasOwn(recent.mock.calls[1]![1] as object, 'userId')).toBe(false)
  })
})

describe('QqObserver pictures', () => {
  const header = (groupId: string, contentType: 'image/png' | 'image/jpeg' | 'unknown') => ({ groupId, contentType, bytes: 3 })

  it('refuses when the recorder is too old, when the picture is of an unrecorded group, and names an unknown type PNG', async () => {
    const h = await bare()
    const client = h.observer['client']
    vi.spyOn(client, 'supports').mockReturnValue(false)
    await expect(h.observer.image('m1')).rejects.toThrow('too old to serve pictures')
    vi.spyOn(client, 'supports').mockReturnValue(true)
    const media = vi.spyOn(client, 'media')
    media.mockResolvedValue({ bytes: Buffer.from('abc'), header: header(OTHER, 'image/png') })
    await expect(h.observer.image('m1')).rejects.toThrow('belongs to a group that is not recorded')
    media.mockResolvedValue({ bytes: Buffer.from('abc'), header: header(GROUP, 'unknown') })
    expect(await h.observer.image('m1')).toEqual({ bytes: Buffer.from('abc'), mediaType: 'image/png', groupId: GROUP })
    media.mockResolvedValue({ bytes: Buffer.from('abc'), header: header(GROUP, 'image/jpeg') })
    expect((await h.observer.image('m1')).mediaType).toBe('image/jpeg')
  })

  it('turns "not saved" and "invalid ref" into ImageNotSaved and lets every other failure through', async () => {
    const h = await bare()
    const client = h.observer['client']
    vi.spyOn(client, 'supports').mockReturnValue(true)
    const media = vi.spyOn(client, 'media')
    media.mockRejectedValue(new RecorderError(404, 'not-saved', 'image was not saved'))
    await expect(h.observer.image('m1')).rejects.toBeInstanceOf(ImageNotSaved)
    media.mockRejectedValue(new RecorderError(400, 'invalid-ref', 'no such reference'))
    await expect(h.observer.image('m1')).rejects.toBeInstanceOf(ImageNotSaved)
    media.mockRejectedValue(new RecorderError(500, 'error', 'HTTP 500'))
    await expect(h.observer.image('m1')).rejects.toMatchObject({ code: 'error' })
    media.mockRejectedValue(new RecorderUnavailable('recorder-down', 'down'))
    await expect(h.observer.image('m1')).rejects.toBeInstanceOf(RecorderUnavailable)
  })

  it('hands the digest the picture with a file name from its type', async () => {
    const h = await bare()
    vi.spyOn(h.observer, 'image').mockResolvedValue({ bytes: Buffer.from('abc'), mediaType: 'image/webp', groupId: GROUP })
    expect(await h.observer['reader']().media('m12ab')).toEqual({ bytes: Buffer.from('abc'), mediaType: 'image/webp', name: 'm12ab.webp' })
  })

  it('hands the digest the member list only when the recorder offers it, and its names and pages as the recorder gives them', async () => {
    const h = await bare()
    const client = h.observer['client']
    const reader = h.observer['reader']()
    vi.spyOn(client, 'supports').mockReturnValue(false)
    expect(await reader.members(GROUP)).toBeUndefined()
    vi.spyOn(client, 'supports').mockReturnValue(true)
    const members = vi.spyOn(client, 'members').mockResolvedValue([{ userId: '1', nickname: 'a', card: '' }])
    expect(await reader.members(GROUP)).toEqual([{ userId: '1', nickname: 'a', card: '' }])
    expect(members).toHaveBeenCalledWith(GROUP)
    const page = vi.spyOn(client, 'page').mockResolvedValue({ items: [], nextCursor: null })
    const lookup = vi.spyOn(client, 'lookup').mockResolvedValue([])
    await reader.page(GROUP, 'c1', 10)
    await reader.lookup(GROUP, ['1'])
    expect(page).toHaveBeenCalledWith(GROUP, 'c1', 10)
    expect(lookup).toHaveBeenCalledWith(GROUP, ['1'])
    expect(reader.groupName(GROUP)).toBe(GROUP)
  })
})

describe('QqObserver login door', () => {
  const login = (over: Partial<Login> = {}): Login => ({ door: 'ok', state: 'online', uin: '1', nickname: 'n', error: null, qrUrl: null, ...over })

  it('reports the door as it is, calls an unknown door invalid, and says the recorder is down when it is', async () => {
    const h = await bare()
    const client = h.observer['client']
    const read = vi.spyOn(client, 'login')
    read.mockResolvedValue(login())
    expect(await h.observer.loginStatus({ fresh: true })).toEqual({ door: 'ok', state: 'online', uin: '1', nickname: 'n', error: null, qrUrl: null })
    expect(read).toHaveBeenLastCalledWith(true)
    read.mockResolvedValue(login({ door: 'unknown' as never }))
    expect((await h.observer.loginStatus()).door).toBe('invalid')
    expect(read).toHaveBeenLastCalledWith(false)
    read.mockRejectedValue(new RecorderUnavailable('recorder-down', 'down'))
    expect(await h.observer.loginStatus()).toEqual({ door: 'recorder-down', state: null, uin: null, nickname: null, error: null, qrUrl: null })
    read.mockRejectedValue(new Error('socket reset'))
    await expect(h.observer.loginStatus()).rejects.toThrow('socket reset')
  })

  it('passes a refresh refusal on, calls an unknown one unreachable, and says the recorder is down when it is', async () => {
    const h = await bare()
    const refresh = vi.spyOn(h.observer['client'], 'refreshLogin')
    refresh.mockResolvedValue({ login: login(), refreshed: false, reason: 'too-soon' })
    expect(await h.observer.refreshLogin()).toMatchObject({ refreshed: false, reason: 'too-soon' })
    refresh.mockResolvedValue({ login: login(), refreshed: false, reason: 'unknown' })
    expect((await h.observer.refreshLogin()).reason).toBe('unreachable')
    refresh.mockResolvedValue({ login: login(), refreshed: true, reason: null })
    expect(await h.observer.refreshLogin()).toMatchObject({ refreshed: true, reason: null })
    refresh.mockRejectedValue(new RecorderUnavailable('recorder-down', 'down'))
    expect(await h.observer.refreshLogin()).toMatchObject({ refreshed: false, reason: 'unreachable', login: { door: 'recorder-down' } })
    refresh.mockRejectedValue(new Error('socket reset'))
    await expect(h.observer.refreshLogin()).rejects.toThrow('socket reset')
  })
})
