import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { equalExceptVolatile } from '../../../../vendor/loader/src/config/diff.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config, isPrivateAddress, QqObserver, SendRefused, type DigestRow } from '../src/index.ts'
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
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(servers.splice(0).map(server => server.close()))
  for (const dir of tmp.splice(0)) rmSync(dir, { recursive: true, force: true })
  expect(await shutdown()).toEqual([])
})

async function rig(options: { prepare?: (dataDir: string) => void; online?: boolean } = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'lsy-qq-observer-rig-'))
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
  options: { config?: Record<string, unknown>; pool?: MemoryMediaPool; notifier?: { send: ReturnType<typeof vi.fn> }; url?: string } = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const logs: Array<{ type: string; text: string }> = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (m) => { logs.push({ type: m.type, text: String(m.args[0]) }) } })
  await mountMemoryStorage(ctx, options.pool ?? new MemoryMediaPool())
  ctx.provide('credentials', { resolve: (ref: string) => Promise.resolve(ref === 'LSY_QQ_RECORDER_TOKEN' ? { value: RECORDER_TOKEN } : undefined) } as never)
  ctx.provide('sessionController', {} as never)
  ctx.provide('permissionPresets', {} as never)
  ctx.provide('sessionTitle', {} as never)
  if (options.notifier !== undefined) ctx.provide('lsyNotifier', options.notifier as never)
  await ctx.plugin(QqObserver, {
    url: r.fake.url, groups: [GROUP], recorder: { socket: r.socketPath }, login: { enabled: false },
    digest: { enabled: false, workspacePath: join(tmpdir(), 'lsy-qq-observer-ws') }, ...options.config,
  })
  const observer = ctx.lsyQq
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
    ctx.provide('credentials', { resolve: (ref: string) => Promise.resolve(ref === 'LSY_QQ_RECORDER_TOKEN' ? { value: RECORDER_TOKEN } : undefined) } as never)
    ctx.provide('sessionController', {} as never)
    ctx.provide('permissionPresets', {} as never)
    ctx.provide('sessionTitle', {} as never)
    if (options.notifier !== undefined) ctx.provide('lsyNotifier', options.notifier as never)
    await ctx.plugin(QqObserver, { url, groups: [GROUP], recorder: { socket: r.socketPath }, login: { enabled: false }, digest: { enabled: false, workspacePath: join(tmpdir(), 'ws') }, ...options.config })
    const observer = ctx.lsyQq
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

describe('QqObserver configuration', () => {
  const make = (over: Record<string, unknown>) => () => new QqObserver(new Context(), Config({ digest: { workspacePath: '/tmp/d' }, ...over }))

  it('refuses an address that is not on this machine or the tailnet, a group that is not a number, and a relative path', () => {
    expect(make({ url: 'ws://192.168.1.50:3001' })).toThrow('on this machine')
    expect(make({ groups: ['abc'] })).toThrow('not a group number')
    expect(make({ recorder: { socket: 'relative.sock' } })).toThrow('absolute path')
    expect(make({ login: { url: 'http://192.168.1.50:3002' } })).toThrow('login.url')
    expect(make({ login: { url: 'ftp://127.0.0.1:3002' } })).toThrow('login.url')
    expect(make({ settingsUrl: 'javascript:alert(1)' })).toThrow('settingsUrl')
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
