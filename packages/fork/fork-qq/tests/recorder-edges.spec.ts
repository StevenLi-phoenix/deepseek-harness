import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeOneBot, groupMessage } from './fake-onebot.ts'
import { TOKEN, bootRecorder, connected, recorderConfig, shutdown, sleep, until, type Booted } from './recorder-harness.ts'

const GROUP = '123456789'
const OTHER = '987654321'
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixel-data-0123456789')])
const ALL = { sinceMs: 0, limit: 100 }
const HOUR = 3_600_000

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(cleanups.splice(0).map(close => close()))
  // The token must never reach a log line.
  expect(await shutdown()).toEqual([])
})

const rows = (h: Booted, group = GROUP) => h.recorder.recent(group, ALL)

/** Wait for a condition by yielding to the event loop, for tests whose timers are faked. */
async function untilTurns(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

/** Fake the timers the recorder schedules with, and nothing else, so real sockets keep working. */
const fakeTimers = (): void => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }) }

/** A door answer for the fetch the recorder hands its login door. */
const doorAnswer = (login: string, extra: Record<string, unknown> = {}): Response => Response.json(
  { v: 1, napcat: 'up', login, phase: 'x', uin: null, nickname: null, qrUrl: null, error: null, at: 1, ...extra },
)

describe('QqRecorder lifecycle and configuration', () => {
  it('starts connecting once however many times it is started', async () => {
    const h = await bootRecorder()
    await connected(h)
    h.recorder.start()
    await sleep(60)
    expect(h.fake.connections).toBe(1)
  })

  it('logs and keeps running when the configuration cannot be saved', async () => {
    const h = await bootRecorder({ config: false, start: false })
    mkdirSync(join(h.dataDir, 'recorder-config.json.tmp'))
    expect(h.apply().revision).toMatch(/^r\d+$/)
    expect(h.logs.some(line => line.type === 'error' && line.text.startsWith('qq-recorder: could not save recorder-config.json'))).toBe(true)
    expect(existsSync(join(h.dataDir, 'recorder-config.json'))).toBe(false)
    expect(h.recorder.status().configRevision).toMatch(/^r\d+$/)
  })

  it('builds its login door with the injected fetch, or with the global one when none is given', async () => {
    const calls: string[] = []
    const injected = await bootRecorder({
      config: false, start: false,
      fetch: vi.fn(async (url: string) => { calls.push(url); return doorAnswer('online') }) as never,
    })
    injected.apply({ login: { enabled: true, url: 'http://127.0.0.1:9' } })
    expect(await injected.recorder.loginStatus({ fresh: true })).toMatchObject({ door: 'ok', state: 'online' })
    expect(calls).toEqual(['http://127.0.0.1:9/v1/login'])
    const plain = await bootRecorder({ config: false, start: false })
    plain.apply({ login: { enabled: true, url: 'http://127.0.0.1:9' } })
    expect(await plain.recorder.loginStatus({ fresh: true })).toMatchObject({ door: 'unreachable' })
  })

  it('refuses to serve a picture before any configuration has been pushed', async () => {
    const h = await bootRecorder({ config: false })
    await expect(h.recorder.mediaFile('m1')).rejects.toThrow('no configuration yet')
  })

  it('names a group by its known name when it is added to the list, and says when one leaves', async () => {
    const h = await bootRecorder({ config: { groups: [GROUP] } })
    h.fake.handlers.set('get_group_msg_history', () => ({ messages: [] }))
    await connected(h)
    h.apply({ groups: [GROUP, OTHER, '555666777'] })
    expect(h.logs.some(line => line.text === `qq-recorder: now recording group ${OTHER} (闲聊群)`)).toBe(true)
    expect(h.logs.some(line => line.text === 'qq-recorder: now recording group 555666777')).toBe(true)
    h.apply({ groups: [GROUP] })
    expect(h.logs.some(line => line.text.startsWith(`qq-recorder: no longer recording group ${OTHER}`))).toBe(true)
  })

  it('does not start a backfill for added groups when backfill is off', async () => {
    const h = await bootRecorder({ config: { groups: [GROUP], backfill: { enabled: false } } })
    await connected(h)
    h.apply({ groups: [GROUP, OTHER], backfill: { enabled: false } })
    await sleep(80)
    expect(h.fake.callsOf('get_group_msg_history')).toEqual([])
  })

  it('tells listeners about a configuration even when one of them throws', async () => {
    const h = await bootRecorder({ config: false })
    const seen: string[] = []
    h.recorder.subscribe(() => { throw new Error('listener boom') })
    h.recorder.subscribe((event) => { seen.push(event.type) })
    h.apply()
    expect(seen).toContain('status')
    expect(h.logs.some(line => line.type === 'debug' && line.text === 'qq-recorder: an event listener threw: listener boom')).toBe(true)
  })
})

