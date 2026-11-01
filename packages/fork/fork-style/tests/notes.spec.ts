import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { cleanup, mountStyle, tmp } from './harness.ts'
import * as Style from '../src/index.ts'
import { HotWatch } from '../src/hotwatch.ts'
import { NotesStore } from '../src/notes.ts'
import type { SessionLog } from '../src/session-text.ts'

const servers: Server[] = []
afterEach(async () => {
  await cleanup()
  await Promise.all(servers.splice(0).map(server => new Promise((resolve) => { server.close(resolve) })))
})

/** A fake HotWatch: `/events?domain=meme…` and `/events/<id>`; counts the calls. */
async function hotwatch(): Promise<{ url: string; calls: string[]; down: () => void }> {
  const calls: string[] = []
  let up = true
  const server = createServer((request, response) => {
    calls.push(request.url ?? '')
    if (!up) {
      response.writeHead(503).end()
      return
    }
    response.setHeader('content-type', 'application/json')
    if (request.url?.startsWith('/events?')) {
      response.end(JSON.stringify([
        { subevent_id: 'e1', title: '某某热梗', heat: 90 },
        { subevent_id: 'e2', title: '加我QQ 2153925085', heat: 80 },
        { subevent_id: 'e3', title: '另一个梗', heat: 70 },
      ]))
    } else if (request.url === '/events/e1') {
      response.end(JSON.stringify({ summary: '一个最近很火的说法，用来调侃。' }))
    } else {
      response.writeHead(404).end('{}')
    }
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  return { url: `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`, calls, down: () => { up = false } }
}

/** The log of a Session that ran the given tools: what the host wrote, which the model cannot forge. */
function logOf(...results: Array<{ tool: string; text: string }>): SessionLog {
  const events = [
    { type: 'turn/start', data: {} },
    ...results.flatMap(({ tool, text }, index) => [
      { type: 'tool/call', data: { callId: `c${String(index)}`, name: tool } },
      { type: 'tool/result', data: { message: { toolCallId: `c${String(index)}`, content: [{ type: 'text', text }] } } },
    ]),
  ]
  return { seq: events.length, eventAt: (seq: number) => events[seq] } as never
}

/** What the QQ digest Session was shown. */
const SHOWN = { 'digest-1': ['这也太典中典了吧', '才不是呢，我才没有在等'] }
const UP = logOf({ tool: 'up_comments', text: '[{"text":"up主又鸽了，典中典"}]' })
const WEB = logOf({ tool: 'web_search', text: '烧心这个梗最近很火：「贵是贵点，但吃了不烧心」' })

async function mount(config: Partial<Style.Config> = {}, guard: Parameters<typeof mountStyle>[0] = {}) {
  const mounted = await mountStyle({ qq: { shown: SHOWN }, ...guard, config })
  return { ...mounted, guardCalls: mounted.guard?.calls ?? [] }
}

const meme = (style: Style.StyleService, sessionId: string, preset: string, term: string, example: string, session?: SessionLog, meaning = '老套到成了经典') =>
  style.note({ sessionId, preset, kind: 'meme', term, meaning, example, ...session === undefined ? {} : { session } })

describe('style_note', () => {
  it('takes the platform from the Session\'s preset and the example only verbatim from what that Session just read', async () => {
    const { style, dir } = await mount()
    expect(await meme(style, 'digest-1', 'qq-digest', '典中典', '这也太典中典了')).toEqual({ status: 'recorded' })
    expect(await meme(style, 'digest-1', 'qq-digest', '典中典', '这也太典中典了')).toEqual({ status: 'refreshed' })
    expect(await meme(style, 'up-1', 'up', '鸽了', 'up主又鸽了', UP)).toEqual({ status: 'recorded' })
    expect(await meme(style, 'chat', 'unattended', '烧心', '贵是贵点，但吃了不烧心', WEB)).toEqual({ status: 'recorded' })
    expect(await meme(style, 'digest-1', 'qq-digest', '离谱', '编出来的一句')).toEqual({ status: 'rejected', reason: 'not_verbatim' })
    expect(await meme(style, 'chat', 'bili', '典中典', '这也太典中典了', WEB)).toEqual({ status: 'rejected', reason: 'not_a_reader' })
    const stored = JSON.parse(await readFile(join(dir, 'notes.json'), 'utf8')) as { notes: Array<{ term: string; source: string; meaningSource?: string }> }
    expect(stored.notes.map(note => [note.term, note.source, note.meaningSource]).toSorted()).toEqual([
      ['典中典', 'qq', 'agent'], ['烧心', 'web', 'agent'], ['鸽了', 'bili', 'agent'],
    ])
  })

  it('reads only public text: a web example must come from a web tool result, never from the owner\'s message or memory', async () => {
    const { style } = await mount()
    const owner = logOf({ tool: 'memory_search', text: '魔女说她的暗号是星尘突击' }, { tool: 'bash', text: '星尘突击' })
    expect(await style.note({ sessionId: 'chat', preset: 'unattended', kind: 'trait', term: '嘴硬', example: '贵是贵点', session: WEB }))
      .toEqual({ status: 'rejected', reason: 'not_a_reader' })
    expect(await meme(style, 'chat', 'unattended', '星尘突击', '星尘突击', owner)).toEqual({ status: 'rejected', reason: 'not_verbatim' })
    // A QQ result is not a web page: an unattended note reads only web_search and web_fetch results.
    const qq = logOf({ tool: 'qq_recent', text: '这也太典中典了吧' })
    expect(await meme(style, 'chat', 'unattended', '典中典', '这也太典中典了', qq)).toEqual({ status: 'rejected', reason: 'not_verbatim' })
    expect(await meme(style, 'chat', 'unattended', '典中典', '这也太典中典了')).toEqual({ status: 'rejected', reason: 'unavailable' })
  })

  it('records a trait of the group\'s tone, needs a meaning for a meme, and filters personal information', async () => {
    const { style } = await mount()
    expect(await style.note({ sessionId: 'digest-1', preset: 'qq-digest', kind: 'trait', term: '嘴硬', example: '才不是呢' })).toEqual({ status: 'recorded' })
    expect(await style.note({ sessionId: 'digest-1', preset: 'qq-digest', kind: 'meme', term: '典中典', example: '典中典' })).toEqual({ status: 'rejected', reason: 'meaning_missing' })
    expect(await meme(style, 'digest-1', 'qq-digest', '张三老师', '典中典')).toEqual({ status: 'rejected', reason: 'pii' })
    expect(await meme(style, 'digest-1', 'qq-digest', '典中典', '典中典', undefined, '我在成都说的')).toEqual({ status: 'rejected', reason: 'pii' })
    expect((await style.panel()).notes.map(note => [note.kind, note.term])).toEqual([['trait', '嘴硬']])
  })

  it('stores related memes of the family, at most four, and answers a lookup by any of them', async () => {
    const { style } = await mount()
    const answer = await style.note({
      sessionId: 'digest-1', preset: 'qq-digest', kind: 'meme', term: '典中典', meaning: '老套到成了经典', example: '这也太典中典了',
      related: ['孝子', '急了', '麻了', '绷不住', '蚌埠住了', '典中典'],
    })
    expect(answer).toEqual({ status: 'recorded' })
    expect(await style.lookup('急了')).toMatchObject({ found: true, term: '典中典', related: ['孝子', '急了', '麻了', '绷不住'], meaningSource: 'agent', source: 'qq' })
  })

  it('writes nothing the guard refuses, and nothing at all while the guard is not mounted', async () => {
    const { style, guardCalls } = await mount()
    expect(await meme(style, 'digest-1', 'qq-digest', '典中典', '这也太典中典了', undefined, '带 CANARY-7 的释义')).toEqual({
      status: 'rejected', reason: 'guard: this text looks like protected content',
    })
    expect(await style.note({ sessionId: 'digest-1', preset: 'qq-digest', kind: 'trait', term: '嘴硬', example: '才不是呢，我才没有在等' })).toEqual({ status: 'recorded' })
    expect(guardCalls.map(call => call.options)).toEqual([
      { purpose: 'style_note', audience: 'public', sessionId: 'digest-1' }, { purpose: 'style_note', audience: 'public', sessionId: 'digest-1' },
    ])
    expect((await style.panel()).notes.map(note => note.term)).toEqual(['嘴硬'])
    const bare = await mount({}, { guard: 'absent' })
    expect(await meme(bare.style, 'digest-1', 'qq-digest', '典中典', '这也太典中典了')).toEqual({ status: 'rejected', reason: 'guard_unavailable' })
    expect((await bare.style.panel()).notes).toEqual([])
  })

  it('never brings back a note the owner deleted, and lets memes expire', async () => {
    const { style } = await mount()
    await meme(style, 'digest-1', 'qq-digest', '典中典', '典中典')
    const [note] = (await style.panel()).notes
    expect((await style.edit({ op: 'remove', id: note!.id })).ok).toBe(true)
    expect(await meme(style, 'digest-1', 'qq-digest', '典中典！', '典中典')).toEqual({ status: 'rejected', reason: 'removed' })
    const dir = await tmp()
    let now = 0
    const store = new NotesStore(join(dir, 'notes.json'), { maxMemes: 2, maxTraits: 1, expireDays: 14, maxVersions: 3 }, () => now)
    for (const term of ['甲', '乙', '丙']) {
      now += 1
      await store.note({ kind: 'meme', term, meaning: 'x', example: term, source: 'qq' })
    }
    expect((await store.notes()).map(item => item.term)).toEqual(['丙', '乙'])
    now += 15 * 86_400_000
    expect(await store.notes()).toEqual([])
  })

  it('is refused while memes or traits are switched off', async () => {
    const { style } = await mount({ memes: { enabled: false, maxIndex: 40, maxStored: 80, expireDays: 14 } })
    expect(await meme(style, 'digest-1', 'qq-digest', '典中典', '典中典')).toEqual({ status: 'rejected', reason: 'off' })
  })
})

describe('the persona card', () => {
  it('takes the agent\'s card, waits between revisions, tells the owner the size only, and keeps every version', async () => {
    const { style, notices, guardCalls } = await mount()
    expect(await style.updateCard({ card: '傲娇猫娘，嘴硬心软。', reason: '群里都嘴硬', sessionId: 'chat' })).toEqual({ status: 'recorded' })
    expect(await style.updateCard({ card: '换一个', reason: 'x' })).toEqual({ status: 'rejected', reason: 'too_soon' })
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ title: '人设卡更新到第 1 版', body: '0 → 10 字（设置 → 说话风格 可回滚）', safety: true })
    expect(JSON.stringify(notices)).not.toContain('傲娇')
    expect(guardCalls.map(call => call.options)).toEqual([{ purpose: 'persona', audience: 'public', sessionId: 'chat' }])
    expect((await style.block('2026-11-01', true))!.text).toContain('傲娇猫娘')
  })

  it('leads the block, ahead of the traits, memes, and tone samples', async () => {
    const { style } = await mount()
    await style.note({ sessionId: 'digest-1', preset: 'qq-digest', kind: 'trait', term: '嘴硬', example: '才不是呢' })
    await style.updateCard({ card: '傲娇猫娘，嘴硬心软。', reason: 'x' })
    const text = (await style.block('2026-11-01', true))!.text
    expect(text.indexOf('傲娇猫娘')).toBeGreaterThan(-1)
    expect(text.indexOf('傲娇猫娘')).toBeLessThan(text.indexOf('嘴硬（例'))
  })

  it('refuses personal information, an over-long card, and anything the guard refuses', async () => {
    const { style, notices } = await mount()
    expect(await style.updateCard({ card: '我叫李雷，QQ 2153925085', reason: 'x' })).toMatchObject({ status: 'rejected' })
    expect(await style.updateCard({ card: '喵'.repeat(601), reason: 'x' })).toEqual({ status: 'rejected', reason: 'too-long' })
    expect(await style.updateCard({ card: '傲娇猫娘 MEMORY-SPAN', reason: 'x' })).toEqual({ status: 'rejected', reason: 'guard: this text looks like protected content' })
    expect(await style.updateCard({ card: '傲娇猫娘', reason: 'key sk-live-abc' })).toMatchObject({ status: 'rejected' })
    expect((await style.panel()).cards).toEqual([])
    expect(notices).toEqual([])
  })

  it('refuses every revision while the guard is not mounted', async () => {
    const { style } = await mount({}, { guard: 'absent' })
    expect(await style.updateCard({ card: '傲娇猫娘', reason: 'x' })).toEqual({ status: 'rejected', reason: 'guard_unavailable' })
    expect((await style.panel()).cards).toEqual([])
    // The owner's own edit on the Settings page is the owner's text, not the agent's write.
    expect((await style.edit({ op: 'card', card: '魔女写的卡' })).ok).toBe(true)
  })

  it('lets the owner edit, roll back, and delete; an owner edit is the new baseline and restarts the wait', async () => {
    const { style } = await mount()
    await style.updateCard({ card: '第一版', reason: 'a' })
    expect((await style.edit({ op: 'card', card: '魔女改过的版本' })).ok).toBe(true)
    expect(await style.updateCard({ card: '想改回去', reason: 'b' })).toEqual({ status: 'rejected', reason: 'too_soon' })
    expect((await style.edit({ op: 'rollback', version: 1 })).panel.cards.at(-1)).toMatchObject({ version: 3, card: '第一版', author: 'owner' })
    const deleted = await style.edit({ op: 'card', card: '' })
    expect(deleted.panel.cards.map(card => card.version)).toEqual([1, 2, 3, 4])
    expect((await style.block('2026-11-01', true))!.text).toContain(Style.CARD_INVITE)
    expect(await style.edit({ op: 'rollback', version: 99 })).toMatchObject({ ok: false, error: 'not_found' })
    expect(await style.edit({ op: 'card', card: '喵'.repeat(601) })).toMatchObject({ ok: false, error: 'invalid_input' })
  })

  it('lets the owner delete a past version from the history, never the current one', async () => {
    const { style } = await mount()
    await style.updateCard({ card: '第一版', reason: 'a' })
    await style.edit({ op: 'card', card: '第二版' })
    expect((await style.edit({ op: 'deleteVersion', version: 1 })).panel.cards.map(card => card.version)).toEqual([2])
    expect(await style.edit({ op: 'deleteVersion', version: 2 })).toMatchObject({ ok: false, error: 'current_version' })
    expect(await style.edit({ op: 'deleteVersion', version: 9 })).toMatchObject({ ok: false, error: 'not_found' })
  })

  it('allows a new agent revision six hours after the last one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(1_000_000)
      const { style } = await mount()
      expect(await style.updateCard({ card: '第一版', reason: 'a' })).toEqual({ status: 'recorded' })
      vi.setSystemTime(1_000_000 + 6 * 3_600_000 - 1)
      expect(await style.updateCard({ card: '第二版', reason: 'a' })).toEqual({ status: 'rejected', reason: 'too_soon' })
      vi.setSystemTime(1_000_000 + 6 * 3_600_000)
      expect(await style.updateCard({ card: '第二版', reason: 'a' })).toEqual({ status: 'recorded' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('meme_lookup and HotWatch', () => {
  it('answers from the groups first, then HotWatch, and says which', async () => {
    const fake = await hotwatch()
    const { style } = await mount({ hotwatch: { enabled: true, url: fake.url, limit: 30, maxIndex: 15, ttlMs: 60_000, timeoutMs: 2000 } })
    await meme(style, 'digest-1', 'qq-digest', '典中典', '这也太典中典了')
    expect(await style.lookup('典中典')).toMatchObject({ found: true, from: 'groups', term: '典中典', meaning: '老套到成了经典', example: '这也太典中典了' })
    expect(await style.lookup('某某热梗')).toEqual({ found: true, from: 'hotwatch', term: '某某热梗', meaning: '一个最近很火的说法，用来调侃。' })
    expect(await style.lookup('不存在')).toEqual({ found: false })
    // Titles with personal information never reach the index; the list is cached.
    const panel = await style.panel()
    expect(panel.hot.map(item => item.title)).toEqual(['某某热梗', '另一个梗'])
    expect(fake.calls.filter(call => call.startsWith('/events?'))).toHaveLength(1)
    expect((await style.block('2026-11-01', false))!.text).toContain('全网热梗：某某热梗、另一个梗')
    // The owner deletes a HotWatch title from the index.
    await style.edit({ op: 'block', term: '另一个梗' })
    expect((await style.panel()).hot.map(item => item.title)).toEqual(['某某热梗'])
  })

  it('degrades to nothing and warns once per kind of failure', async () => {
    const fake = await hotwatch()
    fake.down()
    const warn = vi.fn()
    const client = new HotWatch({ url: fake.url, limit: 30, ttlMs: 0, timeoutMs: 2000, fetch: (...args) => fetch(...args), warn })
    expect(await client.memes()).toEqual([])
    expect(await client.memes()).toEqual([])
    expect(await client.lookup('某某热梗')).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toMatch(/HotWatch list unavailable \(HTTP 503\)/u)
  })
})

describe('the tools in the real agent loop', () => {
  it('limits style_note per turn, answers meme_lookup with the family, and takes persona_update through the guard', async () => {
    const note = { term: '典中典', meaning: '老套到成了经典', example: '这也太典中典了', related: ['孝子'] }
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'style_note', note), toolCallResponse('c2', 'style_note', note), toolCallResponse('c3', 'style_note', note),
      toolCallResponse('c4', 'meme_lookup', { term: '典中典' }),
      toolCallResponse('c5', 'persona_update', { card: '傲娇猫娘，嘴硬心软。', reason: '群里都嘴硬' }), textResponse('NO_REPLY'),
    ])
    const { ctx, dir } = await mount({}, { adapter })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin({ name: 'preset-scope', apply: async (scope: Context) => {
      await scope.plugin(Style, {
        mode: 'prompt', block: false, tools: ['style_note', 'meme_lookup', 'persona_update'],
        notes: { sources: { 'qq-digest': 'qq' }, termChars: 20, textChars: 60, perTurn: 2 },
      } as never)
    } })
    const agent: Agent = await ctx.agentLoop.create(SessionId('digest-1'), { provider: 'mock', model: 'mock' }, { agentPreset: 'qq-digest' } as never)
    const done = new Promise<void>((resolve) => {
      const dispose = ctx.on('agent/status', ({ agent: seen, status }) => { if (seen === agent && status === 'idle') { dispose(); resolve() } })
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'transcript' }], source: { kind: 'user', rpcId: 'digest' } as never }))
    await done
    const last = JSON.stringify(adapter.requests.at(-1)!.messages)
    expect(last).toContain('recorded')
    expect(last).toContain('refreshed')
    expect(last).toContain('limit_reached')
    expect(last).toContain('老套到成了经典')
    expect(last).toContain('孝子')
    const cards = JSON.parse(await readFile(join(dir, 'notes.json'), 'utf8')) as { cards: unknown[] }
    expect(cards.cards).toHaveLength(1)
  })
})
