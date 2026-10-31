import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import QqObserver, { Config, QqObserver as Observer, SendRefused } from '../src/index.ts'
import { FakeOneBot, groupMessage } from './fake-onebot.ts'

const TOKEN = 'onebot-token-0123456789abcdef'
const GROUP = '123456789'
const OTHER_GROUP = '987654321'
const USER = '10001'
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixel-data-0123456789')])

interface LogLine { type: string; text: string }

let dir: string
const servers: FakeOneBot[] = []
const contexts: Context[] = []
const allLogs: LogLine[] = []

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lsy-qq-observer-')) })
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(servers.splice(0).map(server => server.close()))
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
  // The token must never reach a log line.
  expect(allLogs.splice(0).filter(line => line.text.includes(TOKEN))).toEqual([])
})

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function boot(options: {
  config?: Record<string, unknown>
  server?: FakeOneBot
  credentials?: Record<string, string>
  notifier?: { send: ReturnType<typeof vi.fn> }
  voice?: { canTranscribe: (p: string) => boolean; transcribe: ReturnType<typeof vi.fn> }
  connect?: boolean
} = {}) {
  const fake = options.server ?? new FakeOneBot(TOKEN)
  if (options.server === undefined) {
    servers.push(fake)
    await fake.listen()
  }
  fake.handlers.set('get_login_info', () => ({ user_id: 99999, nickname: 'bot' }))
  fake.handlers.set('get_group_list', () => [
    { group_id: Number(GROUP), group_name: '技术群', member_count: 80 },
    { group_id: Number(OTHER_GROUP), group_name: '闲聊群', member_count: 300 },
  ])
  const ctx = new Context()
  contexts.push(ctx)
  const logs: LogLine[] = []
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (m) => {
      const line = { type: m.type, text: String(m.args[0]) }
      logs.push(line)
      allLogs.push(line)
    },
  })
  const credentials = options.credentials ?? { LSY_QQ_ONEBOT_TOKEN: TOKEN }
  ctx.provide('credentials', { resolve: (ref: string) => Promise.resolve(credentials[ref] === undefined ? undefined : { value: credentials[ref] }) } as never)
  ctx.provide('sessionController', { create: vi.fn(), resolveAgent: vi.fn(), prompt: vi.fn(), selectModel: vi.fn() } as never)
  ctx.provide('permissionPresets', { resolve: vi.fn(), set: vi.fn() } as never)
  ctx.provide('sessionTitle', { rename: vi.fn(), get: vi.fn() } as never)
  if (options.notifier !== undefined) ctx.provide('lsyNotifier', options.notifier as never)
  if (options.voice !== undefined) ctx.provide('lsyVoice', options.voice as never)
  const config = Config({
    url: fake.url, groups: [GROUP], dataDir: join(dir, 'data'), digest: { enabled: false, workspacePath: join(dir, 'digest') },
    ...options.config,
  } as never)
  await ctx.plugin(Observer, config)
  const observer = ctx.lsyQq
  if (options.connect !== false) await until(() => fake.connections > 0 && logs.some(line => line.text.includes('logged in as')), 'the connection')
  return { ctx, observer, fake, logs, config }
}

const dataOf = (o: Observer) => o.store