describe('QqRecorder reads', () => {
  it('lists recorded groups first, then unlisted ones by traffic, and orders equals by name', async () => {
    const h = await bootRecorder({ config: { groups: [GROUP, OTHER, '555666777'] } })
    h.fake.handlers.set('get_group_list', () => [
      { group_id: 123456789, group_name: '技术群' }, { group_id: 987654321, group_name: '闲聊群' },
      { group_id: 777000111, group_name: '甲群' }, { group_id: 777000222, group_name: '乙群' },
    ])
    await connected(h)
    h.fake.push(groupMessage('777000111', '10001', 'a'))
    h.fake.push(groupMessage('777000222', '10001', 'b'))
    h.fake.push(groupMessage('777000222', '10002', 'c'))
    await until(() => h.recorder.status().counters.dropped === 3, 'the counts')
    const names = h.recorder.groups().map(group => [group.groupId, group.name, group.unlistedSeen] as const)
    const recorded = ['555666777', '技术群', '闲聊群'].sort((a, b) => a.localeCompare(b))
    expect(names.slice(0, 3).map(([, name]) => name)).toEqual(recorded)
    expect(names.slice(3)).toEqual([['777000222', '乙群', 2], ['777000111', '甲群', 1]])
    // A listed group the account never reported is named by its number.
    expect(h.recorder.groups().find(group => group.groupId === '555666777')).toMatchObject({ name: '555666777', memberCount: null, recorded: true })
  })

  it('narrows recent messages to one sender', async () => {
    const h = await bootRecorder()
    await connected(h)
    h.fake.push(groupMessage(GROUP, '10001', 'one'))
    h.fake.push(groupMessage(GROUP, '10002', 'two'))
    await until(() => rows(h).length === 2, 'both rows')
    expect(h.recorder.recent(GROUP, { ...ALL, userId: '10002' }).map(row => row.text)).toEqual(['two'])
  })

  it('answers nothing for a group that is not on the list, and ends a page that holds no messages', async () => {
    const h = await bootRecorder()
    await connected(h)
    h.fake.push(groupMessage(GROUP, '10001', 'one'))
    await until(() => rows(h).length === 1, 'the row')
    expect(h.recorder.page(OTHER, undefined, 10)).toEqual({ items: [], nextCursor: null })
    expect(h.recorder.lookup(OTHER, ['1'])).toEqual([])
    expect(h.recorder.members(OTHER)).toEqual([])
    expect(h.recorder.page(GROUP, undefined, 0)).toEqual({ items: [], nextCursor: null })
  })
})

