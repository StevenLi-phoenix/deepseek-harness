import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { cleanup, fakeGuard, fakeWeb, fixture, fixtureText, minerModel, minerScript, mountStyle } from './harness.ts'

afterEach(cleanup)

const rawFiles = async (dir: string): Promise<string[]> => (await readdir(join(dir, 'raw'))).toSorted()
const userOf = (adapter: MockAdapter, index: number): string => JSON.stringify(adapter.requests[index]?.messages)

describe('A: 海水过滤器, from the hot comments of BV1UnHN6SECP', () => {
  async function run(search: string, meaning: string) {
    const web = fakeWeb(fixture(search))
    const mounted = await mountStyle({
      adapter: minerModel({ propose: fixture('a-propose.json'), meaning: fixture(meaning) }), web,
      hot: { comments: fixture('a-hot-comments.json') as unknown[], words: [] },
    })
    return { ...mounted, web, report: await mounted.style.mine() }
  }

  it('discovers the meme, searches for it, and stores the meaning, the family, and where the meaning came from', async () => {
    const { style, web, report, dir, adapter } = await run('a-search.json', 'a-meaning.json')
    expect(report).toMatchObject({ kept: 1, candidates: 1, llmCalls: 2, searches: 1, inputs: { comment: 5, qq: 0, hot: 0, web: 0 } })
    expect(web.queries).toEqual(['海水过滤器 梗 出处'])
    const note = (await style.panel()).notes.find(item => item.term === '海水过滤器')!
    expect(note).toMatchObject({ kind: 'meme', source: 'bili', meaningSource: 'search', related: ['电鳗发电机'], example: '我已经打捞到海水过滤器了' })
    for (const part of ['低成本AI', '海上生存手游广告', '开局一定要选海水过滤器！', '硬控']) expect(note.meaning).toContain(part)
    // The model read the comments, never the video id; the raw answers were written to disk first.
    expect(userOf(adapter, 0)).toContain('海水过滤器已经过时了，现在是电鳗发电机')
    expect(userOf(adapter, 0)).not.toContain('BV1UnHN6SECP')
    expect((await rawFiles(dir)).map(file => file.split('Z-')[1]?.split('-')[0]).toSorted()).toEqual(['meaning', 'propose', 'search'])
  })

  it('answers meme_lookup with it, also by a related term, and puts it in the style block', async () => {
    const { style } = await run('a-search.json', 'a-meaning.json')
    expect(await style.lookup('海水过滤器')).toMatchObject({
      found: true, from: 'groups', term: '海水过滤器', source: 'bili', meaningSource: 'search', related: ['电鳗发电机'],
    })
    expect(await style.lookup('电鳗发电机')).toMatchObject({ found: true, term: '海水过滤器' })
    const block = (await style.block('2026-11-01', false))!
    expect(block.text).toContain('圈内黑话：海水过滤器')
    expect(block.memes).toBe(1)
  })

  it('takes the meaning from what the search found: another result gives another meaning', async () => {
    const { style } = await run('a2-search.json', 'a2-meaning.json')
    const note = (await style.panel()).notes.find(item => item.term === '海水过滤器')!
    expect(note.meaning).toBe('某款手游广告里被反复念叨的道具名')
    expect(note.meaning).not.toContain('低成本')
  })

  it('keeps a stored meme alive when its term shows up again, and does not search twice for it', async () => {
    const { style, web, adapter } = await run('a-search.json', 'a-meaning.json')
    await style.mine()
    expect(web.queries).toHaveLength(1)
    expect(adapter.requests).toHaveLength(3)
    expect((await style.panel()).lastMine).toMatchObject({ kept: 0, touched: 1, rejected: { known: 1 } })
  })
})

describe('B: 烧心, from a hot-search word and a web_search result in a Session', () => {
  it('reads the page the main agent searched, explains the word from it, and marks the meaning web', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('w1', 'web_search', { query: 'QUERY-MARK 台词出处' }), textResponse('找到了'),
      ...minerScript({ propose: fixture('b-propose.json'), meaning: fixture('b-meaning.json') }).slice(0, 2),
    ])
    const web = fakeWeb({ sources: [], truncated: false })
    const { ctx, style, dir } = await mountStyle({ adapter, web, hot: { comments: [], words: fixture('b-hot-words.json') as unknown[] } })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.tools.register(defineTool({
      name: 'web_search', description: 'search', parameters: { query: { type: 'string', required: true } },
      output: { schema: { type: 'json' }, render: () => [{ type: 'text' as const, text: fixtureText('b-web-search-result.txt') }] },
      execute: () => Promise.resolve({ ok: true }),
      presentCall: () => ({ card: 'generic', title: 'search', kind: 'search' }),
    }))
    const agent = await ctx.agentLoop.create(SessionId('chat'), { provider: 'mock', model: 'mock' }, { agentPreset: 'unattended' } as never)
    const done = new Promise<void>((resolve) => {
      const dispose = ctx.on('agent/status', ({ agent: seen, status }) => { if (seen === agent && status === 'idle') { dispose(); resolve() } })
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '帮我查查这句台词' }], source: { kind: 'user', rpcId: 'owner-1' } as never }))
    await done
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    // The inbox holds the result text, not the query and not the owner's message.
    const inbox = await readFile(join(dir, 'web-inbox.json'), 'utf8')
    expect(inbox).toContain('贵是贵点，但吃了不烧心')
    expect(inbox).not.toContain('QUERY-MARK')
    expect(inbox).not.toContain('帮我查查')

    const report = await style.mine()
    expect(report).toMatchObject({ kept: 1, searches: 0, llmCalls: 2, inputs: { hot: 1 } })
    expect(web.queries).toEqual([])
    const note = (await style.panel()).notes.find(item => item.term === '烧心')!
    expect(note).toMatchObject({ kind: 'meme', meaningSource: 'web', example: '真实拍视频日常有多烧心' })
    expect(note.meaning).toContain('贵是贵点，但吃了不烧心')
    expect(await style.lookup('烧心')).toMatchObject({ found: true, meaningSource: 'web' })
  })
})

