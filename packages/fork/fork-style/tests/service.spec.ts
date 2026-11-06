import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Style from '../src/index.ts'
import { StyleStore } from '../src/store.ts'
import { cleanup, fakeWeb, minerModel, mountStyle, tmp, track, type MountOptions } from './harness.ts'

const servers: Server[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await cleanup()
  await Promise.all(servers.splice(0).map(server => new Promise((resolve) => { server.close(resolve) })))
})

/** The style service with its log captured. */
async function mount(options: MountOptions = {}) {
  const mounted = await mountStyle(options)
  const logs: string[] = []
  mounted.ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push(`${message.type}: ${String(message.args[0])} ${message.args.slice(1).map(String).join(' ')}`.trim()) } })
  return { ...mounted, logs, has: (...needles: string[]) => logs.some(line => needles.every(needle => line.includes(needle))) }
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  return `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`
}

const ORIGIN = { platform: 'qq', groups: 1, speakers: 2, days: 1 } as const
const seed = async (dir: string, candidates: Array<{ prompt?: string; reply: string; owner?: boolean }>, review: 'optional' | 'required' = 'optional') => {
  await new StyleStore(join(dir, 'samples.jsonl'), { maxActive: 60, maxOwner: 20, maxPending: 40, maxTombstones: 100 }).ingest(
    candidates.map(item => ({ source: 'qq' as const, origin: ORIGIN, at: Date.now(), ...item.prompt === undefined ? {} : { prompt: item.prompt }, reply: item.reply })), review,
  )
}

describe('configuration that cannot work', () => {
  const base = async () => {
    const dir = await tmp()
    return { dir, ticsFile: join(dir, 'tics.json'), qq: { enabled: false }, bili: { enabled: false }, hotwatch: { enabled: false } }
  }
  it.each([
    ['a relative data directory', { dir: 'relative/dir' }, 'dir must be an absolute path'],
    ['a relative stock-line file', { ticsFile: 'tics.json' }, 'ticsFile must be an absolute path'],
    ['a bili-svc address that is not http', { bili: { enabled: false, url: 'ftp://bili' } }, 'ftp://bili must be an http(s) address'],
    ['a HotWatch address that is not http', { hotwatch: { enabled: false, url: 'hot.local:8000' } }, 'hot.local:8000 must be an http(s) address'],
    ['more pinned owner samples than active samples', { maxOwner: 70 }, 'maxOwner must not exceed maxActive'],
    ['a time zone that does not exist', { timeZone: 'Mars/Base' }, 'timeZone "Mars/Base" is not a valid IANA time zone'],
  ])('refuses %s at load', async (_name, patch, message) => {
    const ctx = track(new Context())
    await expect(ctx.plugin(Style, { ...await base(), ...patch } as Style.Config)).rejects.toThrow(message)
  })

  it('keeps its data under $DSH_HOME/fork-style, and reads the stock lines from $DSH_HOME/fork-integrity, when no paths are configured', async () => {
    const home = await tmp()
    vi.stubEnv('DSH_HOME', home)
    const ctx = track(new Context())
    await mkdir(join(home, 'fork-integrity'), { recursive: true })
    await writeFile(join(home, 'fork-integrity', 'tics.json'), JSON.stringify({ days: { '2026-10-31': { answers: 10, answersWithHits: 4 } } }))
    await ctx.plugin(Style, { qq: { enabled: false }, bili: { enabled: false }, hotwatch: { enabled: false } } as Style.Config)
    const style = ctx.get('forkStyle')!
    await style.edit({ op: 'card', card: '一张卡' })
    expect(JSON.parse(await readFile(join(home, 'fork-style', 'notes.json'), 'utf8'))).toMatchObject({ cards: [{ card: '一张卡' }] })
    expect((await style.panel()).trend).toEqual([{ day: '2026-10-31', answers: 10, withTics: 4, mainAnswers: 0, meanChars: null }])
  })
})

