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

const contexts: Context[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(dirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true, maxRetries: 5 }) }))
})

const OFF_SOURCES = { qq: { enabled: false }, bili: { enabled: false } }

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'speaking-style-plugin-'))
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
      .ingest([
        { source: 'bili', owner: true, origin: { platform: 'bili', groups: 1, speakers: 2, days: 1 }, at: Date.now(), prompt: '下期什么时候', reply: '刚剪完' },
        { source: 'qq', origin: { platform: 'qq', groups: 1, speakers: 2, days: 1 }, at: Date.now(), prompt: '周末去哪', reply: '宅着' },
      ], 'optional')
    const adapter = new MockAdapter(script)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Style, { dir, ticsFile: join(dir, 'tics.json'), enabled: options.enabled ?? true, ...OFF_SOURCES, hotwatch: { enabled: false } } as Style.Config)
    // The presets' own instance, as the bundle mounts it inside unattended, up, bili, and qqbot.
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

  it('shares the block with the up preset by default and leaves presets outside the list alone', async () => {
    const { ctx, adapter } = await harness([textResponse('NO_REPLY'), textResponse('NO_REPLY')])
    const up = await ctx.agentLoop.create(SessionId('up'), { provider: 'mock', model: 'mock' }, { agentPreset: 'up' } as never)
    await turn(ctx, up, 'comments arrived')
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain(Style.BLOCK_INTRO)
    const digest = await ctx.agentLoop.create(SessionId('digest'), { provider: 'mock', model: 'mock' }, { agentPreset: 'qq-digest' } as never)
    await turn(ctx, digest, 'transcript')
    expect(JSON.stringify(adapter.requests[1]!.messages)).not.toContain(Style.BLOCK_INTRO)
  })

  it('adds nothing while the root plugin is off', async () => {
    const { ctx, adapter } = await harness([textResponse('好')], { enabled: false })
    const agent = await ctx.agentLoop.create(SessionId('chat'), { provider: 'mock', model: 'mock' }, { agentPreset: 'unattended' } as never)
    await turn(ctx, agent, '在吗')
    expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain(Style.STYLE_INTRO)
  })
})

describe('the style service (collect mode)', () => {
  async function mount(config: Partial<Style.Config> = {}) {
    const dir = await tmp()
    await writeFile(join(dir, 'tics.json'), JSON.stringify({ days: { '2026-10-31': { answers: 10, answersWithHits: 4, hits: 5, perLine: {} } } }))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Style, { dir, ticsFile: join(dir, 'tics.json'), ...OFF_SOURCES, hotwatch: { enabled: false }, ...config } as Style.Config)
    return { ctx, style: ctx.get('speakingStyle')!, dir }
  }

  it('answers the panel with samples, limits, and the stock-line trend', async () => {
    const { style } = await mount({ review: 'required' })
    const answer = await style.panel()
    expect(answer).toMatchObject({
      enabled: true, review: 'required', samples: [], notes: [], hot: [], cards: [], running: false, lastRun: null,
      parts: { tone: true, memes: true, traits: true, persona: true },
      limits: { maxActive: 60, maxOwner: 20, maxMemes: 40, maxTraits: 10, cardChars: 600 },
    })
    expect(answer.trend).toEqual([{ day: '2026-10-31', answers: 10, withTics: 4, mainAnswers: 0, meanChars: null }])
  })

  it('removes a sample, refuses bad edits with the panel attached, and offers no way to add text by hand', async () => {
    const { style, dir } = await mount()
    await new StyleStore(join(dir, 'samples.jsonl'), { maxActive: 60, maxOwner: 20, maxPending: 40, maxTombstones: 100 })
      .ingest([{ source: 'qq', origin: { platform: 'qq', groups: 1, speakers: 2, days: 1 }, at: Date.now(), prompt: '在吗', reply: '在' }], 'optional')
    const id = (await style.panel()).samples[0]!.id
    expect(await style.edit({ op: 'remove', id })).toMatchObject({ ok: true, panel: { samples: [] } })
    expect(await style.edit({ op: 'remove', id })).toMatchObject({ ok: false, error: 'not_found' })
    expect(await style.edit({ op: 'add', reply: '会的' })).toMatchObject({ ok: false, error: 'invalid_input' })
    expect(await style.edit('nonsense')).toMatchObject({ ok: false, error: 'invalid_input' })
  })

  it('starts a run on demand without waiting for it, and reports it in the panel', async () => {
    const { style } = await mount()
    expect((await style.collect()).running).toBe(true)
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect((await style.panel()).lastRun).toMatchObject({ trigger: 'manual', seen: 0, qq: { status: 'off' }, bili: { status: 'off' } })
  })

  it('reports counts without text through health(), and the stock-line direction', async () => {
    const { style, dir } = await mount()
    await new StyleStore(join(dir, 'samples.jsonl'), { maxActive: 60, maxOwner: 20, maxPending: 40, maxTombstones: 100 })
      .ingest([{ source: 'qq', origin: { platform: 'qq', groups: 1, speakers: 2, days: 1 }, at: Date.now(), prompt: '在吗', reply: '会的' }], 'optional')
    await style.panel()
    expect(style.health()).toEqual({ kept: 1, pending: 0, review: 'optional', lastRefreshAt: null, ticTrend: null })
    expect(JSON.stringify(style.health())).not.toContain('会的')
    const day = (withTics: number) => ({ day: 'd', answers: 10, withTics, mainAnswers: 0, meanChars: null })
    expect(Style.ticTrend([day(5), day(5), day(5), day(1), day(1), day(1)])).toBe('down')
    expect(Style.ticTrend([day(1), day(5)])).toBe('up')
    expect(Style.ticTrend([day(3), day(3), day(3)])).toBe('flat')
  })

  it('refuses a miner route that names a provider without a model', async () => {
    const dir = await tmp()
    const ctx = new Context()
    contexts.push(ctx)
    await expect(ctx.plugin(Style, { dir, ticsFile: join(dir, 'tics.json'), ...OFF_SOURCES, miner: { provider: 'mock' } } as Style.Config))
      .rejects.toThrow(/miner\.provider and miner\.model/u)
  })

  it('runs nothing and shows no next run while off', async () => {
    const { style } = await mount({ enabled: false })
    expect(await style.runIfDue()).toBeUndefined()
    expect((await style.collect()).running).toBe(false)
    expect((await style.panel()).nextRunAt).toBeNull()
    expect(await style.block('2026-11-01', true)).toBeUndefined()
  })
})
