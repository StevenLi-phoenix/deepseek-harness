import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
    expect(qqPairs('g1', [a, b], 60_000)).toEqual([{ source: 'qq-group', key: 'qq:g1', how: 'reply', at: b.at, prompt: '今晚开黑吗', reply: '来' }])
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

describe('biliPairs', () => {
  const OWNER = 401
  const CAT = 402
  const c = (rpid: number, mid: number, text: string, parent: number, gate?: boolean): BiliComment => ({
    rpid, mid, ctime: T0 / 1000, root: 1, parent, text, ...gate === undefined ? {} : { gate },
  })
  const ids = { ownerMid: OWNER, ownMids: new Set([OWNER, CAT]) }

  it('labels the owner\'s hand-written reply owner-bili and a viewer exchange bili-viewer', () => {
    const thread = { root: c(1, 7, '这期好看', 0), replies: [c(2, OWNER, '谢谢喜欢', 1, false), c(3, 8, '回复 @路人 :同感[doge]', 1)] }
    expect(biliPairs(thread, ids)).toEqual([
      { source: 'owner-bili', key: 'bili:1', how: 'reply', at: T0, prompt: '这期好看', reply: '谢谢喜欢' },
      { source: 'bili-viewer', key: 'bili:1', how: 'reply', at: T0, prompt: '这期好看', reply: '同感' },
    ])
  })

  it('never takes the agent\'s words: the cat\'s account, the Gate, or the owner\'s account when bili-svc does not say who wrote it', () => {
    const thread = { root: c(1, 7, '这期好看', 0), replies: [c(2, CAT, '喵', 1), c(3, OWNER, '谢谢', 1, true), c(4, OWNER, '谢谢', 1), c(5, 9, '对', 4)] }
    expect(biliPairs(thread, ids)).toEqual([{ reason: 'own-account' }, { reason: 'own-account' }, { reason: 'owner-unverified' }, { reason: 'owner-unverified' }])
  })
})

describe('screenPairs and pickForRun', () => {
  const pair = (key: string, how: 'reply' | 'next', at: number, reply: string, source: Accepted['source'] = 'qq-group'): Accepted => ({ source, key, how, at, prompt: '在吗', reply, id: reply })

  it('counts refusals by reason, folds duplicates, and drops old exchanges', () => {
    const { accepted, filtered } = screenPairs([
      { source: 'qq-group', key: 'qq:g', how: 'reply', at: T0, prompt: '在吗', reply: '在' },
      { source: 'qq-group', key: 'qq:h', how: 'reply', at: T0, prompt: '在吗', reply: '在' },
      { source: 'qq-group', key: 'qq:g', how: 'reply', at: T0 - 100, prompt: '在吗', reply: '不在' },
      { source: 'qq-group', key: 'qq:g', how: 'reply', at: T0, prompt: '看 www.x.com', reply: '好' },
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
      pair('bili:1', 'reply', T0, 'owner', 'owner-bili'),
    ], { max: 4, perKey: 2 })
    expect(picked.map(item => item.reply)).toEqual(['owner', 'a-r3', 'b-r1', 'a-r2'])
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
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname
      calls.push({ url, auth: new Headers(init?.headers).get('authorization') })
      return Response.json(answers[path])
    }) as unknown as typeof globalThis.fetch
    const reader = createBiliReader({ baseUrl: 'http://127.0.0.1:8097', token: 'tok', timeoutMs: 1000, fetch })
    expect(await reader.accounts()).toEqual([{ id: 'maodeng', mid: 401 }, { id: 'maomao', mid: 402 }])
    expect(await reader.comments(100)).toEqual([{ rpid: 10, mid: 7, ctime: 1, root: 0, parent: 0, text: '好看' }])
    expect((await reader.thread(10)).replies).toEqual([{ rpid: 11, mid: 401, ctime: 2, root: 0, parent: 10, text: '谢谢', gate: false }])
    expect(calls.map(call => call.auth)).toEqual(['Bearer tok', 'Bearer tok', 'Bearer tok'])
    expect(calls[1]!.url).toBe('http://127.0.0.1:8097/v1/comments?unreplied=0&limit=100')
  })

  it('fails on a non-200 answer', async () => {
    const fetch = (async () => new Response('{}', { status: 403 })) as unknown as typeof globalThis.fetch
    await expect(createBiliReader({ baseUrl: 'http://x', token: 't', timeoutMs: 1000, fetch }).accounts()).rejects.toThrow(/HTTP 403 for \/v1\/status/u)
  })
})

describe('StyleCollector', () => {
  async function setup(options: { qq?: QqSource; bili?: BiliReader | 'no-token'; review?: 'optional' | 'required' } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'lsy-style-collect-'))
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
    groupOverview: () => [{ groupId: '1', recorded: true }, { groupId: '2', recorded: false }],
    recentMessages: groupId => (groupId === '1' ? [a, b, fresh] : [msg('9', '不该读到', T0)]),
  }

  it('stores accepted exchanges, reports counts by reason, logs no text at info, and keeps state', async () => {
    const bili: BiliReader = {
      accounts: () => Promise.resolve([{ id: 'maodeng', mid: 401 }, { id: 'maomao', mid: 402 }]),
      comments: () => Promise.resolve([{ rpid: 20, mid: 7, ctime: T0 / 1000, root: 0, parent: 0, text: '更新了' }]),
      thread: rpid => Promise.resolve({ root: { rpid, mid: 7, ctime: T0 / 1000, root: 0, parent: 0, text: '更新了' }, replies: [{ rpid: 21, mid: 401, ctime: T0 / 1000, root: 20, parent: 20, text: '刚剪完', gate: false }] }),
    }
    const { store, logger, collector, dir } = await setup({ qq, bili })
    const report = await collector.run('manual')
    expect(report).toMatchObject({ seen: 2, accepted: 2, added: 2, qq: { status: 'ok', groups: 1, messages: 2 }, bili: { status: 'ok', comments: 1, threads: 1 }, bySource: { 'qq-group': 1, 'owner-bili': 1 } })
    expect((await store.live()).map(record => [record.source, record.prompt, record.reply])).toEqual(expect.arrayContaining([['qq-group', '周末去哪', '宅着'], ['owner-bili', '更新了', '刚剪完']]))
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
})