describe('QqObserver recording', () => {
  it('records messages of listed groups only, once each, and counts nothing from private chats', async () => {
    const h = await boot()
    const event = groupMessage(GROUP, USER, '今天讨论部署')
    h.fake.push(event)
    h.fake.push(event)
    h.fake.push(groupMessage(OTHER_GROUP, USER, '不该记录'))
    h.fake.push({ post_type: 'message', message_type: 'private', user_id: 555, message: [{ type: 'text', data: { text: '私聊内容' } }], message_id: 1, time: 1_790_000_000 })
    await until(() => dataOf(h.observer).recent(GROUP, { limit: 10 }).length === 1, 'the message')
    await new Promise(resolve => setTimeout(resolve, 100))
    const rows = h.observer.recentMessages(GROUP, { hours: 24 * 365 * 10, limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ groupId: GROUP, userId: USER, text: '今天讨论部署', card: '名片01', nickname: '昵称01' })
    expect(h.observer.searchMessages('不该记录', { limit: 5 })).toEqual([])
    expect(dataOf(h.observer).search('私聊内容', { limit: 5 })).toEqual([])
    expect(h.logs.filter(line => line.text.includes(`not recording group ${OTHER_GROUP}`))).toHaveLength(1)
    // Bodies stay out of the log.
    expect(h.logs.filter(line => line.text.includes('今天讨论部署') || line.text.includes('私聊内容'))).toEqual([])
  })

  it('records nothing while the group list is empty, and says so', async () => {
    const h = await boot({ config: { groups: [] } })
    h.fake.push(groupMessage(GROUP, USER, 'hello'))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(dataOf(h.observer).stats()).toEqual([])
    expect(h.logs.some(line => line.text.includes('the list is empty'))).toBe(true)
  })

  it('keeps who said it, the quoted message, and the kinds of segment', async () => {
    const h = await boot()
    h.fake.push(groupMessage(GROUP, USER, [
      { type: 'reply', data: { id: '777' } },
      { type: 'at', data: { qq: '10002', name: '小红' } },
      { type: 'text', data: { text: ' 同意' } },
    ]))
    await until(() => dataOf(h.observer).stats().length === 1, 'the row')
    const row = dataOf(h.observer).recent(GROUP, { limit: 1 })[0]!
    expect(row).toMatchObject({ text: '@小红  同意', replyTo: '777', kinds: 'reply,at,text' })
  })

  it('downloads images from QQ hosts into content-addressed private files, and refuses other hosts', async () => {
    const fetched: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { fetched.push(url); return new Response(PNG, { status: 200 }) }))
    const h = await boot()
    h.fake.push(groupMessage(GROUP, USER, [
      { type: 'image', data: { url: 'https://multimedia.nt.qq.com.cn/a/b.png', file: 'b.png' } },
      { type: 'image', data: { url: 'https://evil.example.com/x.png', file: 'x.png' } },
      { type: 'image', data: { url: 'https://127.0.0.1/y.png', file: 'y.png' } },
    ]))
    await until(() => dataOf(h.observer).stats().length === 1, 'the row')
    await until(() => dataOf(h.observer).mediaOf(1).filter(m => m.localPath !== null || m.error !== null).length === 3, 'the downloads')
    const media = dataOf(h.observer).mediaOf(1)
    expect(fetched).toEqual(['https://multimedia.nt.qq.com.cn/a/b.png'])
    expect(media[0]!.localPath).toMatch(/media\/123456789\/\d{6}\/[0-9a-f]{64}\.png$/)
    expect(readFileSync(media[0]!.localPath!)).toEqual(PNG)
    expect(statSync(media[0]!.localPath!).mode & 0o777).toBe(0o600)
    expect(media[1]!.error).toBe('the address is not on media.hostSuffixes')
    expect(media[2]!.error).toBe('the address is not on media.hostSuffixes')
  })

  it('keeps an image it cannot fetch as a row with its reason, and stops at the size cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.alloc(5000), { status: 200 })))
    const h = await boot({ config: { media: { maxImageBytes: 2048 } } })
    h.fake.push(groupMessage(GROUP, USER, [{ type: 'image', data: { url: 'https://gchat.qpic.cn/a.jpg' } }]))
    await until(() => dataOf(h.observer).mediaOf(1).some(m => m.error !== null), 'the failure')
    expect(dataOf(h.observer).mediaOf(1)[0]).toMatchObject({ localPath: null, url: 'https://gchat.qpic.cn/a.jpg' })
    expect(dataOf(h.observer).mediaOf(1)[0]!.error).toContain('2048')
  })

  it('does not download images when turned off', async () => {
    const fetchSpy = vi.fn(async () => new Response(PNG))
    vi.stubGlobal('fetch', fetchSpy)
    const h = await boot({ config: { media: { images: false } } })
    h.fake.push(groupMessage(GROUP, USER, [{ type: 'image', data: { url: 'https://gchat.qpic.cn/a.jpg' } }]))
    await until(() => dataOf(h.observer).stats().length === 1, 'the row')
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(dataOf(h.observer).mediaOf(1)[0]!.localPath).toBeNull()
  })

  it('stores a voice message as MP3 and transcribes it only when the switch is on', async () => {
    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.from('mp3-audio-bytes')])
    const transcribe = vi.fn(async () => ({ text: '明天下午三点开会' }))
    const voice = { canTranscribe: (p: string) => p.endsWith('.mp3'), transcribe }
    const off = await boot({ voice })
    off.fake.handlers.set('get_record', () => ({ base64: mp3.toString('base64') }))
    off.fake.push(groupMessage(GROUP, USER, [{ type: 'record', data: { file: 'voice.amr' } }]))
    await until(() => dataOf(off.observer).mediaOf(1).some(m => m.localPath !== null), 'the voice file')
    expect(off.fake.callsOf('get_record')).toEqual([{ file: 'voice.amr', out_format: 'mp3' }])
    expect(transcribe).not.toHaveBeenCalled()
    expect(dataOf(off.observer).recent(GROUP, { limit: 1 })[0]!.text).toBe('[语音]')
    await off.ctx.fiber.dispose()

    const dir2 = mkdtempSync(join(tmpdir(), 'lsy-qq-observer2-'))
    try {
      const on = await boot({ voice, config: { dataDir: dir2, asr: { enabled: true } } })
      on.fake.handlers.set('get_record', () => ({ base64: mp3.toString('base64') }))
      on.fake.push(groupMessage(GROUP, USER, [{ type: 'record', data: { file: 'voice.amr' } }]))
      await until(() => dataOf(on.observer).mediaOf(1).some(m => m.transcript !== null), 'the transcript')
      expect(transcribe).toHaveBeenCalledTimes(1)
      expect(dataOf(on.observer).recent(GROUP, { limit: 1 })[0]!.text).toBe('[语音] 〔语音转写：明天下午三点开会〕')
      expect(dataOf(on.observer).search('下午三点开会', { limit: 3 })).toHaveLength(1)
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  })

  it('drops the text and files of a recalled message, unless told to keep them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(PNG)))
    const h = await boot()
    const event = groupMessage(GROUP, USER, [{ type: 'text', data: { text: '说错了的话' } }, { type: 'image', data: { url: 'https://gchat.qpic.cn/a.jpg' } }])
    h.fake.push(event)
    await until(() => dataOf(h.observer).mediaOf(1).some(m => m.localPath !== null), 'the image')
    const path = dataOf(h.observer).mediaOf(1)[0]!.localPath!
    h.fake.push({ post_type: 'notice', notice_type: 'group_recall', group_id: Number(GROUP), message_id: event['message_id'], user_id: Number(USER), operator_id: Number(USER) })
    await until(() => dataOf(h.observer).recent(GROUP, { limit: 5 }).length === 0, 'the recall')
    expect(existsSync(path)).toBe(false)
    expect(dataOf(h.observer).search('说错了的话', { limit: 5 })).toEqual([])
  })

  it('backfills what was missed, newest first, until it meets a stored message', async () => {
    const fake = new FakeOneBot(TOKEN)
    servers.push(fake)
    await fake.listen()
    const history = [1, 2, 3, 4, 5].map(n => groupMessage(GROUP, USER, `历史消息${n}`, { message_id: 9000 + n, message_seq: 100 + n, time: 1_700_000_000 + n }))
    fake.handlers.set('get_group_msg_history', (params) => {
      // The newest page when no seq is given, then the page before it.
      return params['message_seq'] === undefined ? { messages: history.slice(2) } : { messages: history.slice(0, 2) }
    })
    const h = await boot({ server: fake })
    await until(() => dataOf(h.observer).recent(GROUP, { limit: 10 }).length === 5, 'the backfill')
    expect(h.observer.store.recent(GROUP, { limit: 10 }).map(m => m.text)).toEqual(['历史消息1', '历史消息2', '历史消息3', '历史消息4', '历史消息5'])
    const calls = fake.callsOf('get_group_msg_history')
    expect(calls.slice(0, 2)).toEqual([{ group_id: Number(GROUP), count: 50 }, { group_id: Number(GROUP), count: 50, message_seq: 103 }])
    // The page before the oldest one is all known, so the walk ends there.
    expect(calls).toHaveLength(3)
  })
})