describe('C: what the miner leaves out', () => {
  it('stores no ordinary word, no high-frequency word, no invented example, no name, and no single mention', async () => {
    const web = fakeWeb(fixture('c-search.json'))
    const { style, adapter } = await mountStyle({
      adapter: minerModel({ propose: fixture('c-propose.json'), meaning: fixture('c-meaning.json') }), web,
      qq: { texts: fixture('c-qq-texts.json') as string[] }, config: { qq: { enabled: false } as never },
    })
    const report = await style.mine()
    expect(report).toMatchObject({ kept: 0, candidates: 5, searches: 1 })
    expect(report?.rejected).toEqual({ too_common: 1, not_a_meme: 1, not_verbatim: 1, pii: 1, no_evidence: 1 })
    expect((await style.panel()).notes).toEqual([])
    expect(userOf(adapter, 0)).toContain('今天天气不错')
  })

  it('never lets personal information, QQ numbers, UIDs, or member aliases reach the model or the notes', async () => {
    const dirty = ['群友#a1b2c3 说海水过滤器好用', 'uid:12345678 的海水过滤器', '加我QQ 2153925085 看海水过滤器', '@某某 海水过滤器yyds', '海水过滤器真的太上头了', '海水过滤器笑死我了']
    const adapter = minerModel({
      propose: [
        { term: '海水过滤器', meaning: '', example: '海水过滤器真的太上头了', related: [] },
        { term: '群友', meaning: '', example: '群友#a1b2c3 说海水过滤器好用', related: [] },
      ],
      meaning: { 海水过滤器: '一个流行的游戏梗' },
    })
    const { style, dir } = await mountStyle({ adapter, web: fakeWeb(fixture('c-search.json')), qq: { texts: dirty } })
    const report = await style.mine()
    expect(report?.inputs).toMatchObject({ qq: 2, dropped: 4 })
    for (const leaked of ['a1b2c3', '12345678', '2153925085', '某某']) expect(userOf(adapter, 0)).not.toContain(leaked)
    expect(report?.rejected).toMatchObject({ pii: 1 })
    const stored = await readFile(join(dir, 'notes.json'), 'utf8')
    for (const leaked of ['a1b2c3', '12345678', '2153925085', '某某']) expect(stored).not.toContain(leaked)
  })

  it('ignores the owner\'s own messages: only tool results and recorded public text are inputs', async () => {
    const adapter = new MockAdapter([textResponse('好的'), ...minerScript({ propose: [] })])
    const { ctx, style, dir } = await mountStyle({ adapter })
    await ctx.plugin(AgentLoop, { agents: [] })
    const agent = await ctx.agentLoop.create(SessionId('chat'), { provider: 'mock', model: 'mock' }, { agentPreset: 'unattended' } as never)
    const done = new Promise<void>((resolve) => {
      const dispose = ctx.on('agent/status', ({ agent: seen, status }) => { if (seen === agent && status === 'idle') { dispose(); resolve() } })
    })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: '星尘突击星尘突击星尘突击，这是我们家最近的暗号' }], source: { kind: 'user', rpcId: 'owner-2' } as never,
    }))
    await done
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    expect(await style.mine()).toMatchObject({ skipped: 'no_inputs' })
    expect(adapter.requests).toHaveLength(1)
    await expect(readFile(join(dir, 'web-inbox.json'), 'utf8')).rejects.toThrow()
    expect(await style.note({ sessionId: 'chat', preset: 'unattended', kind: 'meme', term: '星尘突击', meaning: '暗号', example: '星尘突击星尘突击' }))
      .toEqual({ status: 'rejected', reason: 'unavailable' })
  })

  it('stores nothing when the guard refuses the record or is not mounted', async () => {
    const refusing = await mountStyle({
      adapter: minerModel({ propose: fixture('a-propose.json'), meaning: { 海水过滤器: '带 CANARY-7 的释义' } }), web: fakeWeb(fixture('a-search.json')),
      hot: { comments: fixture('a-hot-comments.json') as unknown[], words: [] }, guard: fakeGuard(),
    })
    expect(await refusing.style.mine()).toMatchObject({ kept: 0, rejected: { guard: 1 } })
    expect(refusing.guard).not.toBe('absent')
    expect((refusing.guard as ReturnType<typeof fakeGuard>).calls[0]?.options).toMatchObject({ purpose: 'meme_miner', audience: 'public' })
    const absent = await mountStyle({
      adapter: minerModel({ propose: fixture('a-propose.json'), meaning: fixture('a-meaning.json') }), web: fakeWeb(fixture('a-search.json')),
      hot: { comments: fixture('a-hot-comments.json') as unknown[], words: [] }, guard: 'absent',
    })
    expect(await absent.style.mine()).toMatchObject({ kept: 0, rejected: { guard_unavailable: 1 } })
    expect((await absent.style.panel()).notes).toEqual([])
  })
})