describe('QqRecorder pictures it serves', () => {
  async function withPicture(config: Parameters<typeof bootRecorder>[0] = {}) {
    const h = await bootRecorder({ fetch: vi.fn(async () => new Response(PNG)), ...config })
    await connected(h)
    h.fake.push(groupMessage(GROUP, '10001', [{ type: 'image', data: { url: 'https://gchat.qpic.cn/a.png', file: 'a.png' } }]))
    await until(() => h.recorder.store.mediaOf(1).some(m => m.localPath !== null), 'the picture')
    const media = h.recorder.store.mediaOf(1)[0]!
    return { h, media, ref: rows(h)[0]!.media[0]!.ref }
  }

  it.each([
    ['a file that is not a picture', 'x.bin', undefined, 'not a picture a model can read'],
    ['a file that is gone', 'gone.png', undefined, 'the saved file is gone'],
    ['an empty file', 'empty.png', Buffer.alloc(0), 'larger than media.maxImageBytes'],
    ['a file over the size cap', 'big.png', Buffer.alloc(2000, 1), 'larger than media.maxImageBytes'],
  ])('refuses %s', async (_name, file, content, message) => {
    const { h, media, ref } = await withPicture({ config: { media: { maxImageBytes: 1024 } } })
    const path = join(h.dir, file)
    if (content !== undefined) writeFileSync(path, content)
    h.recorder.store.setMediaFile(media.id, { localPath: path, sha256: '0', bytes: 1 })
    await expect(h.recorder.mediaFile(ref)).rejects.toThrow(message)
  })

  it('says the picture was not downloaded while its download is still running', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const h = await bootRecorder({ fetch: vi.fn(async () => { await gate; return new Response(PNG) }) })
    cleanups.push(() => { release?.(); return Promise.resolve() })
    await connected(h)
    h.fake.push(groupMessage(GROUP, '10001', [{ type: 'image', data: { url: 'https://gchat.qpic.cn/a.png', file: 'a.png' } }]))
    await until(() => rows(h).length === 1, 'the row')
    await expect(h.recorder.mediaFile(rows(h)[0]!.media[0]!.ref)).rejects.toThrow('the image was not downloaded')
    release?.()
    await until(() => h.recorder.store.mediaOf(1).some(m => m.localPath !== null), 'the download')
  })

  it('keeps a download failure that is not an Error as its text', async () => {
    const h = await bootRecorder({ fetch: vi.fn(async () => { throw 'plain failure' }) })
    await connected(h)
    h.fake.push(groupMessage(GROUP, '10001', [{ type: 'image', data: { url: 'https://gchat.qpic.cn/a.png' } }]))
    await until(() => h.recorder.store.mediaOf(1).some(m => m.error !== null), 'the failure')
    expect(h.recorder.store.mediaOf(1)[0]!.error).toBe('plain failure')
    expect(h.logs.some(line => line.type === 'debug' && line.text.endsWith(': plain failure'))).toBe(true)
  })
})

describe('QqRecorder media kinds and budget', () => {
  it('lists video and file attachments by their kind without downloading them', async () => {
    const spy = vi.fn(async () => new Response(PNG))
    const h = await bootRecorder({ fetch: spy })
    await connected(h)
    h.fake.push(groupMessage(GROUP, '10001', [
      { type: 'video', data: { url: 'https://v.qq.com/a.mp4', file: 'a.mp4' } },
      { type: 'file', data: { name: 'notes.txt', file_id: 'f1' } },
    ]))
    await until(() => rows(h).length === 1, 'the row')
    expect(rows(h)[0]!.media.map(item => item.kind)).toEqual(['video', 'file'])
    await sleep(60)
    expect(spy).not.toHaveBeenCalled()
  })

  it('stops downloading at media.maxTotalBytes, says so once an hour, and skips voice too', async () => {
    const fetched = vi.fn(async () => new Response(Buffer.concat([PNG, Buffer.alloc(1500)])))
    const h = await bootRecorder({ fetch: fetched, config: { media: { maxTotalBytes: 1024 } } })
    h.fake.handlers.set('get_record', () => ({ base64: Buffer.from('ID3-audio-bytes').toString('base64') }))
    await connected(h)
    const image = (name: string) => groupMessage(GROUP, '10001', [{ type: 'image', data: { url: `https://gchat.qpic.cn/${name}.png`, file: `${name}.png` } }])
    h.fake.push(image('a'))
    await until(() => h.recorder.store.mediaOf(1).some(m => m.localPath !== null), 'the first download')
    h.fake.push(image('b'))
    h.fake.push(image('c'))
    h.fake.push(groupMessage(GROUP, '10001', [{ type: 'record', data: { file: 'v.amr' } }]))
    await until(() => rows(h).length === 4, 'the rows')
    await sleep(100)
    expect(fetched).toHaveBeenCalledTimes(1)
    expect(h.fake.callsOf('get_record')).toEqual([])
    expect(h.logs.filter(line => line.text.includes('reached media.maxTotalBytes (1024)'))).toHaveLength(1)
  })
})