describe('edit', () => {
  it('removes a note with its term blocked, or a sample, and keeps a pending one', async () => {
    const { style, dir, has } = await mount({ config: { review: 'required' } })
    await seed(dir, [{ prompt: '在吗', reply: '在' }], 'required')
    await style.edit({ op: 'card', card: '一张卡' })
    const [pending] = (await style.panel()).samples
    expect(pending).toMatchObject({ status: 'pending' })
    expect(await style.edit({ op: 'keep', id: pending!.id })).toMatchObject({ ok: true, panel: { samples: [{ status: 'active' }] } })
    expect(has('the owner kept')).toBe(true)
    expect(await style.edit({ op: 'keep', id: 'nothing' })).toMatchObject({ ok: false, error: 'not_found' })
    expect(await style.edit({ op: 'keep' })).toMatchObject({ ok: false, error: 'not_found' })
    expect(await style.edit({ op: 'remove', id: pending!.id })).toMatchObject({ ok: true, panel: { samples: [] } })
    expect(has('the owner removed', pending!.id, ' qq')).toBe(true)
    expect(await style.edit({ op: 'remove', id: 5 })).toMatchObject({ ok: false, error: 'not_found' })
  })

  it('removes a meme or trait note by id and blocks its term', async () => {
    const { style, ctx, has } = await mount({ qq: { shown: { s1: ['这也太典中典了'] } } })
    void ctx
    const answer = await style.note({ sessionId: 's1', preset: 'qq-digest', kind: 'meme', term: '典中典', meaning: '老套到成了经典', example: '这也太典中典了' })
    expect(answer).toEqual({ status: 'recorded' })
    const [note] = (await style.panel()).notes
    expect(await style.edit({ op: 'remove', id: note!.id })).toMatchObject({ ok: true, panel: { notes: [] } })
    expect(has('the owner removed', note!.id, ' meme')).toBe(true)
  })

  it('blocks a title and refuses one that is empty or not text', async () => {
    const { style } = await mount()
    expect(await style.edit({ op: 'block', term: '某某热梗' })).toMatchObject({ ok: true })
    expect(await style.edit({ op: 'block', term: '  ' })).toMatchObject({ ok: false, error: 'invalid_input' })
    expect(await style.edit({ op: 'block', term: 5 })).toMatchObject({ ok: false, error: 'invalid_input' })
  })

  it('writes, deletes, and rolls back the card, and drops a past version, with a refusal for each bad request', async () => {
    const { style } = await mount()
    expect(await style.edit({ op: 'card', card: '甲\n\n\n乙  ' })).toMatchObject({ ok: true, panel: { cards: [{ version: 1, card: '甲\n\n乙', author: 'owner' }] } })
    expect(await style.edit({ op: 'card', card: '' })).toMatchObject({ ok: true, panel: { cards: [{}, { version: 2, card: '', reason: 'deleted on the Settings page' }] } })
    expect(await style.edit({ op: 'card', card: 5 })).toMatchObject({ ok: false, error: 'invalid_input' })
    expect(await style.edit({ op: 'card', card: '长'.repeat(601) })).toMatchObject({ ok: false, error: 'invalid_input' })
    expect(await style.edit({ op: 'rollback', version: 1 })).toMatchObject({ ok: true, panel: { cards: [{}, {}, { version: 3, card: '甲\n\n乙', reason: 'rolled back to version 1' }] } })
    expect(await style.edit({ op: 'rollback', version: 99 })).toMatchObject({ ok: false, error: 'not_found' })
    expect(await style.edit({ op: 'deleteVersion', version: 99 })).toMatchObject({ ok: false, error: 'not_found' })
    expect(await style.edit({ op: 'deleteVersion', version: '1' })).toMatchObject({ ok: false, error: 'not_found' })
    expect(await style.edit({ op: 'deleteVersion', version: 3 })).toMatchObject({ ok: false, error: 'current_version' })
    expect(await style.edit({ op: 'deleteVersion', version: 2 })).toMatchObject({ ok: true, panel: { cards: [{ version: 1 }, { version: 3 }] } })
  })

  it('lets a failure that is not a refusal through', async () => {
    const { style, dir } = await mount()
    await mkdir(join(dir, 'notes.json'))
    await expect(style.edit({ op: 'block', term: '某某热梗' })).rejects.toMatchObject({ code: 'EISDIR' })
  })
})

describe('collect and the schedule', () => {
  it('warns when a manual run fails', async () => {
    const { style, dir, has } = await mount()
    await mkdir(join(dir, 'state.json'))
    await style.collect()
    await vi.waitFor(() => { expect(has('fork-style: manual run failed')).toBe(true) })
  })

  it('warns with the text of a manual run failure that is not an Error', async () => {
    const { style, has } = await mount()
    style.mine = async () => { throw 'miner closed' }
    await style.collect()
    await vi.waitFor(() => { expect(has('manual run failed', 'miner closed')).toBe(true) })
  })

  it('runs a due collection and the miner, then waits for the next due time', async () => {
    const { style, dir, ctx } = await mount({ qq: { texts: ['周末去哪', '宅着'] }, adapter: minerModel({ propose: [] }) })
    ctx.provide('biliHot' as never, { comments: () => [], words: () => [] } as never)
    const report = await style.runIfDue()
    expect(report).toMatchObject({ trigger: 'schedule', bili: { status: 'off' } })
    expect(JSON.parse(await readFile(join(dir, 'mine.json'), 'utf8'))).toMatchObject({ inputs: { qq: 2 }, kept: 0, llmCalls: 1 })
    expect((await style.panel()).lastMine).toMatchObject({ inputs: { qq: 2 }, kept: 0 })
    expect(await style.runIfDue()).toBeUndefined()
    expect(await style.nextRunAt()).toBeGreaterThan(Date.now())
  })

  it('waits while a run is in progress', async () => {
    const { style } = await mount()
    void style.collect()
    expect(await style.runIfDue()).toBeUndefined()
  })
})

