import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Group from '@deepseek-ai/cordis-plugin-group'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { cleanup, fakeGuard, fakeWeb, fixture, fixtureText, minerScript, tmp, track } from './harness.ts'
import * as Style from '../src/index.ts'

/**
 * The shipped composition: the event bundle's own `fork-style` rows (the root row and each preset's `fork-style-prompt`
 * row, with their real configuration) are booted through the Loader and the preset registry, and Sessions are created
 * the way the webhook runtime creates them. Only the external services are fakes: the model (scripted answers), the
 * guard, the web search, the Bilibili hot source, the QQ observer, the notifier, and the `web_search` tool.
 */

afterEach(cleanup)

interface Row {
  id: string
  name?: string
  config?: Record<string, unknown> & { id?: string; order?: number; plugins?: Row[] }
  insert?: Row[]
}

const STYLE = '@deepseek-ai/dsh-fork-style'
const bundle = parse(readFileSync(join(import.meta.dirname, '../../../../fork/bundles/event/cordis.patch.yml'), 'utf8'), { logLevel: 'error' }) as Row[]
const inserted = bundle.flatMap(row => row.insert ?? [])
const rootRow = inserted.find(row => row.name === STYLE && row.id === 'fork-style')!
const presetRows = inserted.filter(row => row.name === '@deepseek-ai/dsh-agent-preset')
/** A Loader entry that mounts this package through the builtin table, with the bundle row's own configuration. */
interface Entry {
  id: string
  name: string
  config?: Record<string, unknown>
}
const builtin = (row: Row): Entry => ({ id: row.id, name: 'cordis:fork-style', ...row.config === undefined ? {} : { config: row.config } })

const WEB_RESULT = fixtureText('b-web-search-result.txt')

async function boot(options: { guard?: ReturnType<typeof fakeGuard> | 'absent'; script: ConstructorParameters<typeof MockAdapter>[0] }) {
  const dir = await tmp()
  const ctx = track(new Context())
  ctx.baseUrl = new URL('./fixtures/', import.meta.url).href
  const notices: Array<{ title: string; body?: string; safety?: true }> = []
  const guard = options.guard === 'absent' ? undefined : options.guard ?? fakeGuard()
  const web = fakeWeb(fixture('a-search.json'))
  await ctx.plugin(Loader)
  ctx.loader.builtins.group = Group
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, { default: 'unattended' })
  const adapter = new MockAdapter(options.script)
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.loader.builtins['fork-style'] = Style
  ctx.loader.builtins.fakes = {
    apply(scope: Context) {
      if (guard !== undefined) scope.provide('forkGuard' as never, guard as never)
      scope.provide('web', web as never)
      scope.provide('biliHot', { comments: () => Promise.resolve(fixture('a-hot-comments.json')), words: () => Promise.resolve([]) } as never)
      scope.provide('forkNotifier', { send: (note: { title: string }) => { notices.push(note); return Promise.resolve() } } as never)
      scope.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) } as never)
      scope.provide('forkQq', {
        groupOverview: () => Promise.resolve([]), recentMessages: () => Promise.resolve([]),
        recentTextOf: (sessionId: string) => (sessionId === 'digest' ? ['这也太典中典了吧', '才不是呢，我才没有在等'] : undefined),
      } as never)
    },
  }
  // The unattended preset's web_search (the real bundle mounts the web tools in that preset row by row).
  ctx.loader.builtins.webtool = {
    inject: ['tools'],
    apply(scope: Context) {
      scope.tools.register(defineTool({
        name: 'web_search', description: 'search', parameters: { query: { type: 'string', required: true } },
        output: { schema: { type: 'json' }, render: () => [{ type: 'text' as const, text: WEB_RESULT }] },
        execute: () => Promise.resolve({ ok: true }),
        presentCall: () => ({ card: 'generic', title: 'search', kind: 'search' }),
      }))
    },
  }
  // The bundle's root row with its own configuration; only the paths and the network sources are the test's.
  await ctx.loader.root.update([
    { id: 'fakes', name: 'cordis:fakes' },
    {
      ...builtin(rootRow),
      config: { ...rootRow.config, dir, ticsFile: join(dir, 'tics.json'), qq: { enabled: false }, bili: { enabled: false }, hotwatch: { enabled: false } },
    },
  ])
  for (const preset of presetRows) {
    const config = preset.config!
    const rows: Entry[] = (config.plugins ?? []).filter(row => row.name === STYLE).map(builtin)
    if (config.id === 'unattended') rows.push({ id: 'web-tool', name: 'cordis:webtool' })
    await ctx.agentPresets.register({ id: config.id!, order: config.order ?? 0, plugins: rows })
  }
  return { ctx, dir, adapter, notices, guard, style: ctx.get('forkStyle')! }
}

type Harness = Awaited<ReturnType<typeof boot>>