describe('QqRecorder voice messages', () => {
  const voice = (data: Record<string, unknown>) => groupMessage(GROUP, '10001', [{ type: 'record', data }])

  it('does not fetch voice when voice downloads are off', async () => {
    const h = await bootRecorder({ config: { voice: { download: false } } })
    h.fake.handlers.set('get_record', () => ({ base64: 'AAAA' }))
    await connected(h)
    h.fake.push(voice({ file: 'v.amr' }))
    await until(() => rows(h).length === 1, 'the row')
    await sleep(60)
    expect(h.fake.callsOf('get_record')).toEqual([])
    expect(h.recorder.store.mediaOf(1)[0]).toMatchObject({ localPath: null, error: null })
  })

  it('falls back to the voice address on a QQ host when the protocol end cannot give the file', async () => {
    const fetched: string[] = []
    const h = await bootRecorder({
      fetch: vi.fn(async (url: string) => { fetched.push(url); return new Response('ID3-voice-bytes') }) as never,
    })
    h.fake.handlers.set('get_record', () => { throw new Error('no such record') })
    await connected(h)
    h.fake.push(voice({ file: 'v.amr', url: 'https://gchat.qpic.cn/v.mp3' }))
    await until(() => h.recorder.store.mediaOf(1).some(m => m.localPath !== null), 'the voice file')
    expect(fetched).toEqual(['https://gchat.qpic.cn/v.mp3'])
    expect(h.recorder.status().counters.voices).toBe(1)
    expect(h.logs.some(line => line.type === 'debug' && line.text.includes('get_record failed for message row 1: '))).toBe(true)
  })

  it('fetches a voice message with no file name straight from its address', async () => {
    const h = await bootRecorder({ fetch: vi.fn(async () => new Response('ID3-voice-bytes')) })
    await connected(h)
    h.fake.push(voice({ url: 'https://gchat.qpic.cn/v.mp3' }))
    await until(() => h.recorder.store.mediaOf(1).some(m => m.localPath !== null), 'the voice file')
    expect(h.fake.callsOf('get_record')).toEqual([])
  })

  it.each([
    ['an empty answer and no address', { base64: '' }, { file: 'v.amr' }, 'the protocol end gave no audio'],
    ['an address outside the allowed hosts', undefined, { file: 'v.amr', url: 'https://evil.example.com/v.mp3' }, 'the protocol end gave no audio'],
    ['audio over voice.maxBytes', { base64: Buffer.alloc(2000, 1).toString('base64') }, { file: 'v.amr' }, 'audio exceeds 1024 bytes'],
  ])('records why a voice message has no file: %s', async (_name, answer, data, error) => {
    const h = await bootRecorder({ config: { voice: { maxBytes: 1024 } } })
    h.fake.handlers.set('get_record', () => answer ?? {})
    await connected(h)
    h.fake.push(voice(data))
    await until(() => h.recorder.store.mediaOf(1).some(m => m.error !== null), 'the failure')
    expect(h.recorder.store.mediaOf(1)[0]).toMatchObject({ localPath: null, error })
  })
})

