import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBiliReader } from '../src/bili.ts'
import { biliPairs, pickForRun, qqPairs, screenPairs, StyleCollector, type Accepted, type BiliComment, type BiliReader, type QqMessage, type QqSource } from '../src/collect.ts'
import { StyleStore } from '../src/store.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }) }))
})

const T0 = 1_761_900_000_000
let seq = 0
const msg = (userId: string, text: string, at: number, extra: Partial<QqMessage> = {}): QqMessage => ({
  messageId: String(++seq), userId, at, text, replyTo: null, kinds: 'text', card: '', nickname: `nick${userId}`, ...extra,
})
const rules = { maxChars: 30, identityMarkers: [], blocklist: [] }

describe('qqPairs', () => {
  it('pairs a quoting reply with what it quotes and strips QQ\'s mention of the quoted member', () => {
    const a = msg('1001', '今晚开黑吗', T0)
    const b = msg('1002', '@1001 来', T0 + 5 * 60_000, { replyTo: a.messageId, kinds: 'reply,at,text' })
    expect(qqPairs('g1', [a, b], 60_000)).toEqual([{ source: 'qq', owner: false, key: 'qq:g1', how: 'reply', at: b.at, prompt: '今晚开黑吗', reply: '来' }])
  })

  it('takes an unquoted answer only inside a back-and-forth within the gap', () => {
    const a = msg('1', '吃了吗', T0)
    const b = msg('2', '吃了', T0 + 10_000)
    const c = msg('1', '吃的啥', T0 + 20_000)
    const pairs = qqPairs('g', [a, b, c], 60_000)
    expect(pairs.map(pair => ('reason' in pair ? pair.reason : `${pair.prompt}->${pair.reply}`))).toEqual(['吃了吗->吃了', '吃了->吃的啥'])
    // Two lines by different members with no alternation are two conversations.
    expect(qqPairs('g', [msg('1', '收到', T0), msg('2', '四皇的海战', T0 + 5000)], 60_000)).toEqual([])
    // Too far apart.
    expect(qqPairs('g', [msg('1', '在吗', T0), msg('2', '在', T0 + 120_000), msg('1', '好', T0 + 130_000)], 60_000).filter(pair => !('reason' in pair) && pair.reply === '在')).toEqual([])
  })

  it('reports the quoted message missing, the same speaker, and media', () => {
    const lone = msg('1', '好', T0, { replyTo: 'gone' })
    const self = msg('1', '前面', T0)
    const selfReply = msg('1', '补充', T0 + 1000, { replyTo: self.messageId })
    const pic = msg('2', '[图片]', T0 + 2000, { kinds: 'image' })
    const toPic = msg('3', '好看', T0 + 3000, { replyTo: pic.messageId, kinds: 'reply,text' })
    const reasons = qqPairs('g', [lone, self, selfReply, pic, toPic], 1).map(pair => ('reason' in pair ? pair.reason : 'pair'))
    expect(reasons).toEqual(['parent-missing', 'same-speaker', 'media'])
  })
})

describe('qqPairs media on the reply side', () => {
  it('refuses a quoting reply that is a picture, after the quoted text passed', () => {
    const question = msg('1', '看看这个', T0)
    const picture = msg('2', '[图片]', T0 + 1000, { replyTo: question.messageId, kinds: 'reply,image' })
    expect(qqPairs('g', [question, picture], 60_000)).toEqual([{ reason: 'media' }])
  })
})