describe('mine', () => {
  it('does nothing while mining or memes or the whole plugin is off', async () => {
    expect(await (await mount({ config: { enabled: false } })).style.mine()).toBeUndefined()
    expect(await (await mount({ config: { memes: { enabled: false } } as never })).style.mine()).toBeUndefined()
    expect(await (await mount({ config: { miner: { enabled: false } } as never })).style.mine()).toBeUndefined()
  })

  it('warns when QQ cannot be read for it, and when the report cannot be saved', async () => {
    const { style, dir, ctx, has } = await mount({ adapter: minerModel({ propose: [] }) })
    Object.assign(ctx.get('forkQq') as object, { groupOverview: () => Promise.reject(new Error('recorder down')) })
    ctx.provide('biliHot' as never, { nothing: true } as never)
    await mkdir(join(dir, 'mine.json'))
    const report = await style.mine()
    expect(report).toMatchObject({ skipped: 'no_inputs' })
    expect(has('miner could not read QQ: recorder down')).toBe(true)
    expect(has('could not save the miner report')).toBe(true)
  })

  it('warns with the text of a report failure that is not an Error', async () => {
    const { style, has } = await mount({ adapter: minerModel({ propose: [] }) })
    Object.defineProperty(style, 'mineFile', { get: () => { throw 'no path' } })
    await style.mine()
    expect(has('could not save the miner report', 'no path')).toBe(true)
  })

  it('ignores a miner report on disk that is not a report', async () => {
    const { style, dir } = await mount()
    await writeFile(join(dir, 'mine.json'), '{"at":"yesterday"}')
    expect((await style.panel()).lastMine).toBeNull()
    await writeFile(join(dir, 'mine.json'), 'null')
    expect((await style.panel()).lastMine).toBeNull()
  })

  it('searches the web for a meaning, reading the answer\'s text and the sources\' titles with their summaries or snippets', async () => {
    const web = fakeWeb({ content: '正文', sources: [{ title: '标题甲', summary: '摘要甲', snippet: '片段甲' }, { title: '标题乙', snippet: '片段乙' }, { title: '标题丙' }, {}] })
    const { style, adapter } = await mount({
      web, adapter: minerModel({ propose: [{ term: '海水过滤器', meaning: '', example: '海水过滤器真的绝了', related: [] }], meaning: { 海水过滤器: '来自手游广告' } }),
      hot: { comments: [{ text: '海水过滤器真的绝了', likes: 50 }, { text: '今天又是海水过滤器', likes: 1 }] },
    })
    const report = await style.mine()
    expect(report).toMatchObject({ kept: 1, searches: 1 })
    const meaningRequest = JSON.stringify(adapter.requests.at(-1)!.messages)
    expect(meaningRequest).toContain('正文')
    expect(meaningRequest).toContain('标题甲：摘要甲')
    expect(meaningRequest).toContain('标题乙：片段乙')
    expect(meaningRequest).toContain('标题丙')
    expect(web.queries).toEqual(['海水过滤器 梗 出处'])
  })

  it('goes on without a meaning from the web when no web service is mounted', async () => {
    const { style } = await mount({
      adapter: minerModel({ propose: [{ term: '海水过滤器', meaning: '模型的猜测', example: '海水过滤器真的绝了', related: [] }] }),
      hot: { comments: [{ text: '海水过滤器真的绝了', likes: 50 }, { text: '今天又是海水过滤器', likes: 1 }, { text: '海水过滤器笑死', likes: 1 }] },
    })
    expect(await style.mine()).toMatchObject({ kept: 1, searches: 1 })
    expect((await style.panel()).notes[0]).toMatchObject({ meaning: '模型的猜测', meaningSource: 'llm' })
  })
})

