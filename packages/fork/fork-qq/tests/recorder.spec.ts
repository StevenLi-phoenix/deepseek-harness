import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigRejected, MediaNotSaved, mediaIdOf, mediaRef } from '../src/recorder.ts'
import { FakeOneBot, groupMessage } from './fake-onebot.ts'
import { TOKEN, bootRecorder, connected, recorderConfig, shutdown, sleep, until, type Booted } from './recorder-harness.ts'

const GROUP = '123456789'
const OTHER_GROUP = '987654321'
const USER = '10001'
const MINUTE = 60_000
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixel-data-0123456789')])
const ALL = { sinceMs: 0, limit: 100 }

afterEach(async () => {
  vi.unstubAllGlobals()
  // The token must never reach a log line.
  expect(await shutdown()).toEqual([])
})

const rows = (h: Booted, group = GROUP) => h.recorder.recent(group, ALL)

describe('QqRecorder recording', () => {
  it('records messages of listed groups only, once each, and counts nothing from private chats', async () => {
    const h = await bootRecorder()
    await connected(h)
    const event = groupMessage(GROUP, USER, '今天讨论部署')
    h.fake.push(event)
    h.fake.push(event)
    h.fake.push(groupMessage(OTHER_GROUP, USER, '不该记录'))
    h.fake.push({ post_type: 'message', message_type: 'private', user_id: 555, message: [{ type: 'text', data: { text: '私聊内容' } }], message_id: 1, time: 1_790_000_000 })
    await until(() => rows(h).length === 1, 'the message')
    await sleep(100)
    expect(rows(h)).toHaveLength(1)
    expect(rows(h)[0]).toMatchObject({ groupId: GROUP, userId: USER, text: '今天讨论部署', card: '名片01', nickname: '昵称01' })
    expect(h.recorder.search('不该记录', { limit: 5 })).toEqual([])
    expect(h.recorder.search('私聊内容', { limit: 5 })).toEqual([])
    expect(h.logs.filter(line => line.text.includes(`not recording group ${OTHER_GROUP}`))).toHaveLength(1)
    // Unlisted groups are only counted, so the owner can see which are busy before listing one.
    expect(h.recorder.groups().find(group => group.groupId === OTHER_GROUP)).toMatchObject({ recorded: false, unlistedSeen: 1, name: '闲聊群' })
    expect(h.recorder.status().counters).toMatchObject({ messages: 1, dropped: 1, private: 1 })
    // Bodies stay out of the log.
    expect(h.logs.filter(line => line.text.includes('今天讨论部署') || line.text.includes('私聊内容'))).toEqual([])
  })

  it('records nothing while the group list is empty', async () => {
    const h = await bootRecorder({ config: { groups: [] } })
    await connected(h)
    h.fake.push(groupMessage(GROUP, USER, 'hello'))
    await sleep(100)
    expect(h.recorder.store.stats()).toEqual([])
  })

  it('keeps who said it, the quoted message, and the kinds of segment', async () => {
    const h = await bootRecorder()
    await connected(h)
    h.fake.push(groupMessage(GROUP, USER, [
      { type: 'reply', data: { id: '777' } },
      { type: 'at', data: { qq: '10002', name: '小红' } },
      { type: 'text', data: { text: ' 同意' } },
    ]))
    await until(() => rows(h).length === 1, 'the row')
    expect(rows(h)[0]).toMatchObject({ text: '@小红  同意', replyTo: '777', kinds: 'reply,at,text' })
  })

  it('downloads images from QQ hosts into content-addressed private files, and refuses other hosts', async () => {
    const fetched: string[] = []
    const h = await bootRecorder({ fetch: vi.fn(async (url: string) => { fetched.push(url); return new Response(PNG,
      { status: 200 }) }) as never })
    await connected(h)
    h.fake.push(groupMessage(GROUP, USER, [
      { type: 'image', data: { url: 'https://multimedia.nt.qq.com.cn/a/b.png', file: 'b.png' } },
      { type: 'image', data: { url: 'https://evil.example.com/x.png', file: 'x.png' } },
      { type: 'image', data: { url: 'https://127.0.0.1/y.png', file: 'y.png' } },
    ]))
    await until(() => h.recorder.store.mediaOf(1).filter(m => m.localPath !== null || m.error !== null).length === 3, 'the downloads')
    const media = h.recorder.store.mediaOf(1)
    expect(fetched).toEqual(['https://multimedia.nt.qq.com.cn/a/b.png'])
    expect(media[0]!.localPath).toMatch(/media\/123456789\/\d{6}\/[0-9a-f]{64}\.png$/)
    expect(readFileSync(media[0]!.localPath!)).toEqual(PNG)
    expect(statSync(media[0]!.localPath!).mode & 0o777).toBe(0o600)
    expect(media[1]!.error).toBe('the address is not on media.hostSuffixes')
    expect(media[2]!.error).toBe('the address is not on media.hostSuffixes')
  })

  it('keeps an image it cannot fetch as a row with its reason, and stops at the size cap', async () => {
    const h = await bootRecorder({ fetch: vi.fn(async () => new Response(Buffer.alloc(5000), { status: 200 })),
      config: { media: { maxImageBytes: 2048 } } })
    await connected(h)
    h.fake.push(groupMessage(GROUP, USER, [{ type: 'image', data: { url: 'https://gchat.qpic.cn/a.jpg' } }]))
    await until(() => h.recorder.store.mediaOf(1).some(m => m.error !== null), 'the failure')
    expect(h.recorder.store.mediaOf(1)[0]).toMatchObject({ localPath: null, url: 'https://gchat.qpic.cn/a.jpg' })
    expect(h.recorder.store.mediaOf(1)[0]!.error).toContain('2048')
  })

  it('does not download images when turned off', async () => {
    const spy = vi.fn(async () => new Response(PNG))
    const h = await bootRecorder({ fetch: spy, config: { media: { images: false } } })
    await connected(h)
    h.fake.push(groupMessage(GROUP, USER, [{ type: 'image', data: { url: 'https://gchat.qpic.cn/a.jpg' } }]))
    await until(() => rows(h).length === 1, 'the row')
    await sleep(80)
    expect(spy).not.toHaveBeenCalled()
    expect(h.recorder.store.mediaOf(1)[0]!.localPath).toBeNull()
  })

  it('stores a voice message as MP3 through the protocol end', async () => {
    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.from('mp3-audio-bytes')])
    const h = await bootRecorder()
    h.fake.handlers.set('get_record', () => ({ base64: mp3.toString('base64') }))
    await connected(h)
    h.fake.push(groupMessage(GROUP, USER, [{ type: 'record', data: { file: 'voice.amr' } }]))
    await until(() => h.recorder.store.mediaOf(1).some(m => m.localPath !== null), 'the voice file')
    expect(h.fake.callsOf('get_record')).toEqual([{ file: 'voice.amr', out_format: 'mp3' }])
    expect(rows(h)[0]!.text).toBe('[语音]')
  })

  it('drops the text and files of a recalled message, unless told to keep them', async () => {
    const h = await bootRecorder({ fetch: vi.fn(async () => new Response(PNG)) })
    await connected(h)
    const event = groupMessage(GROUP, USER, [{ type: 'text', data: { text: '说错了的话' } }, { type: 'image', data: { url: 'https://gchat.qpic.cn/a.jpg' } }])
    h.fake.push(event)
    await until(() => h.recorder.store.mediaOf(1).some(m => m.localPath !== null), 'the image')
    const path = h.recorder.store.mediaOf(1)[0]!.localPath!
    h.fake.push({ post_type: 'notice', notice_type: 'group_recall', group_id: Number(GROUP), message_id: event['message_id'], user_id: Number(USER), operator_id: Number(USER) })
    await until(() => rows(h).length === 0, 'the recall')
    expect(existsSync(path)).toBe(false)
    expect(h.recorder.search('说错了的话', { limit: 5 })).toEqual([])
  })

  it('serves reads only for recorded groups, and pages in log order', async () => {
    const h = await bootRecorder()
    await connected(h)
    for (const n of [1, 2, 3]) h.fake.push(groupMessage(GROUP, USER, `关于数据库迁移的讨论${n}`))
    await until(() => rows(h).length === 3, 'the rows')
    expect(h.recorder.search('数据库迁移', { limit: 5 })).toHaveLength(3)
    expect(h.recorder.search('数据库迁移', { groupId: OTHER_GROUP, limit: 5 })).toEqual([])
    expect(h.recorder.recent(OTHER_GROUP, ALL)).toEqual([])
    const first = h.recorder.page(GROUP, undefined, 2)
    expect(first.items.map(m => m.text)).toEqual(['关于数据库迁移的讨论1', '关于数据库迁移的讨论2'])
    expect(first.nextCursor).toBe(first.items[1]!.cursor)
    const second = h.recorder.page(GROUP, first.nextCursor!, 2)
    expect(second.items.map(m => m.text)).toEqual(['关于数据库迁移的讨论3'])
    expect(second.nextCursor).toBeNull()
    expect(() => h.recorder.page(GROUP, 'nope', 2)).toThrow(RangeError)
    expect(h.recorder.members(GROUP)).toContainEqual({ userId: USER, nickname: '昵称01', card: '名片01' })
  })
})