describe('biliPairs', () => {
  const OWNER = 401
  const CAT = 402
  const c = (rpid: number, mid: number, text: string, parent: number, gate?: boolean): BiliComment => ({
    rpid, mid, ctime: T0 / 1000, root: 1, parent, text, ...gate === undefined ? {} : { gate },
  })
  const ids = { ownerMid: OWNER, ownMids: new Set([OWNER, CAT]) }

  it('marks the owner\'s hand-written reply as the owner\'s and a viewer exchange as not, both from bili', () => {
    const thread = { root: c(1, 7, '这期好看', 0), replies: [c(2, OWNER, '谢谢喜欢', 1, false), c(3, 8, '回复 @路人 :同感[doge]', 1)] }
    expect(biliPairs(thread, ids)).toEqual([
      { source: 'bili', owner: true, key: 'bili:1', how: 'reply', at: T0, prompt: '这期好看', reply: '谢谢喜欢' },
      { source: 'bili', owner: false, key: 'bili:1', how: 'reply', at: T0, prompt: '这期好看', reply: '同感' },
    ])
  })

  it('never takes the agent\'s words: the cat\'s account, the Gate, or the owner\'s account when bili-svc does not say who wrote it', () => {
    const thread = { root: c(1, 7, '这期好看', 0), replies: [c(2, CAT, '喵', 1), c(3, OWNER, '谢谢', 1, true), c(4, OWNER, '谢谢', 1), c(5, 9, '对', 4)] }
    expect(biliPairs(thread, ids)).toEqual([{ reason: 'own-account' }, { reason: 'own-account' }, { reason: 'owner-unverified' }, { reason: 'owner-unverified' }])
  })
})

describe('biliPairs threads without a root, and exchanges that cannot be paired', () => {
  const c = (rpid: number, mid: number, text: string, root: number, parent: number): BiliComment =>
    ({ rpid, mid, ctime: T0 / 1000, root, parent, text })
  const ids = { ownerMid: null, ownMids: new Set<number>() }

  it('keys a thread by the root its first reply names when the root comment is not stored, and answers to the root when a reply has no parent', () => {
    const pairs = biliPairs({ root: null, replies: [c(2, 7, '路过', 1, 0)] }, ids)
    expect(pairs).toEqual([{ reason: 'parent-missing' }])
    const withRoot = biliPairs({ root: c(1, 8, '这期好看', 0, 0), replies: [c(2, 7, '同感', 1, 0)] }, ids)
    expect(withRoot).toEqual([{ source: 'bili', owner: false, key: 'bili:1', how: 'reply', at: T0, prompt: '这期好看', reply: '同感' }])
    expect(biliPairs({ root: null, replies: [] }, ids)).toEqual([])
  })

  it('refuses a reply to a comment that is missing, to itself, and by the same viewer', () => {
    const thread = { root: c(1, 8, '这期好看', 0, 0), replies: [c(2, 7, '嗯', 1, 99), c(3, 7, '自己', 1, 3), c(4, 8, '补充', 1, 1)] }
    expect(biliPairs(thread, ids)).toEqual([{ reason: 'parent-missing' }, { reason: 'parent-missing' }, { reason: 'same-speaker' }])
  })
})

describe('screenPairs and pickForRun', () => {
  const pair = (key: string, how: 'reply' | 'next', at: number, reply: string, owner = false): Accepted => ({ source: owner ? 'bili' : 'qq', owner, key, how, at, prompt: '在吗', reply, id: reply })

  it('counts refusals by reason, folds duplicates, and drops old exchanges', () => {
    const { accepted, filtered } = screenPairs([
      { source: 'qq', owner: false, key: 'qq:g', how: 'reply', at: T0, prompt: '在吗', reply: '在' },
      { source: 'qq', owner: false, key: 'qq:h', how: 'reply', at: T0, prompt: '在吗', reply: '在' },
      { source: 'qq', owner: false, key: 'qq:g', how: 'reply', at: T0 - 100, prompt: '在吗', reply: '不在' },
      { source: 'qq', owner: false, key: 'qq:g', how: 'reply', at: T0, prompt: '看 www.x.com', reply: '好' },
      { reason: 'media' },
    ], rules, T0 - 10)
    expect(accepted.map(item => item.reply)).toEqual(['在'])
    expect(filtered).toMatchObject({ duplicate: 1, old: 1, link: 1, media: 1, mention: 0 })
  })

  it('puts the owner first, then replies before neighbours, round-robin over groups with a cap per group', () => {
    const picked = pickForRun([
      pair('qq:a', 'next', T0 + 9, 'a-next'),
      pair('qq:a', 'reply', T0 + 1, 'a-r1'),
      pair('qq:a', 'reply', T0 + 2, 'a-r2'),
      pair('qq:a', 'reply', T0 + 3, 'a-r3'),
      pair('qq:b', 'reply', T0 + 1, 'b-r1'),
      pair('bili:1', 'reply', T0, 'owner', true),
    ], { max: 4, perKey: 2 })
    expect(picked.map(item => item.reply)).toEqual(['owner', 'a-r3', 'b-r1', 'a-r2'])
  })

  it('puts the owner\'s newest exchange first, and leaves the prompt out of an exchange that has none', () => {
    const lone = { ...pair('bili:2', 'reply', T0 + 5, '新的', true), prompt: '' }
    const picked = pickForRun([pair('bili:1', 'reply', T0, '旧的', true), lone], { max: 4, perKey: 2 })
    expect(picked.map(item => item.reply)).toEqual(['新的', '旧的'])
    expect(picked[0]).not.toHaveProperty('prompt')
    expect(picked[1]).toMatchObject({ prompt: '在吗', origin: { platform: 'bili', groups: 1, speakers: 2, days: 1 } })
  })
})