describe('the services behind the collector', () => {
  /** A bili-svc double that records the Authorization header of each request. */
  async function biliSvc() {
    const seen: Array<string | undefined> = []
    const url = await listen((request, response) => {
      seen.push(request.headers.authorization)
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(request.url === '/v1/status' ? { accounts: [{ id: 'maodeng', mid: 401 }] } : { comments: [] }))
    })
    return { url, seen }
  }
  const sources = { qq: { enabled: true }, bili: { enabled: true, tokenEnv: 'BILI_TEST_TOKEN' } }

  it('reads Bilibili with the token the credential service resolves, and QQ through the observer', async () => {
    const { url, seen } = await biliSvc()
    const resolved: string[] = []
    const { style, ctx } = await mount({ config: { ...sources, bili: { ...sources.bili, url } } as never, qq: { texts: ['周末去哪'] }, adapter: minerModel({ propose: [] }) })
    ctx.provide('credentials' as never, { resolve: async (ref: string) => { resolved.push(ref); return { value: 'secret-token' } } } as never)
    const report = await style.runIfDue()
    expect(report).toMatchObject({ qq: { status: 'ok', groups: 1, messages: 1 }, bili: { status: 'ok', comments: 0, threads: 0 } })
    expect(seen).toEqual(['Bearer secret-token', 'Bearer secret-token'])
    expect(resolved).toHaveLength(1)
  })

  it.each([
    ['no credential service', undefined],
    ['a credential that is not set', async () => undefined],
    ['an empty token', async () => ({ value: '' })],
  ])('reports no token for %s', async (_name, resolve) => {
    const { url, seen } = await biliSvc()
    const config = { ...sources, bili: { ...sources.bili, url } }
    const { style, ctx } = await mount({ config: config as never, adapter: minerModel({ propose: [] }) })
    if (resolve !== undefined) ctx.provide('credentials' as never, { resolve } as never)
    expect(await style.runIfDue()).toMatchObject({ bili: { status: 'no-token' } })
    expect(seen).toEqual([])
  })

  it('warns once through the context logger when HotWatch cannot be reached', async () => {
    const url = await listen((_request, response) => { response.writeHead(503).end() })
    const { style, has } = await mount({ config: { hotwatch: { enabled: true, url } as never } })
    expect((await style.panel()).hot).toEqual([])
    await style.panel()
    expect(has('HotWatch list unavailable (HTTP 503)')).toBe(true)
  })

  it('warns through the context logger when the miner\'s search fails', async () => {
    const web = { search: () => Promise.reject(new Error('search down')) }
    const { style, has } = await mount({
      web: web as never, adapter: minerModel({ propose: [{ term: '海水过滤器', meaning: '模型的猜测', example: '海水过滤器真的绝了', related: [] }] }),
      hot: { comments: [{ text: '海水过滤器真的绝了', likes: 50 }, { text: '今天又是海水过滤器', likes: 1 }, { text: '海水过滤器笑死', likes: 1 }] },
    })
    await style.mine()
    expect(has('miner search failed: search down')).toBe(true)
  })

  it('takes web pages for the miner only while mining is on', async () => {
    const off = await mount({ config: { miner: { enabled: false } } as never })
    await off.style.feedWeb('网页上的一句话。')
    await expect(readFile(join(off.dir, 'web-inbox.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const on = await mount()
    await on.style.feedWeb('网页上的一句话。')
    expect(await readFile(join(on.dir, 'web-inbox.json'), 'utf8')).toContain('网页上的一句话。')
  })
})

describe('the block', () => {
  async function filled(config: Record<string, unknown> = {}) {
    const mounted = await mount({ config })
    const now = Date.now()
    await writeFile(join(mounted.dir, 'notes.json'), JSON.stringify({
      notes: [
        { id: 'm1', kind: 'meme', term: '典中典', meaning: '经典', example: '典中典', source: 'qq', firstSeen: now, lastSeen: now },
        { id: 't1', kind: 'trait', term: '嘴硬', example: '才不是', source: 'qq', firstSeen: now, lastSeen: now },
      ],
      blocked: [], cards: [{ version: 1, card: '傲娇猫娘', author: 'owner', reason: 'r', at: now }],
    }))
    await seed(mounted.dir, [{ prompt: '在吗', reply: '在呢' }])
    return mounted
  }
  const PARTS = { persona: '傲娇猫娘', traits: '嘴硬', memes: '典中典', tone: '在呢' } as const

  it('shows every part by default', async () => {
    const { style } = await filled()
    const block = (await style.block('2026-11-01', false))!
    for (const marker of Object.values(PARTS)) expect(block.text).toContain(marker)
    expect(block).toMatchObject({ card: 1, shown: 1, memes: 1 })
  })

  it.each(Object.entries(PARTS))('leaves out the %s part when it is switched off, and keeps the others', async (part, marker) => {
    const { style } = await filled({ [part]: { enabled: false } })
    const block = (await style.block('2026-11-01', false))!
    expect(block.text).not.toContain(marker)
    for (const other of Object.values(PARTS).filter(value => value !== marker)) expect(block.text).toContain(other)
  })

  it('shows nothing once every part is off', async () => {
    const off = { enabled: false }
    const { style } = await filled({ persona: off, traits: off, memes: off, tone: off })
    expect(await style.block('2026-11-01', true)).toBeUndefined()
  })

  it('shows a sample that has no prompt, and answers the panel without one', async () => {
    const { style, dir } = await mount()
    await seed(dir, [{ reply: '直接说话' }])
    expect((await style.panel()).samples).toEqual([expect.objectContaining({ reply: '直接说话' })])
    expect((await style.panel()).samples[0]).not.toHaveProperty('prompt')
  })
})

describe('lookup, notes, and the card', () => {
  it('answers a meme without a meaning or a source of its meaning as the notes hold it, and nothing while off', async () => {
    const { style, dir } = await mount()
    const now = Date.now()
    await writeFile(join(dir, 'notes.json'), JSON.stringify({ notes: [{ id: 'm1', kind: 'meme', term: '老梗', example: '老梗', source: 'qq', firstSeen: now, lastSeen: now }], blocked: [], cards: [] }))
    expect(await style.lookup('老梗')).toEqual({ found: true, from: 'groups', term: '老梗', meaning: '', example: '老梗', source: 'qq' })
    expect(await (await mount({ config: { enabled: false } })).style.lookup('老梗')).toEqual({ found: false })
    expect(await (await mount({ config: { memes: { enabled: false } } as never })).style.lookup('老梗')).toEqual({ found: false })
  })

  it('does not look a blocked title up in HotWatch', async () => {
    const calls: string[] = []
    const url = await listen((request, response) => {
      calls.push(request.url ?? '')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify([{ subevent_id: 'e1', title: '某某热梗', heat: 90 }]))
    })
    const { style } = await mount({ config: { hotwatch: { enabled: true, url } as never } })
    await style.edit({ op: 'block', term: '某某热梗' })
    expect(await style.lookup('某某热梗')).toEqual({ found: false })
    expect(calls.filter(path => path.startsWith('/events/'))).toEqual([])
  })

  it('refuses a card while the persona part is off', async () => {
    const { style, has } = await mount({ config: { persona: { enabled: false } } as never })
    expect(await style.updateCard({ card: '傲娇猫娘，嘴硬心软。', reason: '因' })).toEqual({ status: 'rejected', reason: 'off' })
    expect(has('persona_update rejected')).toBe(true)
  })

  it.each([
    ['an Error', new Error('wechat down'), 'wechat down'],
    ['something that is not an Error', 'closed', 'closed'],
  ])('warns and keeps the card when the notice fails with %s', async (_name, failure, text) => {
    const { style, ctx, has } = await mount({ config: { persona: { minIntervalHours: 0 } } as never })
    Object.assign(ctx.get('forkNotifier') as object, { send: async () => { throw failure } })
    expect(await style.updateCard({ card: '傲娇猫娘，嘴硬心软。', reason: '因' })).toEqual({ status: 'recorded' })
    expect(has('card notice failed', text)).toBe(true)
    expect((await style.panel()).cards).toHaveLength(1)
  })

  it('takes a note from what the Session read when nothing was shown to it, or from what was shown when it read nothing', async () => {
    const log = (text: string) => {
      const events = [{ type: 'turn/start', data: {} }, { type: 'tool/call', data: { callId: 'c', name: 'qq_recent' } }, { type: 'tool/result', data: { message: { toolCallId: 'c', content: [{ type: 'text', text }] } } }]
      return { seq: events.length, eventAt: (seq: number) => events[seq] } as never
    }
    const { style } = await mount({ qq: { shown: { shown: ['群里说这也太典中典了'] } } })
    const base = { preset: 'qq-digest', kind: 'meme' as const, term: '典中典', meaning: '老套到成了经典' }
    expect(await style.note({ ...base, sessionId: 'read', example: '这也太典中典了', session: log('有人说这也太典中典了') })).toEqual({ status: 'recorded' })
    expect(await style.note({ ...base, sessionId: 'shown', example: '这也太典中典了' })).toEqual({ status: 'refreshed' })
    expect(await style.note({ ...base, sessionId: 'nothing', example: '这也太典中典了' })).toEqual({ status: 'rejected', reason: 'unavailable' })
  })
})