describe('QqRecorder retention', () => {
  it('deletes raw messages and downloads older than 30 days', async () => {
    const h = await bootRecorder({ fetch: vi.fn(async () => new Response(PNG)) })
    await connected(h)
    const now = Date.now()
    h.fake.push(groupMessage(GROUP, USER, [{ type: 'text', data: { text: '三个月前的闲聊' } }, { type: 'image', data: { url: 'https://gchat.qpic.cn/a.jpg' } }], { time: Math.floor(now / 1000) - 90 * 86_400 }))
    h.fake.push(groupMessage(GROUP, USER, '刚才的讨论内容', { time: Math.floor(now / 1000) - 60 }))
    await until(() => h.recorder.store.stats()[0]?.messages === 2, 'both rows')
    await until(() => h.recorder.store.mediaOf(1).some(m => m.localPath !== null), 'the image')
    const path = h.recorder.store.mediaOf(1)[0]!.localPath!
    await h.recorder.prune()
    expect(h.recorder.search('三个月前', { limit: 5 })).toEqual([])
    expect(h.recorder.search('刚才的讨论', { limit: 5 })).toHaveLength(1)
    expect(existsSync(path)).toBe(false)
  })
})

describe('QqRecorder connection', () => {
  it('waits for the configuration before it connects, and for the token before it tries', async () => {
    const h = await bootRecorder({ config: false })
    await sleep(150)
    expect(h.fake.connections).toBe(0)
    expect(h.recorder.status().connection.state).toBe('waiting-config')
    expect(h.recorder.status().configRevision).toBeNull()
    const none = await bootRecorder({ secrets: {} })
    await sleep(100)
    expect(none.fake.connections).toBe(0)
    expect(none.recorder.status().connection.state).toBe('waiting-token')
    expect(none.logs.some(line => line.text.includes('FORK_QQ_ONEBOT_TOKEN is not set'))).toBe(true)
  })

  it('connects once the configuration arrives, and reports the account and revision', async () => {
    const h = await bootRecorder({ config: false })
    expect(h.recorder.applyConfig(recorderConfig(h.fake.url, { groups: [GROUP] }))).toMatchObject({ reconnect: false })
    await connected(h)
    expect(h.fake.connections).toBe(1)
    expect(h.recorder.status()).toMatchObject({ connection: { state: 'connected', selfId: '99999', attempt: 0 }, recordedGroups: 1 })
  })

  it('reports the account going offline as an event and a timestamp, and keeps the facts for DSH to judge', async () => {
    const h = await bootRecorder()
    await connected(h)
    const events: string[] = []
    h.recorder.subscribe((event) => { events.push(event.type) })
    h.fake.push({ post_type: 'notice', notice_type: 'bot_offline', user_id: 99999, tag: 'KickedOffLine' })
    await until(() => events.includes('bot-offline'), 'the event')
    expect(h.recorder.status().outage.botOfflineAt).toBeGreaterThan(0)
    // An outage is routine for the recorder: it never logs an error line.
    expect(h.logs.filter(line => line.type === 'error')).toEqual([])
  })

  it('reconnects after the server drops it, and tells how long it has been down', async () => {
    const h = await bootRecorder()
    await connected(h)
    h.fake.drop()
    await until(() => h.fake.connections === 2, 'the reconnect')
    expect(h.logs.some(line => line.text.includes('reconnecting in 2 s'))).toBe(true)
    expect(h.logs.filter(line => line.type === 'error')).toEqual([])
  })

  it('reports a failing connection with the attempt count, the reason, and the outage start', async () => {
    const gone = new FakeOneBot(TOKEN)
    await gone.listen()
    const url = gone.url
    await gone.close()
    const h = await bootRecorder({ config: false })
    h.apply({ url })
    await until(() => h.logs.some(line => line.text.includes('reconnecting in')), 'the first failure')
    const status = h.recorder.status()
    expect(status.connection).toMatchObject({ state: 'reconnecting', attempt: 1, selfId: null })
    expect(status.connection.lastError).toEqual(expect.any(String))
    expect(status.outage.disconnectedSince).toBeGreaterThan(0)
  })

  it('refuses a configuration with an address that is not on this machine or the tailnet', async () => {
    const h = await bootRecorder({ config: false })
    expect(() => h.apply({ url: 'ws://192.168.1.50:3001' })).toThrow(ConfigRejected)
    expect(() => h.apply({ login: { enabled: true, url: 'http://192.168.1.50:3002', timeoutMs: 5000 } })).toThrow('login.url')
    expect(h.recorder.status().configRevision).toBeNull()
  })
})