describe('createBiliReader', () => {
  it('reads accounts, comments, and a thread with the bearer token and drops malformed comments', async () => {
    const calls: Array<{ url: string; auth: string | null }> = []
    const answers: Record<string, unknown> = {
      '/v1/status': { accounts: [{ id: 'maodeng', mid: 401 }, { id: 'maomao', mid: 402 }, { mid: 5 }] },
      '/v1/comments': { comments: [{ rpid: 10, mid: 7, ctime: 1, root: 0, parent: 0, untrusted: { text: '好看', uname: 'x' } }, { rpid: 'bad' }] },
      '/v1/comments/10/thread': { root: { rpid: 10, mid: 7, ctime: 1, parent: 0, untrusted: { text: '好看' } }, replies: [{ rpid: 11, mid: 401, ctime: 2, parent: 10, gate: false, untrusted: { text: '谢谢' } }] },
    }
    const fetch: typeof globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
      const path = new URL(href).pathname
      calls.push({ url: href, auth: new Headers(init?.headers).get('authorization') })
      return Response.json(answers[path])
    })
    const reader = createBiliReader({ baseUrl: 'http://127.0.0.1:8097', token: 'tok', timeoutMs: 1000, fetch })
    expect(await reader.accounts()).toEqual([{ id: 'maodeng', mid: 401 }, { id: 'maomao', mid: 402 }])
    expect(await reader.comments(100)).toEqual([{ rpid: 10, mid: 7, ctime: 1, root: 0, parent: 0, text: '好看' }])
    expect((await reader.thread(10)).replies).toEqual([{ rpid: 11, mid: 401, ctime: 2, root: 0, parent: 10, text: '谢谢', gate: false }])
    expect(calls.map(call => call.auth)).toEqual(['Bearer tok', 'Bearer tok', 'Bearer tok'])
    expect(calls[1]!.url).toBe('http://127.0.0.1:8097/v1/comments?unreplied=0&limit=100')
  })

  it('fails on a non-200 answer', async () => {
    const fetch: typeof globalThis.fetch = async () => new Response('{}', { status: 403 })
    await expect(createBiliReader({ baseUrl: 'http://x', token: 't', timeoutMs: 1000, fetch }).accounts()).rejects.toThrow(/HTTP 403 for \/v1\/status/u)
  })
})

