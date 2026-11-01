import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as Style from '../src/index.ts'
import { StyleStore } from '../src/store.ts'
import { STYLE_COLLECT_PATH, STYLE_EDIT_PATH, STYLE_PATH, type StyleEditAnswer, type StylePanel } from '../src/view.ts'

const contexts: Context[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(dirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true, maxRetries: 5 }) }))
})

interface Route { path: string; methods: readonly string[]; fetch: (request: Request) => Promise<Response> }

const OFF_SOURCES = { qq: { enabled: false }, bili: { enabled: false } }

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lsy-style-plugin-'))
  dirs.push(dir)
  return dir
}

function idle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: seen, status }) => { if (seen === agent && status === 'idle') { dispose(); resolve() } })
  })
}

describe('prompt mode in the real agent loop', () => {
  async function harness(script: ConstructorParameters<typeof MockAdapter>[0], options: { enabled?: boolean } = {}) {
    const dir = await tmp()
    await new StyleStore(join(dir, 'samples.jsonl'), { maxActive: 60, maxOwner: 20, maxPending: 40, maxTombstones: 100 })
      .ingest([{ source: 'owner-bili', at: Date.now(), prompt: '下期什么时候', reply: '刚剪完' }, { source: 'qq-group', at: Date.now(), prompt: '周末去哪', reply: '宅着' }], 'optional')
    const adapter = new MockAdapter(script)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Style, { dir, ticsFile: join(dir, 'tics.json'), enabled: options.enabled ?? true, ...OFF_SOURCES } as Style.Config)
    // The preset's own instance, as the bundle mounts it inside `unattended`.
    await ctx.plugin({ name: 'preset-scope', apply: async (scope: Context) => { await scope.plugin(Style, { mode: 'prompt' } as Style.Config) } })
    ctx.llm.registerAdapter(['mock'], adapter)
    return { ctx, adapter, dir }
  }

  const turn = async (ctx: Context, agent: Agent, text: string): Promise<void> => {
    const done = idle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', rpcId: `owner-${text}` } as never }))
    await done
  }

  it('puts the day\'s block after the owner\'s message of an unattended root Session, once per day', async () => {
    const { ctx, adapter } = await harness([textResponse('好'), textResponse('嗯')])
    const agent = await ctx.agentLoop.create(SessionId('chat'), { provider: 'mock', model: 'mock' }, { agentPreset: 'unattended' } as never)
    await turn(ctx, agent, '有从 QQ 学习吗?')
    const first = JSON.stringify(adapter.requests[0]!.messages)
    expect(first).toContain(Style.STYLE_INTRO)
    expect(first).toContain('刚剪完')
    expect(first.indexOf('有从 QQ 学习吗?')).toBeLessThan(first.indexOf(Style.STYLE_INTRO))
    await turn(ctx, agent, '会的. 绝对会的')
    const second = JSON.stringify(adapter.requests[1]!.messages)
    expect(second.split(Style.STYLE_INTRO)).toHaveLength(2)
  })

  it('counts the main agent\'s answers and their length for the page, never their text', async () => {
    const { ctx, dir } = await harness([textResponse('好的呀'), textResponse('NO_REPLY')])
    const agent = await ctx.agentLoop.create(SessionId('chat'), { provider: 'mock', model: 'mock' }, { agentPreset: 'unattended' } as never)
    await turn(ctx, agent, '在吗')
    await turn(ctx, agent, '睡了吗')
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    const raw = await readFile(join(dir, 'answers.json'), 'utf8')
    expect(Object.values((JSON.parse(raw) as { days: Record<string, unknown> }).days)).toEqual([{ answers: 1, chars: 3 }])
    expect(raw).not.toContain('好的呀')
  })

  it('leaves other presets alone', async () => {
    const { ctx, adapter } = await harness([textResponse('NO_REPLY')])
    const agent = await ctx.agentLoop.create(SessionId('up'), { provider: 'mock', model: 'mock' }, { agentPreset: 'up' } as never)
    await turn(ctx, agent, 'comments arrived')
    expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain(Style.STYLE_INTRO)
  })

  it('adds nothing while the root plugin is off', async () => {
    const { ctx, adapter } = await harness([textResponse('好')], { enabled: false })
    const agent = await ctx.agentLoop.create(SessionId('chat'), { provider: 'mock', model: 'mock' }, { agentPreset: 'unattended' } as never)
    await turn(ctx, agent, '在吗')
    expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain(Style.STYLE_INTRO)
  })
})