describe('QqRecorder events from the protocol end', () => {
  const messageEvent = (over: Record<string, unknown>): Record<string, unknown> => ({
    post_type: 'message', message_type: 'group', group_id: Number(GROUP), user_id: 10001, message_id: 7001,
    message: [{ type: 'text', data: { text: 'hello' } }], ...over,
  })

  it('ignores events that are neither messages nor notices, and notices it does not handle', async () => {
    const h = await bootRecorder()
    await connected(h)
    h.fake.push({ post_type: 'meta_event', meta_event_type: 'heartbeat' })
    h.fake.push({ post_type: 'notice', notice_type: 'group_increase', group_id: Number(GROUP) })
    h.fake.push(groupMessage(GROUP, '10001', 'marker'))
    await until(() => rows(h).length === 1, 'the marker')
    expect(h.recorder.status().counters).toMatchObject({ messages: 1, dropped: 0, private: 0 })
    expect(h.recorder.status().outage.botOfflineAt).toBeNull()
  })

  it('leaves a recall alone when honorRecall is off, and for unknown ids, unlisted groups, and a missing group', async () => {
    const h = await bootRecorder({ config: { honorRecall: false } })
    await connected(h)
    h.fake.push(groupMessage(GROUP, '10001', 'keep me', { message_id: 8001 }))
    await until(() => rows(h).length === 1, 'the row')
    h.fake.push({ post_type: 'notice', notice_type: 'group_recall', group_id: Number(GROUP), message_id: 8001 })
    await sleep(80)
    expect(rows(h)[0]!.text).toBe('keep me')
    h.apply({ honorRecall: true })
    h.fake.push({ post_type: 'notice', notice_type: 'group_recall', group_id: Number(GROUP), message_id: 424242 })
    h.fake.push({ post_type: 'notice', notice_type: 'group_recall', group_id: Number(OTHER), message_id: 8001 })
    h.fake.push({ post_type: 'notice', notice_type: 'group_recall' })
    h.fake.push(groupMessage(GROUP, '10001', 'marker'))
    await until(() => rows(h).length === 2, 'the marker')
    expect(rows(h)[0]!.text).toBe('keep me')
    expect(h.logs.some(line => line.text.includes('was recalled'))).toBe(false)
  })

  it('logs background work that fails instead of losing it', async () => {
    const h = await bootRecorder()
    await connected(h)
    vi.spyOn(h.recorder.store, 'recall').mockImplementation(() => { throw new Error('database locked') })
    h.fake.push({ post_type: 'notice', notice_type: 'group_recall', group_id: Number(GROUP), message_id: 1 })
    await until(() => h.logs.some(line => line.text === 'qq-recorder: background work failed: database locked'), 'the log line')
  })

  it('records a message by its sender object, leaves out what it lacks, and skips what cannot be recorded', async () => {
    const h = await bootRecorder()
    await connected(h)
    const base = Date.now()
    h.recorder.now = () => base
    h.fake.push(messageEvent({ user_id: undefined, sender: { user_id: 10005 }, message_id: 7002 }))
    h.fake.push(messageEvent({ message_id: 7003, message: undefined }))
    // Not recorded: no group, no sender, no message id, and the account's own words.
    h.fake.push(messageEvent({ group_id: undefined, message_id: 7004 }))
    h.fake.push(messageEvent({ user_id: undefined, message_id: 7005 }))
    h.fake.push(messageEvent({ message_id: undefined }))
    h.fake.push(messageEvent({ user_id: 99999, message_id: 7006 }))
    h.fake.push(groupMessage(GROUP, '10009', 'marker'))
    await until(() => rows(h).length === 3, 'the rows')
    expect(rows(h).map(row => [row.messageId, row.userId, row.text, row.nickname, row.card, row.at])).toEqual([
      [expect.stringMatching(/^\d+$/), '10009', 'marker', '昵称09', '名片09', expect.any(Number)],
      ['7002', '10005', 'hello', '', '', base],
      ['7003', '10001', '', '', '', base],
    ])
    expect(rows(h)[1]!.cursor).toMatch(/^c\d+$/)
  })

  it('names an unlisted group of unknown name by its number, and reports it once however often it writes', async () => {
    const h = await bootRecorder()
    await connected(h)
    h.fake.push(groupMessage('555555555', '10001', 'one'))
    h.fake.push(groupMessage('555555555', '10001', 'two'))
    await until(() => h.recorder.status().counters.dropped === 2, 'the drops')
    expect(h.logs.filter(line => line.text === 'qq-recorder: not recording group 555555555: it is not in groups')).toHaveLength(1)
  })
})