describe('QqRecorder applies configuration without dropping the connection', () => {
  it('follows groups changed at run time, and fetches what an added group missed', async () => {
    const h = await bootRecorder({ config: { groups: [GROUP] } })
    await connected(h)
    h.fake.push(groupMessage(OTHER_GROUP, USER, '加入前'))
    await until(() => h.recorder.groups().some(group => group.unlistedSeen === 1), 'the dropped message')
    expect(h.apply({ groups: [GROUP, OTHER_GROUP] })).toMatchObject({ reconnect: false })
    h.fake.push(groupMessage(OTHER_GROUP, USER, '加入后'))
    await until(() => h.recorder.recent(OTHER_GROUP, ALL).length === 1, 'the recorded message')
    expect(h.recorder.recent(OTHER_GROUP, ALL)[0]?.text).toBe('加入后')
    await until(() => h.fake.callsOf('get_group_msg_history').some(call => call['group_id'] === Number(OTHER_GROUP)), 'the backfill of the added group')
    expect(h.logs.some(line => line.text.includes(`now recording group ${OTHER_GROUP}`))).toBe(true)
    expect(h.fake.connections).toBe(1)
  })

  it('stops recording a removed group but keeps what it stored until retention', async () => {
    const h = await bootRecorder({ config: { groups: [GROUP, OTHER_GROUP] } })
    await connected(h)
    h.fake.push(groupMessage(OTHER_GROUP, USER, '移除前'))
    await until(() => h.recorder.recent(OTHER_GROUP, ALL).length === 1, 'the first message')
    h.apply({ groups: [GROUP] })
    h.fake.push(groupMessage(OTHER_GROUP, USER, '移除后'))
    await until(() => h.recorder.groups().some(group => group.groupId === OTHER_GROUP && group.unlistedSeen === 1), 'the dropped message')
    expect(h.recorder.store.recent(OTHER_GROUP, { limit: 10 }).map(row => row.text)).toEqual(['移除前'])
    expect(h.logs.some(line => line.text.includes(`no longer recording group ${OTHER_GROUP}`))).toBe(true)
  })

  it('reconnects only when the address or the token variable changes', async () => {
    const h = await bootRecorder()
    await connected(h)
    expect(h.apply({ backfill: { enabled: false }, media: { images: false }, retention: { textDays: 7 }, honorRecall: false,
      reconnectQuietMs: 0 })).toMatchObject({ reconnect: false })
    expect(h.apply({ login: { enabled: true, url: 'http://127.0.0.1:3009', timeoutMs: 1000 } })).toMatchObject({ reconnect: false })
    await sleep(150)
    expect(h.fake.connections).toBe(1)
    const second = new FakeOneBot(TOKEN)
    await second.listen()
    second.handlers.set('get_login_info', () => ({ user_id: 99999 }))
    second.handlers.set('get_group_list', () => [])
    expect(h.apply({ url: second.url })).toMatchObject({ reconnect: true })
    await until(() => second.connections === 1, 'the new connection')
    await sleep(50)
    expect(h.fake.connections).toBe(1)
    await second.close()
  })

  it('keeps the last configuration across a restart, and records at once without waiting for DSH', async () => {
    const first = await bootRecorder({ config: { groups: [GROUP] } })
    await connected(first)
    await first.recorder.stop()
    const second = await bootRecorder({ fake: first.fake, dir: first.dir, config: false })
    await connected(second)
    expect(second.recorder.status().configRevision).toMatch(/^r\d+$/)
    second.fake.push(groupMessage(GROUP, USER, '重启后'))
    await until(() => second.recorder.recent(GROUP, ALL).some(m => m.text === '重启后'), 'a message after the restart')
  })

  it('reads the saved configuration only when it is usable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fork-qq-badcfg-'))
    mkdirSync(join(dir, 'data'), { recursive: true })
    writeFileSync(join(dir, 'data', 'recorder-config.json'), JSON.stringify({ revision: 'x', url: 'ws://192.168.9.9:1' }))
    const h = await bootRecorder({ dir, config: false })
    expect(h.recorder.status().configRevision).toBeNull()
    expect(h.logs.some(line => line.type === 'error' && line.text.includes('unusable'))).toBe(true)
    await h.recorder.stop()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('QqRecorder backfill is gentle', () => {
  const GROUPS = ['111111', '222222', '333333']
  async function boot(backfill: Record<string, unknown>, history: (params: Record<string, unknown>) => unknown = () => ({ messages: [] })) {
    const fake = new FakeOneBot(TOKEN)
    await fake.listen()
    const calls: Array<{ at: number; group: number; count: unknown }> = []
    fake.handlers.set('get_group_list', () => GROUPS.map(id => ({ group_id: Number(id), group_name: `群${id}`, member_count: 10 })))
    fake.handlers.set('get_group_msg_history', (params) => {
      calls.push({ at: Date.now(), group: Number(params['group_id']), count: params['count'] })
      return history(params)
    })
    const h = await bootRecorder({ fake,
      config: { groups: GROUPS, reconnectQuietMs: 0, backfill: { gapMs: 0, minIntervalMs: 0, ...backfill } } })
    await Promise.resolve()
    return Object.assign(h, { calls })
  }
  const called = (calls: Array<{ group: number }>) => calls.map(call => String(call.group))

  async function dropAndWait(h: Awaited<ReturnType<typeof boot>>, ms: number): Promise<void> {
    const connections = h.fake.connections
    h.fake.drop()
    await until(() => h.logs.some(line => line.text.includes('connection closed')), 'the drop')
    await sleep(100)
    h.recorder.now = () => Date.now() + ms
    await until(() => h.fake.connections === connections + 1, 'the reconnect', 6000)
  }

  it('requests no more messages than maxMessages in one page', async () => {
    const h = await boot({ maxMessages: 7 })
    await until(() => h.calls.length >= 3, 'the backfill')
    expect(h.calls.every(call => call.count === 7)).toBe(true)
  })

  it('pauses between two groups, with jitter on top', async () => {
    const h = await boot({ gapMs: 200 })
    await until(() => h.calls.length === 3, 'three groups', 8000)
    const gaps = h.calls.slice(1).map((call, index) => call.at - h.calls[index]!.at)
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(190)
    expect(Math.max(...gaps)).toBeLessThan(900)
  })

  it('catches up at most maxGroups groups per connection and continues with the others on the next one', async () => {
    const h = await boot({ maxGroups: 2 })
    await until(() => h.calls.length === 2, 'the first turn')
    await sleep(150)
    expect(called(h.calls)).toEqual(['111111', '222222'])
    expect(h.logs.some(line => line.text.includes('backfilling 2 of 3 group(s) now'))).toBe(true)
    await dropAndWait(h, 31 * MINUTE)
    await until(() => h.calls.length === 4, 'the second turn')
    expect(called(h.calls)).toEqual(['111111', '222222', '333333', '111111'])
  })

  it('fetches nothing after a reconnect that follows the previous drop closely, and again once it is long enough ago', { timeout: 20_000 }, async () => {
    const h = await boot({})
    await until(() => h.calls.length === 3, 'the first backfill')
    await dropAndWait(h, 0)
    await sleep(300)
    expect(h.calls).toHaveLength(3)
    expect(h.logs.some(line => line.text.includes('not backfilling this time'))).toBe(true)
    await dropAndWait(h, 31 * MINUTE)
    await until(() => h.calls.length === 6, 'the second backfill')
  })

  it('does not download the files of a backfilled message, but does of a live one', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('offline')))
    const image = [{ type: 'image', data: { url: 'https://multimedia.nt.qq.com.cn/a.png', file: 'a.png' } }]
    const old = groupMessage('111111', '10001', image, { message_id: 7001 })
    const fake = new FakeOneBot(TOKEN)
    await fake.listen()
    fake.handlers.set('get_group_list', () => [])
    fake.handlers.set('get_group_msg_history', () => ({ messages: [old] }))
    const h = await bootRecorder({ fake, fetch: fetch, config: { groups: ['111111'], reconnectQuietMs: 0 } })
    await until(() => h.recorder.store.recent('111111', { limit: 10 }).length === 1, 'the backfilled message')
    await sleep(200)
    expect(fetch).not.toHaveBeenCalled()
    h.fake.push(groupMessage('111111', '10001', image, { message_id: 7002 }))
    await until(() => fetch.mock.calls.length > 0, 'the live download attempt')
  })

  it('backfills what was missed, newest first, until it meets a stored message', async () => {
    const history = [1, 2, 3, 4, 5].map(n => groupMessage(GROUP, USER, `历史消息${n}`, { message_id: 9000 + n, message_seq: 100 + n, time: 1_700_000_000 + n }))
    const fake = new FakeOneBot(TOKEN)
    await fake.listen()
    fake.handlers.set('get_group_list', () => [])
    fake.handlers.set('get_group_msg_history', params => (params['message_seq'] === undefined ? { messages: history.slice(2) } : { messages: history.slice(0, 2) }))
    const h = await bootRecorder({ fake })
    // The log comes after the loop's last page, which repeats stored messages: the store holds all five one call before that.
    await until(() => h.logs.some(line => line.text.includes('backfilled 5 message(s)')), 'the backfill')
    expect(h.recorder.store.recent(GROUP, { limit: 10 }).map(m => m.text)).toEqual(['历史消息1', '历史消息2', '历史消息3', '历史消息4', '历史消息5'])
    const calls = fake.callsOf('get_group_msg_history')
    expect(calls.slice(0, 2)).toEqual([{ group_id: Number(GROUP), count: 20 }, { group_id: Number(GROUP), count: 17, message_seq: 103 }])
    expect(calls).toHaveLength(3)
  })

  it('does not call a group without history a failed backfill', async () => {
    const h = await boot({}, () => { throw new Error('消息undefined不存在') })
    await until(() => h.logs.some(line => line.text.includes('has no history to backfill')), 'the note')
    expect(h.logs.filter(line => line.text.includes('backfill of group'))).toEqual([])
  })
})