describe('collect mode routes', () => {
  async function mount(config: Partial<Style.Config> = {}) {
    const dir = await tmp()
    await writeFile(join(dir, 'tics.json'), JSON.stringify({ days: { '2026-10-31': { answers: 10, answersWithHits: 4, hits: 5, perLine: {} } } }))
    const ctx = new Context()
    contexts.push(ctx)
    const routes: Route[] = []
    ctx.provide('connection', { fetch: { register: (route: Route) => { routes.push(route); return () => Promise.resolve() } } } as never)
    await ctx.plugin(Style, { dir, ticsFile: join(dir, 'tics.json'), ...OFF_SOURCES, ...config } as Style.Config)
    const route = (path: string): Route => routes.find(candidate => candidate.path === path)!
    const panel = async (): Promise<StylePanel> => await (await route(STYLE_PATH).fetch(new Request('http://h/api/lsy.style'))).json() as StylePanel
    const edit = async (body: unknown): Promise<{ status: number; answer: StyleEditAnswer }> => {
      const response = await route(STYLE_EDIT_PATH).fetch(new Request('http://h/api/lsy.style.edit', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }))
      return { status: response.status, answer: await response.json() as StyleEditAnswer }
    }
    return { ctx, routes, route, panel, edit, dir }
  }

  it('registers the panel, edit, and collect routes under /api', async () => {
    const { routes } = await mount()
    expect(routes.map(route => [route.path, route.methods])).toEqual([[STYLE_PATH, ['GET']], [STYLE_EDIT_PATH, ['POST']], [STYLE_COLLECT_PATH, ['POST']]])
  })

  it('answers the panel with samples, limits, and the stock-line trend', async () => {
    const { panel } = await mount({ review: 'required' })
    const answer = await panel()
    expect(answer).toMatchObject({ enabled: true, review: 'required', samples: [], running: false, lastRun: null, limits: { maxActive: 60, maxOwner: 20, maxChars: 60 } })
    expect(answer.trend).toEqual([{ day: '2026-10-31', answers: 10, withTics: 4, mainAnswers: 0, meanChars: null }])
  })

  it('adds the owner\'s line, removes a sample, and refuses bad edits with the panel attached', async () => {
    const { edit } = await mount()
    const added = await edit({ op: 'add', reply: '会的. 绝对会的' })
    expect(added.status).toBe(200)
    expect(added.answer.panel.samples).toMatchObject([{ source: 'owner-manual', reply: '会的. 绝对会的', status: 'active' }])
    const id = added.answer.panel.samples[0]!.id
    const removed = await edit({ op: 'remove', id })
    expect(removed.answer).toMatchObject({ ok: true, panel: { samples: [] } })
    expect((await edit({ op: 'remove', id })).status).toBe(404)
    expect((await edit({ op: 'add', reply: '' })).answer).toMatchObject({ ok: false, error: 'invalid_input' })
    expect((await edit('{not json')).status).toBe(400)
    expect((await edit({ op: 'explode' })).status).toBe(400)
  })

  it('starts a run on demand without waiting for it, and reports it in the panel', async () => {
    const { route, panel } = await mount()
    const response = await route(STYLE_COLLECT_PATH).fetch(new Request('http://h/api/lsy.style.collect', { method: 'POST' }))
    expect(((await response.json()) as StylePanel).running).toBe(true)
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect((await panel()).lastRun).toMatchObject({ trigger: 'manual', seen: 0, qq: { status: 'off' }, bili: { status: 'off' } })
  })
})