describe('QqRecorder group list and backfill', () => {
  it('names a group by its number when the account reports no name, and logs a group list that fails', async () => {
    const h = await bootRecorder({ config: { groups: [GROUP] } })
    h.fake.handlers.set('get_group_list', () => [{ group_id: 123456789 }])
    await connected(h)
    expect(h.recorder.groups().find(group => group.groupId === GROUP)).toMatchObject({ name: GROUP, memberCount: null })
    const failing = await bootRecorder()
    failing.fake.handlers.set('get_group_list', () => { throw new Error('rate limited') })
    await until(() => failing.logs.some(line => line.text.startsWith('qq-recorder: get_group_list failed:') && line.text.endsWith('rate limited')), 'the log line')
  })

  it('backfills only what is new, skips the account\'s own words, and stops at a page without sequence numbers', async () => {
    const h = await bootRecorder()
    h.fake.handlers.set('get_group_msg_history', () => ({
      messages: [
        groupMessage(GROUP, '10001', 'old one', { message_id: 9001, message_seq: undefined }),
        groupMessage(GROUP, '99999', 'my own', { message_id: 9002, message_seq: undefined }),
      ],
    }))
    await connected(h)
    await until(() => rows(h).length === 1, 'the backfilled row')
    expect(rows(h)[0]).toMatchObject({ messageId: '9001', text: 'old one' })
    expect(h.logs.some(line => line.text === `qq-recorder: backfilled 1 message(s) of group ${GROUP}`)).toBe(true)
    expect(h.fake.callsOf('get_group_msg_history')).toHaveLength(1)
  })

  it('treats a history answer without messages as the end of the history', async () => {
    const h = await bootRecorder()
    h.fake.handlers.set('get_group_msg_history', () => ({}))
    await connected(h)
    await sleep(60)
    expect(h.fake.callsOf('get_group_msg_history')).toHaveLength(1)
    expect(rows(h)).toEqual([])
  })

  it('does not fetch the group list when the connection drops while the account is still being identified', async () => {
    const h = await bootRecorder()
    h.fake.handlers.set('get_login_info', () => new Promise(() => {}))
    await until(() => h.fake.callsOf('get_login_info').length === 1, 'the identify call')
    h.fake.drop()
    await until(() => h.logs.some(line => line.text.startsWith('qq-recorder: get_login_info failed:')), 'the failure')
    await sleep(60)
    expect(h.fake.callsOf('get_group_list')).toEqual([])
  })

  it('has no account number when the protocol end reports none', async () => {
    const h = await bootRecorder()
    h.fake.handlers.set('get_login_info', () => ({}))
    await connected(h)
    expect(h.recorder.status().connection).toMatchObject({ state: 'connected', selfId: null })
    expect(h.logs.some(line => line.text === 'qq-recorder: logged in as ')).toBe(true)
  })

  it('stops a backfill that was waiting out its pause between two groups when the connection ends', async () => {
    const h = await bootRecorder({ config: { groups: [GROUP, OTHER], backfill: { gapMs: 400 } } })
    h.fake.handlers.set('get_group_msg_history', () => ({ messages: [] }))
    await until(() => h.fake.callsOf('get_group_msg_history').length === 1, 'the first history call')
    h.fake.drop()
    await until(() => h.logs.some(line => line.text.startsWith('qq-recorder: the protocol end connection closed')), 'the drop')
    await sleep(700)
    expect(h.fake.callsOf('get_group_msg_history')).toHaveLength(1)
  })

  it('leaves the other groups of a backfill alone when the connection ends during the first', async () => {
    const h = await bootRecorder({ config: { groups: [GROUP, OTHER] } })
    h.fake.handlers.set('get_group_msg_history', () => new Promise(() => {}))
    await until(() => h.fake.callsOf('get_group_msg_history').length === 1, 'the first history call')
    h.fake.drop()
    await until(() => h.logs.some(line => line.text.startsWith('qq-recorder: backfill of group')), 'the failed backfill')
    await sleep(80)
    expect(h.fake.callsOf('get_group_msg_history')).toHaveLength(1)
  })

  it('remembers the connection state only once when it cannot be saved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fork-qq-recorder-'))
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }); return Promise.resolve() })
    mkdirSync(join(dir, 'data', 'connection-state.json'), { recursive: true })
    const h = await bootRecorder({ dir })
    await connected(h)
    await h.recorder.stop()
    expect(h.logs.filter(line => line.type === 'error' && line.text.startsWith('qq-recorder: could not remember the connection state'))).toHaveLength(1)
  })
})

describe('QqRecorder connection', () => {
  async function deadEnd() {
    const probe = new FakeOneBot(TOKEN)
    await probe.listen()
    const url = probe.url
    const port = Number(new URL(url).port)
    await probe.close()
    return { url, port }
  }

  it('retries a refused connection and keeps the state it is in', async () => {
    const { url } = await deadEnd()
    const h = await bootRecorder({
      config: { url, login: { enabled: true } }, fetch: vi.fn(async () => doorAnswer('online')),
    })
    await until(() => h.logs.some(line => line.text === 'qq-recorder: reconnecting in 2 s (attempt 1)'), 'the first failure')
    // NapCat is logged in, so the recorder does not wait out the delay; the second refusal leaves it reconnecting.
    expect(await h.recorder.loginStatus({ fresh: true })).toMatchObject({ state: 'online' })
    await until(() => h.logs.some(line => line.text === 'qq-recorder: reconnecting in 4 s (attempt 2)'), 'the second failure')
    expect(h.recorder.status().connection).toMatchObject({ state: 'reconnecting', attempt: 2 })
  })

  it('starts the retry count over after a connection that stayed up for a minute', async () => {
    const { url, port } = await deadEnd()
    const h = await bootRecorder({ config: false })
    h.recorder.applyConfig(recorderConfig(url))
    await until(() => h.logs.some(line => line.text === 'qq-recorder: reconnecting in 2 s (attempt 1)'), 'the first failure')
    const revived = new FakeOneBot(TOKEN)
    revived.handlers.set('get_login_info', () => ({ user_id: 99999 }))
    revived.handlers.set('get_group_list', () => [])
    await new Promise<void>(resolve => revived.http.listen(port, '127.0.0.1', resolve))
    cleanups.push(() => revived.close())
    await until(() => h.recorder.status().connection.state === 'connected', 'the connection', 6000)
    h.recorder.now = () => Date.now() + 61_000
    revived.drop()
    await until(() => h.logs.filter(line => line.text.startsWith('qq-recorder: reconnecting in')).length === 2, 'the second wait')
    expect(h.logs.filter(line => line.text.startsWith('qq-recorder: reconnecting in')).map(line => line.text)).toEqual([
      'qq-recorder: reconnecting in 2 s (attempt 1)', 'qq-recorder: reconnecting in 2 s (attempt 1)',
    ])
  })
})