describe('a recorder restart does not repeat the connection work', () => {
  const seed = (dataDir: string, state: Record<string, number>) => {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'connection-state.json'), JSON.stringify(state))
  }
  const stateOf = (h: Booted) => JSON.parse(readFileSync(join(h.dataDir, 'connection-state.json'), 'utf8')) as { lastAliveAt?: number; lastGroupListAt?: number; lastBackfillAt?: number }
  async function boot(state?: Record<string, number>, over: Parameters<typeof recorderConfig>[1] = {}) {
    const dir = (await import('node:fs')).mkdtempSync(join((await import('node:os')).tmpdir(), 'fork-qq-restart-'))
    if (state !== undefined) seed(join(dir, 'data'), state)
    const fake = new FakeOneBot(TOKEN)
    await fake.listen()
    fake.handlers.set('get_group_list', () => [{ group_id: Number(GROUP), group_name: '技术群', member_count: 80 }])
    fake.handlers.set('get_group_msg_history', () => ({ messages: [] }))
    const h = await bootRecorder({ fake, dir, config: over })
    await connected(h)
    return h
  }

  it('fetches the group list and the history on a first start, and remembers when', async () => {
    const before = Date.now()
    const h = await boot()
    expect(h.fake.callsOf('get_group_list')).toHaveLength(1)
    expect(h.fake.callsOf('get_group_msg_history')).toHaveLength(1)
    expect(stateOf(h).lastAliveAt).toBeGreaterThanOrEqual(before)
    expect(stateOf(h).lastBackfillAt).toBeGreaterThanOrEqual(before)
  })

  it('skips the group list and the backfill when the last process was connected under ten minutes ago', async () => {
    const h = await boot({ lastAliveAt: Date.now() - MINUTE, lastGroupListAt: Date.now() - 5 * MINUTE })
    expect(h.fake.callsOf('get_login_info')).toHaveLength(1)
    expect(h.fake.callsOf('get_group_list')).toEqual([])
    expect(h.fake.callsOf('get_group_msg_history')).toEqual([])
    expect(h.logs.some(line => line.text.includes('was connected') && line.text.includes('not backfilling'))).toBe(true)
  })

  it('does both again once the last connection is older than reconnectQuietMs, and the list is older than an hour', async () => {
    const h = await boot({ lastAliveAt: Date.now() - 11 * MINUTE, lastGroupListAt: Date.now() - 120 * MINUTE })
    expect(h.fake.callsOf('get_group_list')).toHaveLength(1)
    expect(h.fake.callsOf('get_group_msg_history')).toHaveLength(1)
  })

  it('skips the backfill when the last one ran under thirty minutes ago, though the last connection is old', async () => {
    const old = Date.now() - 120 * MINUTE
    const h = await boot({ lastAliveAt: old, lastGroupListAt: old, lastBackfillAt: Date.now() - 10 * MINUTE })
    expect(h.fake.callsOf('get_group_list')).toHaveLength(1)
    expect(h.fake.callsOf('get_group_msg_history')).toEqual([])
  })

  it('never asks for the group list more than once an hour, even when the history is due', async () => {
    const h = await boot({ lastAliveAt: Date.now() - 11 * MINUTE, lastGroupListAt: Date.now() - 30 * MINUTE })
    expect(h.fake.callsOf('get_group_list')).toEqual([])
    expect(h.fake.callsOf('get_group_msg_history')).toHaveLength(1)
  })

  it('notes when the connection ended, so a restart right after a drop counts the drop', async () => {
    const h = await boot()
    const before = Date.now()
    h.fake.drop()
    await until(() => h.logs.some(line => line.text.includes('connection closed')), 'the drop')
    await until(() => (stateOf(h).lastAliveAt ?? 0) >= before, 'the note')
  })
})