/** One turn of a Session of the given preset, created the way the webhook runtime creates one. */
async function turn(h: Harness, id: string, preset: string, text: string): Promise<{ agent: Agent; first: number; last: number }> {
  const first = h.adapter.requests.length
  const handle = await h.ctx.agents.create({
    sessionId: SessionId(id), meta: { cwd: h.dir, agentPreset: preset }, agentOptions: { provider: 'mock', model: 'mock' },
    setup: async (agentCtx: Context) => { await h.ctx.agentPresets.mount(agentCtx, preset) },
  })
  const agent = handle.agent
  const done = new Promise<void>((resolve) => {
    const dispose = h.ctx.on('agent/status', ({ agent: seen, status }) => { if (seen === agent && status === 'idle') { dispose(); resolve() } })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', rpcId: `owner-${id}` } as never }))
  await done
  return { agent, first, last: h.adapter.requests.length - 1 }
}

const toolNames = (adapter: MockAdapter, index: number): string[] => (adapter.requests[index]?.tools ?? []).map(tool => tool.name)
const requestText = (adapter: MockAdapter, index: number): string =>
  JSON.stringify([adapter.requests[index]?.system, adapter.requests[index]?.messages])

describe('the shipped fork-style rows, booted through the Loader', () => {
  it('learns a persona and a meme and shows both to the other channels, each preset with its own tools', async () => {
    const note = { kind: 'meme', term: '烧心', meaning: '又贵又膈应的调侃', example: '贵是贵点，但吃了不烧心' }
    const card = { card: '傲娇猫娘，嘴硬心软，被夸就炸毛，常用「哼」「才不是呢」。', reason: '群里和评论区都嘴硬' }
    const h = await boot({
      script: [
        // unattended Session: search the web, note the meme from the result, write the card.
        toolCallResponse('u1', 'web_search', { query: '烧心 台词' }), toolCallResponse('u2', 'style_note', note),
        toolCallResponse('u3', 'persona_update', card), textResponse('记下了'),
        // mining: the miner's proposal, then its meaning pass (the search fixture explains the word)
        ...minerScript({ propose: fixture('a-propose.json'), meaning: fixture('a-meaning.json') }).slice(0, 2),
        // bili Session: looks the mined meme up, then answers
        toolCallResponse('b1', 'meme_lookup', { term: '电鳗发电机' }), textResponse('哼，才不是呢'),
        // qq-digest Session and up Session
        textResponse('NO_REPLY'), textResponse('NO_REPLY'),
      ],
    })
    // 1. The main agent's Session.
    const main = await turn(h, 'chat', 'unattended', '帮我查查「吃了不烧心」这句台词')
    expect(toolNames(h.adapter, main.first)).toEqual(expect.arrayContaining(['meme_lookup', 'style_note', 'persona_update']))
    const stored = JSON.parse(await readFile(join(h.dir, 'notes.json'), 'utf8')) as {
      notes: Array<{ term: string; source: string }>
      cards: Array<{ version: number; author: string; card: string }>
    }
    expect(stored.notes).toMatchObject([{ term: '烧心', source: 'web' }])
    expect(stored.cards).toMatchObject([{ version: 1, author: 'agent', card: card.card }])
    expect(h.notices).toEqual([expect.objectContaining({ title: '人设卡更新到第 1 版', safety: true })])
    expect(JSON.stringify(h.notices)).not.toContain('傲娇')
    expect((h.guard as ReturnType<typeof fakeGuard>).calls.map(call => (call.options as { purpose: string }).purpose)).toEqual(['style_note', 'persona'])

    // 2. The miner, with the Bilibili hot comments of the fixture video.
    expect(await h.style.mine()).toMatchObject({ kept: 1 })

    // 3. The bili Session: the block leads with the card, lists both memes, and has meme_lookup only.
    const bili = await turn(h, 'bili-1', 'bili', '有人私信了')
    expect(toolNames(h.adapter, bili.first)).toContain('meme_lookup')
    expect(toolNames(h.adapter, bili.first)).not.toContain('style_note')
    expect(toolNames(h.adapter, bili.first)).not.toContain('persona_update')
    const seen = requestText(h.adapter, bili.first)
    expect(seen.indexOf(card.card)).toBeGreaterThan(-1)
    expect(seen.indexOf(card.card)).toBeLessThan(seen.indexOf('海水过滤器'))
    expect(seen).toContain('烧心')
    expect(requestText(h.adapter, bili.last)).toContain('开局一定要选海水过滤器')
    expect(requestText(h.adapter, bili.last)).toContain('meaningSource')

    // 4. The digest Session writes notes and the card, and gets no block and no lookup.
    const digest = (await turn(h, 'digest', 'qq-digest', 'transcript')).first
    expect(toolNames(h.adapter, digest)).toEqual(expect.arrayContaining(['style_note', 'persona_update']))
    expect(toolNames(h.adapter, digest)).not.toContain('meme_lookup')
    expect(requestText(h.adapter, digest)).not.toContain(card.card)

    // 5. The up Session gets all three, and the block.
    const up = (await turn(h, 'up-1', 'up', 'comments arrived')).first
    expect(toolNames(h.adapter, up)).toEqual(expect.arrayContaining(['meme_lookup', 'style_note', 'persona_update']))
    expect(requestText(h.adapter, up)).toContain(card.card)
  })

  it('refuses the card and the note when the guard is not mounted, and the owner is told nothing', async () => {
    const h = await boot({
      guard: 'absent',
      script: [
        toolCallResponse('u1', 'web_search', { query: 'q' }),
        toolCallResponse('u2', 'style_note', { kind: 'meme', term: '烧心', meaning: '又贵又膈应的调侃', example: '贵是贵点，但吃了不烧心' }),
        toolCallResponse('u3', 'persona_update', { card: '傲娇猫娘', reason: 'x' }), textResponse('好'),
      ],
    })
    const { last: end } = await turn(h, 'chat', 'unattended', '查一下')
    const last = requestText(h.adapter, end)
    expect(last.match(/guard_unavailable/gu)).toHaveLength(2)
    expect((await h.style.panel()).notes).toEqual([])
    expect((await h.style.panel()).cards).toEqual([])
    expect(h.notices).toEqual([])
  })
})