describe('QqRecorder login door', () => {
  it('shows an account whose OneBot socket is up as online with the number the protocol end reported, or none when it reported none', async () => {
    const h = await bootRecorder({ config: { login: { enabled: true } }, fetch: vi.fn(async () => doorAnswer('restarting')) })
    h.fake.handlers.set('get_login_info', () => { throw new Error('not ready') })
    await until(() => h.recorder.status().connection.state === 'connected', 'the connection')
    expect(await h.recorder.loginStatus({ fresh: true })).toMatchObject({ door: 'ok', state: 'online', uin: null, qrUrl: null })
  })

  it('names an unexplained refusal "unreachable" and a missing door "no door"', async () => {
    const dead = 'ws://127.0.0.1:9'
    const asked = await bootRecorder({
      config: { url: dead, login: { enabled: true } },
      fetch: vi.fn(async () => doorAnswer('qr', { refreshed: false })),
    })
    expect(await asked.recorder.refreshLogin()).toMatchObject({ refreshed: false, reason: 'unreachable' })
    expect(asked.logs.some(line => line.text.includes('not done: unreachable'))).toBe(true)
    const none = await bootRecorder({ config: { url: dead } })
    expect(await none.recorder.refreshLogin()).toMatchObject({ refreshed: false, reason: null })
    expect(none.logs.some(line => line.text.includes('not done: no door'))).toBe(true)
  })

  it('lets the later of two overlapping fresh reads keep its place as the one in flight', async () => {
    const gates: Array<() => void> = []
    const h = await bootRecorder({
      config: { url: 'ws://127.0.0.1:9', login: { enabled: true } },
      fetch: vi.fn(() => new Promise<Response>((resolve) => { gates.push(() => { resolve(doorAnswer('qr')) }) })),
    })
    const first = h.recorder.loginStatus({ fresh: true })
    const second = h.recorder.loginStatus({ fresh: true })
    await until(() => gates.length === 2, 'both door calls')
    gates[0]!()
    expect(await first).toMatchObject({ state: 'qr' })
    // A shared (not fresh) read still joins the second call, which is the one in flight.
    const shared = h.recorder.loginStatus()
    gates[1]!()
    expect(await second).toMatchObject({ state: 'qr' })
    expect(await shared).toMatchObject({ state: 'qr' })
    expect(gates).toHaveLength(2)
  })
})

describe('QqRecorder retention', () => {
  const OLD = 1_000_000

  async function withOldPicture(config: NonNullable<NonNullable<Parameters<typeof bootRecorder>[0]>['config']>) {
    const h = await bootRecorder({ fetch: vi.fn(async () => new Response(PNG)), config })
    await connected(h)
    h.fake.push(groupMessage(GROUP, '10001', [{ type: 'image', data: { url: 'https://gchat.qpic.cn/a.png', file: 'a.png' } }], { time: OLD }))
    await until(() => h.recorder.store.mediaOf(1).some(m => m.localPath !== null), 'the picture')
    return { h, path: h.recorder.store.mediaOf(1)[0]!.localPath! }
  }

  it('deletes old messages and the files they held when only text retention is on', async () => {
    const { h, path } = await withOldPicture({ media: { retainDays: 0 }, retention: { textDays: 30 } })
    await h.recorder.prune()
    expect(existsSync(path)).toBe(false)
    expect(rows(h)).toEqual([])
    expect(h.logs.some(line => line.text === 'qq-recorder: deleted 1 message(s) older than 30 day(s) and 1 file(s)')).toBe(true)
  })

  it('removes old downloads when only media retention is on, and logs nothing when there is nothing to remove', async () => {
    const { h, path } = await withOldPicture({ media: { retainDays: 30 }, retention: { textDays: 0 } })
    await h.recorder.prune()
    expect(existsSync(path)).toBe(false)
    expect(rows(h)).toHaveLength(1)
    expect(h.logs.filter(line => line.text.startsWith('qq-recorder: removed 1 download(s)'))).toHaveLength(1)
    await h.recorder.prune()
    expect(h.logs.filter(line => line.text.startsWith('qq-recorder: removed'))).toHaveLength(1)
  })

  it('keeps recent messages when nothing is old enough', async () => {
    const h = await bootRecorder()
    await connected(h)
    h.fake.push(groupMessage(GROUP, '10001', 'fresh', { time: Math.floor(Date.now() / 1000) }))
    await until(() => rows(h).length === 1, 'the row')
    await h.recorder.prune()
    expect(rows(h)).toHaveLength(1)
    expect(h.logs.some(line => line.text.includes('deleted'))).toBe(false)
  })
})