describe('QqObserver retention', () => {
  it('deletes raw messages and downloads older than 30 days but keeps digests', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(PNG)))
    const h = await boot()
    const now = Date.now()
    h.fake.push(groupMessage(GROUP, USER, [{ type: 'text', data: { text: '三个月前的闲聊' } }, { type: 'image', data: { url: 'https://gchat.qpic.cn/a.jpg' } }], { time: Math.floor(now / 1000) - 90 * 86_400 }))
    h.fake.push(groupMessage(GROUP, USER, '刚才的讨论内容', { time: Math.floor(now / 1000) - 60 }))
    await until(() => dataOf(h.observer).stats()[0]?.messages === 2, 'both rows')
    await until(() => dataOf(h.observer).mediaOf(1).some(m => m.localPath !== null), 'the image')
    const path = dataOf(h.observer).mediaOf(1)[0]!.localPath!
    dataOf(h.observer).insertDigest({ groupId: GROUP, fromRow: 1, toRow: 2, messageCount: 2, text: '摘要', model: 'm', createdAt: now - 80 * 86_400_000 })
    await (h.observer as unknown as { prune(): Promise<void> }).prune()
    expect(dataOf(h.observer).search('三个月前', { limit: 5 })).toEqual([])
    expect(dataOf(h.observer).search('刚才的讨论', { limit: 5 })).toHaveLength(1)
    expect(existsSync(path)).toBe(false)
    expect(h.observer.digests({ groupId: GROUP, days: 365, limit: 5 })).toHaveLength(1)
    expect(h.observer.forgetDigests({ groupId: GROUP })).toBe(1)
    expect(() => h.observer.forgetDigests({})).toThrow()
  })
})