describe('StyleCollector', () => {
  async function setup(options: { qq?: QqSource; bili?: BiliReader | 'no-token'; review?: 'optional' | 'required' } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'speaking-style-collect-'))
    dirs.push(dir)
    const store = new StyleStore(join(dir, 'samples.jsonl'), { maxActive: 60, maxOwner: 20, maxPending: 40, maxTombstones: 100 })
    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() }
    const collector = new StyleCollector({
      store, logger, stateFile: join(dir, 'state.json'), now: () => T0 + 3_600_000,
      settings: {
        rules, maxAgeMs: 30 * 86_400_000, perRun: 15, perKey: 3, review: options.review ?? 'optional',
        qq: { enabled: true, windowHours: 26, maxMessages: 2000, gapMs: 60_000, settleMs: 10 * 60_000 },
        bili: { enabled: true, ownerAccount: 'maodeng', comments: 100, maxThreads: 12 },
      },
      qq: () => options.qq,
      bili: () => Promise.resolve(options.bili ?? 'no-token'),
    })
    return { dir, store, logger, collector }
  }

  const a = msg('1', '周末去哪', T0)
  const b = msg('2', '@1 宅着', T0 + 60_000, { replyTo: a.messageId, kinds: 'reply,at,text' })
  // Newer than the settle time: waits for the next run.
  const fresh = msg('3', '@1 我也宅', T0 + 3_600_000 - 60_000, { replyTo: a.messageId, kinds: 'reply,at,text' })
  const qq: QqSource = {
    groupOverview: () => Promise.resolve([{ groupId: '1', recorded: true }, { groupId: '2', recorded: false }]),
    recentMessages: groupId => Promise.resolve(groupId === '1' ? [a, b, fresh] : [msg('9', '不该读到', T0)]),
  }

  it('stores accepted exchanges, reports counts by reason, logs no text at info, and keeps state', async () => {
    const bili: BiliReader = {
      accounts: () => Promise.resolve([{ id: 'maodeng', mid: 401 }, { id: 'maomao', mid: 402 }]),
      comments: () => Promise.resolve([{ rpid: 20, mid: 7, ctime: T0 / 1000, root: 0, parent: 0, text: '更新了' }]),
      thread: rpid => Promise.resolve({ root: { rpid, mid: 7, ctime: T0 / 1000, root: 0, parent: 0, text: '更新了' }, replies: [{ rpid: 21, mid: 401, ctime: T0 / 1000, root: 20, parent: 20, text: '刚剪完', gate: false }] }),
    }
    const { store, logger, collector, dir } = await setup({ qq, bili })
    const report = await collector.run('manual')
    expect(report).toMatchObject({ seen: 2, accepted: 2, added: 2, qq: { status: 'ok', groups: 1, messages: 2 }, bili: { status: 'ok', comments: 1, threads: 1 }, bySource: { qq: 1, 'bili-owner': 1 } })
    expect((await store.live()).map(record => [record.source, record.owner, record.prompt, record.reply])).toEqual(expect.arrayContaining([['qq', false, '周末去哪', '宅着'], ['bili', true, '更新了', '刚剪完']]))
    const info = JSON.stringify(logger.info.mock.calls)
    expect(info).toMatch(/manual run: 2 exchanges seen/u)
    expect(info).not.toContain('宅着')
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as { lastRun: { added: number }; threads: Record<string, unknown> }
    expect(state.lastRun.added).toBe(2)
    expect(typeof state.threads['20']).toBe('number')
    // A second run reads no thread again and adds nothing new.
    const again = await collector.run('schedule')
    expect(again).toMatchObject({ added: 0, bili: { threads: 0 }, filtered: { duplicate: 1 } })
  })

  it('reports a missing token and an unreachable bili-svc without failing the run', async () => {
    const { collector, logger } = await setup({ qq })
    expect((await collector.run('manual')).bili.status).toBe('no-token')
    const broken: BiliReader = { accounts: () => Promise.reject(new Error('connect ECONNREFUSED')), comments: () => Promise.resolve([]), thread: () => Promise.reject(new Error('x')) }
    const second = await setup({ qq, bili: broken })
    const report = await second.collector.run('manual')
    expect(report.bili).toMatchObject({ status: 'unavailable', error: 'connect ECONNREFUSED' })
    expect(report.added).toBe(1)
    expect(logger.warn).not.toHaveBeenCalled()
    expect(second.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Bilibili collection failed/u))
  })

  it('reports QQ as unavailable and goes on with the other sources while the recorder is down', async () => {
    const down: QqSource = { groupOverview: () => Promise.reject(new Error('The QQ recorder is not running')), recentMessages: () => Promise.resolve([]) }
    const { collector, logger } = await setup({ qq: down })
    const report = await collector.run('manual')
    expect(report.qq).toMatchObject({ status: 'unavailable', groups: 0, messages: 0 })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/could not read QQ: The QQ recorder is not running/u))
  })

  it('stores strangers\' samples as pending under review required', async () => {
    const { store, collector } = await setup({ qq, review: 'required' })
    await collector.run('manual')
    expect((await store.live()).map(record => record.status)).toEqual(['pending'])
  })

  it('shares a run in progress', async () => {
    const { collector } = await setup({ qq })
    const first = collector.run('manual')
    expect(collector.busy).toBe(true)
    expect(collector.run('schedule')).toBe(first)
    await first
    expect(collector.busy).toBe(false)
  })

  it('reports QQ as unavailable when the observer is not mounted, and when it fails with something that is not an Error', async () => {
    const unmounted = await setup({})
    expect((await unmounted.collector.run('manual')).qq).toEqual({ status: 'unavailable', groups: 0, messages: 0 })
    const closing: QqSource = { groupOverview: async () => { throw 'socket closed' }, recentMessages: () => Promise.resolve([]) }
    const { collector, logger } = await setup({ qq: closing })
    expect((await collector.run('manual')).qq.status).toBe('unavailable')
    expect(logger.warn).toHaveBeenCalledWith('speaking-style: could not read QQ: socket closed')
  })

  it('reports an unreachable bili-svc that fails with something that is not an Error', async () => {
    const broken: BiliReader = { accounts: async () => { throw 'refused' }, comments: () => Promise.resolve([]), thread: () => Promise.reject(new Error('x')) }
    const { collector } = await setup({ qq, bili: broken })
    expect((await collector.run('manual')).bili).toMatchObject({ status: 'unavailable', error: 'refused' })
  })

  it('reads each thread through its newest stored comment, newest thread first, skips threads read since, and forgets old ones', async () => {
    const C = T0 / 1000
    const threadsAsked: number[] = []
    const bili: BiliReader = {
      accounts: () => Promise.resolve([{ id: 'other', mid: null }, { id: 'maomao', mid: 5 }]),
      comments: () => Promise.resolve([
        { rpid: 20, mid: 7, ctime: C, root: 0, parent: 0, text: '一' },
        { rpid: 22, mid: 7, ctime: C - 10, root: 20, parent: 20, text: '更早的回复' },
        { rpid: 21, mid: 7, ctime: C + 10, root: 20, parent: 20, text: '更晚的回复' },
        { rpid: 30, mid: 7, ctime: C + 5, root: 0, parent: 0, text: '二' },
        { rpid: 40, mid: 7, ctime: C + 1, root: 0, parent: 0, text: '三' },
      ]),
      thread: (rpid) => {
        threadsAsked.push(rpid)
        return Promise.resolve({
          root: { rpid: 20, mid: 7, ctime: C, root: 0, parent: 0, text: '这期好看' },
          replies: rpid === 21 ? [{ rpid: 21, mid: 5, ctime: C, root: 20, parent: 20, text: '喵' }] : [],
        })
      },
    }
    const { collector, dir } = await setup({ qq, bili })
    const nowSeconds = Math.floor((T0 + 3_600_000) / 1000)
    await writeFile(join(dir, 'state.json'), JSON.stringify({ threads: { 40: nowSeconds + 10, 99: nowSeconds - 91 * 86_400, 98: nowSeconds - 10 } }))
    const report = await collector.run('manual')
    expect(threadsAsked).toEqual([21, 30])
    expect(report.bili).toEqual({ status: 'ok', comments: 5, threads: 2 })
    expect(report.filtered).toMatchObject({ 'own-account': 1 })
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as { threads: Record<string, number> }
    expect(state.threads).toEqual({ 20: nowSeconds, 30: nowSeconds, 40: nowSeconds + 10, 98: nowSeconds - 10 })
  })

  it('recalls the last run from the state file, and starts clean from a state file it cannot use', async () => {
    const { collector, dir } = await setup({ qq })
    const lastRun = { at: 1, ms: 2, trigger: 'schedule', qq: { status: 'off', groups: 0, messages: 0 }, bili: { status: 'off', comments: 0, threads: 0 }, seen: 0, accepted: 0, added: 0, retired: 0, filtered: {}, bySource: {} }
    await writeFile(join(dir, 'state.json'), JSON.stringify({ threads: 'broken', lastRun }))
    expect(await collector.lastRun()).toEqual(lastRun)
    const second = await setup({ qq })
    await writeFile(join(second.dir, 'state.json'), JSON.stringify({ threads: {} }))
    expect(await second.collector.lastRun()).toBeUndefined()
    const third = await setup({ qq })
    await writeFile(join(third.dir, 'state.json'), '{torn')
    expect(await third.collector.lastRun()).toBeUndefined()
  })
})