describe('QqRecorder scheduled upkeep', () => {
  it('runs its upkeep without error and without a configuration', async () => {
    fakeTimers()
    const h = await bootRecorder({ config: false })
    await untilTurns(() => h.recorder.status().connection.state === 'waiting-config', 'the wait for a configuration')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.logs.filter(line => line.type === 'error')).toEqual([])
    expect(h.recorder.status().connection.state).toBe('waiting-config')
  })

  it('refreshes the group list, prunes, reports traffic, and notes that it is alive', async () => {
    fakeTimers()
    const h = await bootRecorder()
    await untilTurns(() => h.logs.some(line => line.text.includes('logged in as')), 'the login')
    await untilTurns(() => h.fake.callsOf('get_group_list').length === 1, 'the first group list')
    h.fake.push(groupMessage(GROUP, '10001', 'listed'))
    h.fake.push(groupMessage(OTHER, '10001', 'unlisted'))
    await untilTurns(() => h.recorder.status().counters.messages === 1 && h.recorder.status().counters.dropped === 1, 'the counts')
    const base = Date.now()
    h.recorder.now = () => base + 2 * HOUR
    await vi.advanceTimersByTimeAsync(30_000)
    await untilTurns(() => h.fake.callsOf('get_group_list').length === 2, 'the second group list')
    await untilTurns(() => h.logs.some(line => line.text.includes('since the last report')), 'the report')
    expect(h.logs.some(line => line.text.startsWith('qq-recorder: messages seen per unlisted group') && line.text.endsWith(`${OTHER} 闲聊群 1`))).toBe(true)
    expect(h.logs.some(line => line.text.includes('1 message(s) recorded, 0 image(s) and 0 voice(s) saved, 1 from unlisted groups dropped'))).toBe(true)
    h.recorder.now = () => base + 5 * HOUR
    await vi.advanceTimersByTimeAsync(60_000)
    const state = JSON.parse(readFileSync(join(h.dataDir, 'connection-state.json'), 'utf8')) as { lastAliveAt: number }
    expect(state.lastAliveAt).toBe(base + 5 * HOUR)
    // Nothing new arrived: the next report is silent, though an unlisted group was seen earlier.
    const reports = () => h.logs.filter(line => line.text.includes('since the last report')).length
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    for (let turn = 0; turn < 20; turn += 1) await new Promise<void>(resolve => setImmediate(resolve))
    expect(reports()).toBe(1)
  })

  it('reports a failure of its upkeep and carries on, and writes no alive mark while offline', async () => {
    fakeTimers()
    const h = await bootRecorder({ secrets: {} })
    await untilTurns(() => h.recorder.status().connection.state === 'waiting-token', 'the token check')
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(existsSync(join(h.dataDir, 'connection-state.json'))).toBe(false)
    vi.spyOn(h.recorder.store, 'pruneMessages').mockImplementation(() => { throw new Error('disk full') })
    h.recorder.now = () => Date.now() + 7 * HOUR
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await untilTurns(() => h.logs.some(line => line.text === 'qq-recorder: scheduled work failed: disk full'), 'the failure')
    expect(h.logs.filter(line => line.type === 'error' && line.text.startsWith('qq-recorder: scheduled work failed'))).toHaveLength(1)
  })
})