describe('QqRecorder serves the pictures it saved', () => {
  const photo = (url = 'https://gchat.qpic.cn/a.png') => [{ type: 'text', data: { text: '看这个' } }, { type: 'image', data: { url, file: 'a.png' } }]
  const saved = async (h: Booted) => {
    h.fake.push(groupMessage(GROUP, USER, photo()))
    await until(() => h.recorder.store.mediaOf(1).some(m => m.localPath !== null), 'the picture')
    return h.recorder.recent(GROUP, ALL)[0]!.media[0]!
  }

  it('lists a message\'s media with a short stable reference, and says whether the file is held', async () => {
    const h = await bootRecorder({ fetch: vi.fn(async () => new Response(PNG)) })
    await connected(h)
    const item = await saved(h)
    expect(item).toMatchObject({ kind: 'image', saved: true })
    expect(item.ref).toMatch(/^m[0-9a-z]{1,12}$/)
    expect(mediaIdOf(item.ref)).toBe(h.recorder.store.mediaOf(1)[0]!.id)
    expect(mediaRef(1)).toBe('m1')
    expect(h.recorder.page(GROUP, undefined, 5).items[0]!.media).toEqual([item])
    expect(h.recorder.search('看这个', { limit: 5 })[0]!.media).toEqual([item])
    expect(h.recorder.lookup(GROUP, [rows(h)[0]!.messageId])[0]!.media).toEqual([item])
    expect(mediaIdOf('../x')).toBeUndefined()
    expect(mediaIdOf('m')).toBeUndefined()
  })

  it('hands out the file with its type and size, nothing fetched from QQ for it', async () => {
    const fetched = vi.fn(async () => new Response(PNG))
    const h = await bootRecorder({ fetch: fetched })
    await connected(h)
    const item = await saved(h)
    const before = fetched.mock.calls.length
    const file = await h.recorder.mediaFile(item.ref)
    expect(file.bytes).toEqual(PNG)
    expect(file.header).toEqual({ contentType: 'image/png', bytes: PNG.length, groupId: GROUP })
    expect(fetched.mock.calls).toHaveLength(before)
  })

  it('answers not-saved when images are off, when the download failed, after a recall, and for a group no longer recorded', async () => {
    const h = await bootRecorder({ fetch: vi.fn(async () => new Response(PNG)) })
    await connected(h)
    const item = await saved(h)
    h.apply({ media: { images: false } })
    await expect(h.recorder.mediaFile(item.ref)).rejects.toThrow('media.images is off')
    h.apply({ media: { images: true } })
    expect((await h.recorder.mediaFile(item.ref)).bytes).toEqual(PNG)
    h.apply({ groups: [OTHER_GROUP] })
    await expect(h.recorder.mediaFile(item.ref)).rejects.toBeInstanceOf(MediaNotSaved)
    h.apply({ groups: [GROUP] })
    await expect(h.recorder.mediaFile('mzzzzzz')).rejects.toBeInstanceOf(MediaNotSaved)
    await expect(h.recorder.mediaFile('nope')).rejects.toBeInstanceOf(RangeError)
    const event = groupMessage(GROUP, USER, photo(), { message_id: 424242 })
    h.fake.push(event)
    await until(() => h.recorder.lookup(GROUP, ['424242']).length === 1, 'the second picture')
    h.fake.push({ post_type: 'notice', notice_type: 'group_recall', group_id: Number(GROUP), message_id: 424242, user_id: Number(USER), operator_id: Number(USER) })
    await until(() => h.recorder.lookup(GROUP, ['424242'])[0]?.recalled === true, 'the recall')
    expect(h.recorder.lookup(GROUP, ['424242'])[0]!.media).toEqual([])
  })

  it('does not hold a picture of a backfilled message, so it is never served, and never fetches one for it', async () => {
    const fetched = vi.fn(async () => new Response(PNG))
    const old = groupMessage(GROUP, USER, photo(), { message_id: 8001 })
    const fake = new FakeOneBot(TOKEN)
    await fake.listen()
    fake.handlers.set('get_group_list', () => [])
    fake.handlers.set('get_group_msg_history', () => ({ messages: [old] }))
    const h = await bootRecorder({ fake, fetch: fetched })
    await until(() => h.recorder.lookup(GROUP, ['8001']).length === 1, 'the backfilled message')
    const [message] = h.recorder.lookup(GROUP, ['8001'])
    expect(message!.media[0]).toMatchObject({ kind: 'image', saved: false })
    expect(fetched).not.toHaveBeenCalled()
    await expect(h.recorder.mediaFile(message!.media[0]!.ref)).rejects.toThrow('not fetched for a backfilled message')
  })
})