describe('QqObserver connection and owner notices', () => {
  it('stays offline and says why while the token is missing', async () => {
    const h = await boot({ credentials: {}, connect: false })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(h.fake.connections).toBe(0)
    expect(h.logs.some(line => line.text.includes('LSY_QQ_ONEBOT_TOKEN is not set'))).toBe(true)
  })

  it('tells the owner when the account goes offline', async () => {
    const notifier = { send: vi.fn(async () => {}) }
    const h = await boot({ notifier })
    h.fake.push({ post_type: 'notice', notice_type: 'bot_offline', user_id: 99999, tag: 'KickedOffLine' })
    await until(() => notifier.send.mock.calls.length === 1, 'the notice')
    expect(JSON.stringify(notifier.send.mock.calls[0])).toContain('QQ 号掉线了')
  })

  it('reconnects after the server drops it', async () => {
    const h = await boot()
    h.fake.drop()
    await until(() => h.fake.connections === 2, 'the reconnect')
    expect(h.logs.some(line => line.text.includes('reconnecting in 2 s'))).toBe(true)
  })

  it('refuses a protocol end address that is not on this machine or the tailnet, and a group that is not a number', () => {
    const make = (over: Record<string, unknown>) => () => new QqObserver(new Context(), Config({ dataDir: join(dir, 'x'), digest: { workspacePath: join(dir, 'd') }, ...over } as never))
    expect(make({ url: 'ws://192.168.1.50:3001' })).toThrow('on this machine')
    expect(make({ groups: ['abc'] })).toThrow('not a group number')
    expect(make({ dataDir: 'relative' })).toThrow('absolute path')
  })
})

describe('QqObserver sending', () => {
  it('refuses every send by default', async () => {
    const h = await boot()
    await expect(h.observer.sendGroupMessage(GROUP, 'hi')).rejects.toBeInstanceOf(SendRefused)
    await expect(h.observer.sendGroupMessage(GROUP, 'hi')).rejects.toThrow('send.enabled is false')
    expect(h.fake.callsOf('send_group_msg')).toEqual([])
  })

  it('sends only to groups listed for it, no faster than the interval and no more than the daily cap', async () => {
    const h = await boot({ config: { send: { enabled: true, groups: [GROUP], minIntervalSec: 60, maxPerDay: 2 } } })
    h.fake.handlers.set('send_group_msg', () => ({ message_id: 1 }))
    let now = 1_790_000_000_000
    h.observer.now = () => now
    await expect(h.observer.sendGroupMessage(OTHER_GROUP, 'no')).rejects.toThrow('not in send.groups')
    await h.observer.sendGroupMessage(GROUP, '第一条')
    expect(h.fake.callsOf('send_group_msg')).toEqual([{ group_id: Number(GROUP), message: [{ type: 'text', data: { text: '第一条' } }] }])
    await expect(h.observer.sendGroupMessage(GROUP, 'too soon')).rejects.toThrow('less than 60 s')
    now += 61_000
    await h.observer.sendGroupMessage(GROUP, '第二条')
    now += 61_000
    await expect(h.observer.sendGroupMessage(GROUP, '第三条')).rejects.toThrow('already got 2 messages today')
    now += 86_400_000
    await h.observer.sendGroupMessage(GROUP, '次日')
    expect(h.fake.callsOf('send_group_msg')).toHaveLength(3)
  })
})

describe('QqObserver reading', () => {
  it('lists every group the account is in, marking the recorded ones', async () => {
    const h = await boot()
    h.fake.push(groupMessage(GROUP, USER, 'hello'))
    await until(() => dataOf(h.observer).stats().length === 1, 'the row')
    const overview = h.observer.groupOverview()
    expect(overview.map(group => [group.groupId, group.name, group.recorded, group.messages])).toEqual([
      [GROUP, '技术群', true, 1],
      [OTHER_GROUP, '闲聊群', false, 0],
    ])
    expect(h.observer.groupName(GROUP)).toBe('技术群')
  })

  it('serves reads only for recorded groups', async () => {
    const h = await boot()
    h.fake.push(groupMessage(GROUP, USER, '关于数据库迁移的讨论'))
    await until(() => dataOf(h.observer).stats().length === 1, 'the row')
    expect(h.observer.searchMessages('数据库迁移', { limit: 5 })).toHaveLength(1)
    expect(h.observer.searchMessages('数据库迁移', { groupId: OTHER_GROUP, limit: 5 })).toEqual([])
    expect(h.observer.recentMessages(OTHER_GROUP, { hours: 99999, limit: 5 })).toEqual([])
    expect(h.observer.digests({ groupId: OTHER_GROUP, days: 30, limit: 5 })).toEqual([])
  })
})
