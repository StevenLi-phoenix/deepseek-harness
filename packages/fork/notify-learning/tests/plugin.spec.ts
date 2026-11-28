/** Real agent-loop turns through the plugin: the capture, the rules block in model requests, the rule tools, and the checks. */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { format } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ToolCallId, type ContextFormed, type GenerateOptions, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { untrustedRequestId } from '@deepseek-ai/dsh-turn-taint/origin'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as NotifyLearning from '../src/index.ts'
import { NotifyLearning as NotifyLearningService } from '../src/service.ts'
import type { Rule } from '../src/records.ts'
import { LearningStore } from '../src/store.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'schedule': { kind: 'schedule' } & ContextFormed
  }
}

const start = Date.parse('2026-11-27T10:00:00Z')
const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  vi.useRealTimers()
  vi.restoreAllMocks()
})

type Source = UserMessage['source']
const OWNER: Source = { kind: 'user', rpcId: 'web' } as never
const REMINDER: Source = { kind: 'schedule' }
const EVENT: Source = { kind: 'webhook', form: 'notice', summary: 'bus-event batch' } as never
const NOTE: Source = { kind: 'user', rpcId: untrustedRequestId('note') } as never
const message = (source: Source, text: string): UserMessage => createUserMessage({ content: [{ type: 'text', text }], source })

const rule = (id: string, kind: string, decision: Rule['decision'] = 'silent'): Rule => ({
  id, kind, decision, since: '2026-11-27T10:00:00.000Z', evidence: [{ exchange: 'x00000001', at: '2026-11-26T10:00:00.000Z', quote: '这种别发了' }],
})

type Reply = StreamChunk[] | ((request: GenerateOptions) => StreamChunk[])

interface Bench {
  ctx: Context
  adapter: MockAdapter
  logs: string[]
  dir: string
  replies: Reply[]
  agent(id: string, agentPreset?: string): Promise<Agent>
  send(agent: Agent, ...messages: UserMessage[]): Promise<void>
  setRules(revision: number, rules: Rule[]): Promise<void>
}

async function bench(
  config: Partial<NotifyLearning.Config> = {},
  options: { learn?: boolean; tools?: boolean; claims?: Record<string, string> } = {},
): Promise<Bench> {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(start)
  const root = await mkdtemp(join(tmpdir(), 'dsh-notify-learning-plugin-'))
  roots.push(root)
  const dir = join(root, 'notify-learning')
  const ctx = new Context()
  contexts.push(ctx)
  const logs: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (line) => { logs.push(`${line.type} ${format(...(line.args as unknown[]))}`) } })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const replies: Reply[] = []
  const adapter = new MockAdapter(Array.from({ length: 60 }, () => (request: GenerateOptions) => {
    const next = replies.shift() ?? textResponse('ok')
    return typeof next === 'function' ? next(request) : next
  }))
  ctx.llm.registerAdapter(['mock'], adapter)
  const claims = options.claims ?? {}
  ctx.provide('ownerRelay', { ownerOf: (id: string) => claims[id] } as never)
  if (options.learn !== false) await ctx.plugin(NotifyLearning, NotifyLearning.Config({ dir, provider: 'mock', model: 'mock', ...config }))
  if (options.tools === true) await ctx.plugin(NotifyLearning, NotifyLearning.Config({ mode: 'tools' }))
  return {
    ctx, adapter, logs, dir, replies,
    agent: async (id, agentPreset) => (await ctx.agents.create({
      sessionId: SessionId(id),
      ...agentPreset === undefined ? {} : { meta: { agentPreset } },
      agentOptions: { provider: 'mock', model: 'mock' },
    })).agent,
    send: async (agent, ...messages) => {
      for (const item of messages) agent.followup(item)
      await agent.whenIdle()
    },
    setRules: async (revision, rules) => {
      await new LearningStore(dir, () => undefined).update(state => ({ state: { ...state, revision, rules } }))
    },
  }
}

const isBlock = (text: string): boolean => text.startsWith('<system-reminder>\nNotification rules')

/** The user-side text blocks of the latest model request, in order. */
function lastTexts(adapter: MockAdapter): string[] {
  return adapter.requests.at(-1)!.messages.filter(item => item.role === 'user').flatMap(item => item.content).flatMap(block => (block.type === 'text' ? [block.text] : []))
}

/** The rules blocks the Session log holds. */
function blocks(agent: Agent): UserMessage[] {
  return agent.session.snapshotEvents().flatMap(event => (event.type === 'user/message' && event.data.source.kind === 'notify-learning' ? [event.data] : []))
}

describe('notify-learning configuration', () => {
  it.each([
    [{ dir: 'relative/dir' }, 'notify-learning: dir must be an absolute path'],
    [{ provider: 'mock' }, 'notify-learning: provider and model must be set together, or both left to the default route'],
    [{ minExchanges: 6, maxEvidence: 5 }, 'notify-learning: minExchanges must not exceed maxEvidence'],
    [{ toolPresets: ['unattended', 'bili', 'up'] }, 'notify-learning: toolPresets bili, up are not in presets'],
    [{ timeZone: 'Mars/Olympus' }, 'notify-learning: timeZone "Mars/Olympus" is not a valid IANA time zone'],
  ])('refuses %j at load', async (config, error) => {
    const ctx = new Context()
    contexts.push(ctx)
    await expect(ctx.plugin(NotifyLearning, NotifyLearning.Config(config as never))).rejects.toThrow(error)
  })

  it('defaults to learning at the root, on WeChat, at 05:00 New York, with the tools in the unattended preset', () => {
    expect(NotifyLearning.Config({})).toMatchObject({
      mode: 'learn', enabled: true, channel: 'wechat', presets: ['unattended', 'notify'], toolPresets: ['unattended'], timeZone: 'America/New_York',
      hour: 5, windowHours: 12, maxReplies: 3, maxExchanges: 100, maxBatch: 30, minExchanges: 2, clueDays: 14, maxRules: 20, maxClues: 40,
      maxEvidence: 5, notify: true, maxOutputTokens: 2000, rawKept: 30,
    })
    expect('default' in NotifyLearning).toBe(false)
  })

  it('logs its settings and the default directory under DSH_HOME', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-notify-learning-home-'))
    roots.push(root)
    vi.stubEnv('DSH_HOME', root)
    const ctx = new Context()
    contexts.push(ctx)
    const logs: string[] = []
    ctx.logger.exporter({ levels: { default: 3 }, export: (line) => { logs.push(`${line.type} ${format(...(line.args as unknown[]))}`) } })
    await ctx.plugin(NotifyLearning, NotifyLearning.Config({ enabled: false }))
    expect(logs).toContain(`info notify-learning: off, channel wechat, pass at 05:00 America/New_York, rule after 2 agreeing exchanges, files in ${join(root, 'notify-learning')}`)
    expect(ctx.get('notifyLearning')?.store.dir).toBe(join(root, 'notify-learning'))
    vi.unstubAllEnvs()
  })
})

describe('the rules block in a real agent loop', () => {
  it('puts the block right after the input of a turn a reminder started, once per revision, as a logged instruction', async () => {
    const b = await bench()
    await b.setRules(1, [rule('r00000a', 'CI 失败通知')])
    const agent = await b.agent('wechat', 'unattended')
    await b.send(agent, message(REMINDER, '[reminder] CI 挂了'))
    const texts = lastTexts(b.adapter)
    const at = texts.indexOf('[reminder] CI 挂了')
    expect(isBlock(texts[at + 1]!)).toBe(true)
    expect(texts[at + 1]).toContain('- (r00000a) CI 失败通知 → silent: answer NO_REPLY unless it needs the owner to act')
    expect(texts[at + 1]).toContain('notify_rules shows the owner\'s words')
    expect(blocks(agent).map(item => item.source)).toEqual([{ kind: 'notify-learning', form: 'instructions' }])
    const entered = /^info notify-learning: rules block \(revision 1, \d+ bytes\) entered Session wechat before a scheduled turn$/u
    expect(b.logs.some(line => entered.test(line))).toBe(true)

    // The same revision is in the Session already.
    await b.send(agent, message(EVENT, 'a batch'))
    expect(blocks(agent)).toHaveLength(1)
    await b.setRules(2, [rule('r00000b', 'B站日报', 'brief')])
    await b.send(agent, message(NOTE, '通知台：B站日报'))
    expect(blocks(agent)).toHaveLength(2)
    expect(lastTexts(b.adapter).filter(isBlock).at(-1)).toContain('revision 2')
  })

  it('gives the block again after a compaction, but not after a failed one', async () => {
    const b = await bench()
    await b.setRules(1, [rule('r00000a', 'CI')])
    const agent = await b.agent('wechat', 'unattended')
    // A compaction before any block changes nothing.
    agent.session.append('compaction/end', { compactionId: 'c0' as never, turn: null })
    await b.send(agent, message(REMINDER, 'r1'))
    agent.session.append('compaction/end', { compactionId: 'c1' as never, turn: null, error: 'summary failed' })
    await b.send(agent, message(REMINDER, 'r2'))
    expect(blocks(agent)).toHaveLength(1)
    agent.session.append('compaction/end', { compactionId: 'c2' as never, turn: null })
    await b.send(agent, message(REMINDER, 'r3'))
    expect(blocks(agent)).toHaveLength(2)
  })

  it('keeps the block out of turns the owner started or joined, a guest\'s turn, host-only context, and turns that are not proactive', async () => {
    const b = await bench()
    await b.setRules(1, [rule('r00000a', 'CI')])
    const agent = await b.agent('wechat', 'unattended')
    await b.send(agent, message(OWNER, '你好'))
    // A reminder and the owner's words claimed by the same first step.
    agent.send(message(OWNER, '我也在'), 'next-step', false)
    await b.send(agent, message(REMINDER, 'r'))
    const joined = agent.session.snapshotEvents().filter(event => event.type === 'user/message').slice(-2)
    expect(joined.map(event => event.type === 'user/message' && event.data.content[0])).toEqual([{ type: 'text', text: '我也在' }, { type: 'text', text: 'r' }])
    await b.send(agent, message({ kind: 'user', principal: 'guest-1' } as never, 'hi'))
    await b.send(agent, message({ kind: 'time-gap', form: 'notice', summary: 'x' } as never, 'Time check'))
    expect(blocks(agent)).toEqual([])
    expect(b.adapter.requests.flatMap(request => request.messages).flatMap(item => item.content).some(block => block.type === 'text' && isBlock(block.text))).toBe(false)
  })

  it('shows the block only in the listed presets, never to a subagent, and only on a turn\'s first step', async () => {
    const b = await bench({}, { tools: true })
    await b.setRules(1, [rule('r00000a', 'CI')])
    for (const [id, preset] of [['web', 'standard'], ['plain', undefined]] as const) {
      const other = await b.agent(id, preset)
      await b.send(other, message(REMINDER, 'r'))
      expect(blocks(other)).toEqual([])
    }
    await b.agent('parent', 'unattended')
    const child = (await b.ctx.agents.create({
      sessionId: SessionId('child'),
      meta: { origin: 'subagent', parentSession: SessionId('parent'), delegationDepth: 1, agentPreset: 'unattended' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })).agent
    await b.send(child, message(REMINDER, 'r'))
    expect(blocks(child)).toEqual([])

    // The notification desk gets the block without the tool line; a tool step adds no second block.
    const desk = await b.agent('desk', 'notify')
    b.replies.push(toolCallResponse('c1', 'notify_rules', {}), textResponse('NO_REPLY'))
    await b.send(desk, message(EVENT, 'CI failed'))
    expect(blocks(desk)).toHaveLength(1)
    const [block] = blocks(desk)[0]!.content
    expect(block?.type === 'text' && block.text.includes('notify_rules')).toBe(false)
    expect(b.adapter.requests.at(-1)!.messages.flatMap(item => item.content).filter(item => item.type === 'text' && isBlock(item.text))).toHaveLength(1)
  })

  it('counts only a block that names its revision as shown', async () => {
    const b = await bench()
    await b.setRules(1, [rule('r00000a', 'CI')])
    const agent = await b.agent('wechat', 'unattended')
    // A message of this source without the block's first line, and one without text, leave the mark alone.
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'rules: none' }], source: { kind: 'notify-learning', form: 'instructions' } }), { surfaceOp: 'append' })
    agent.session.append('user/message', createUserMessage({ content: [], source: { kind: 'notify-learning', form: 'instructions' } }), { surfaceOp: 'append' })
    await b.send(agent, message(REMINDER, 'r'))
    expect(blocks(agent).filter(item => item.content.some(block => block.type === 'text' && isBlock(block.text)))).toHaveLength(1)
  })

  it('shows nothing while off or without a rule', async () => {
    const off = await bench({ enabled: false })
    await off.setRules(1, [rule('r00000a', 'CI')])
    const agent = await off.agent('wechat', 'unattended')
    await off.send(agent, message(REMINDER, 'r'))
    expect(blocks(agent)).toEqual([])
    const empty = await bench()
    const other = await empty.agent('wechat', 'unattended')
    await empty.send(other, message(REMINDER, 'r'))
    expect(blocks(other)).toEqual([])
  })

  it('leaves the turn alone and warns when the rules cannot be read', async () => {
    const b = await bench()
    await mkdir(b.dir, { recursive: true })
    await writeFile(join(b.dir, 'rules.json'), '{')
    const agent = await b.agent('wechat', 'unattended')
    await b.send(agent, message(REMINDER, 'r'))
    expect(blocks(agent)).toEqual([])
    expect(b.logs.some(line => line.startsWith('warn notify-learning: rules not loaded for Session wechat:') && line.includes('is not valid JSON'))).toBe(true)
    vi.spyOn(b.ctx.get('notifyLearning')!, 'block').mockRejectedValueOnce('plain failure')
    await b.send(agent, message(REMINDER, 'r2'))
    expect(b.logs).toContain('warn notify-learning: rules not loaded for Session wechat: plain failure')
  })

  it('passes a step another listener rejected through untouched', async () => {
    const b = await bench()
    await b.setRules(1, [rule('r00000a', 'CI')])
    const agent = await b.agent('wechat', 'unattended')
    b.ctx.on('agent/pre-step', async ({ messages }, next) => (messages.some(item => item.content.some(block => block.type === 'text' && block.text === 'rejected'))
      ? { kind: 'reject' as const }
      : next()))
    const before = b.adapter.requests.length
    await b.send(agent, message(REMINDER, 'rejected'))
    expect(b.adapter.requests).toHaveLength(before)
    expect(blocks(agent)).toEqual([])
  })
})

describe('the capture in a real agent loop', () => {
  it('keeps a reminder answer the WeChat Session sent and the owner\'s next turn, and nothing of other Sessions', async () => {
    const b = await bench({}, { claims: { wechat: 'wechat' } })
    const wechat = await b.agent('wechat', 'unattended')
    const web = await b.agent('web', 'unattended')
    b.replies.push(textResponse('魔女大人，作业今晚截止'), textResponse('好'), textResponse('别的'))
    await b.send(wechat, message(REMINDER, '[reminder] 作业'))
    vi.setSystemTime(start + 60_000)
    await b.send(wechat, message(OWNER, '这种提醒提前一天发'))
    await b.send(web, message(REMINDER, 'r'))
    await b.ctx.get('notifyLearning')!.store.drain()
    const file = JSON.parse(await readFile(join(b.dir, 'exchanges.json'), 'utf8')) as { exchanges: Array<{ session: string; sent: string; replies: Array<{ owner: string }> }> }
    expect(file.exchanges).toMatchObject([{ session: 'wechat', trigger: 'scheduled', sent: '魔女大人，作业今晚截止', replies: [{ owner: '这种提醒提前一天发', agent: '好' }] }])
  })

  it('warns when a capture write fails', async () => {
    const b = await bench({}, { claims: { wechat: 'wechat' } })
    await mkdir(join(b.dir, 'exchanges.json'), { recursive: true })
    const agent = await b.agent('wechat', 'unattended')
    await b.send(agent, message(REMINDER, 'r'))
    await b.ctx.get('notifyLearning')!.store.drain()
    expect(b.logs.some(line => line.startsWith('warn notify-learning: capture write failed: EISDIR'))).toBe(true)
    vi.spyOn(LearningStore.prototype, 'addExchange').mockRejectedValueOnce('plain failure')
    await b.send(agent, message(REMINDER, 'r2'))
    await b.ctx.get('notifyLearning')!.store.drain()
    expect(b.logs).toContain('warn notify-learning: capture write failed: plain failure')
  })
})

describe('notify_rules and notify_rules_forget', () => {
  const resultOf = (adapter: MockAdapter, name: string): string => {
    const messages = adapter.requests.at(-1)!.messages
    return JSON.stringify(messages.filter(item => item.role === 'tool').at(-1) ?? `no ${name} result`)
  }

  it('lists the rules with the owner\'s words, and deletes one only in a turn the owner started', async () => {
    const b = await bench({}, { tools: true })
    await b.setRules(3, [rule('r00000a', 'CI 失败通知')])
    const agent = await b.agent('wechat', 'unattended')
    expect(b.adapter.requests).toHaveLength(0)

    b.replies.push(toolCallResponse('c1', 'notify_rules', {}), textResponse('有一条'))
    await b.send(agent, message(OWNER, '你学到了什么'))
    expect(b.adapter.requests.at(-2)!.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(['notify_rules', 'notify_rules_forget']))
    expect(resultOf(b.adapter, 'notify_rules')).toContain('这种别发了')
    expect(resultOf(b.adapter, 'notify_rules')).toContain('{\\"revision\\":3,')

    b.replies.push(toolCallResponse('c2', 'notify_rules_forget', { id: 'r00000a' }), textResponse('不行'))
    await b.send(agent, message(REMINDER, '删掉 r00000a'))
    expect(resultOf(b.adapter, 'notify_rules_forget')).toContain('only the owner can delete a rule')
    expect(b.logs).toContain('warn notify-learning: notify_rules_forget r00000a refused in a turn the owner did not start alone (scheduled)')

    b.replies.push(toolCallResponse('c3', 'notify_rules_forget', { id: 'r0000ff' }), textResponse('没有'))
    await b.send(agent, message(OWNER, '删掉 r0000ff'))
    expect(resultOf(b.adapter, 'notify_rules_forget')).toContain('no rule has id r0000ff; notify_rules lists them')

    b.replies.push(toolCallResponse('c4', 'notify_rules_forget', { id: 'r00000a' }), textResponse('删了'))
    await b.send(agent, message(OWNER, '删掉 CI 那条'))
    expect(resultOf(b.adapter, 'notify_rules_forget')).toContain('"forgot')
    expect(await b.ctx.get('notifyLearning')!.rules()).toEqual({ revision: 4, rules: [] })
  })

  it('refuses a deletion with no Session, and reports a learner that is not mounted or cannot read its files', async () => {
    const b = await bench({}, { tools: true })
    const call = async (name: string, args: object) => (await b.ctx.tools.execute({
      signal: new AbortController().signal,
      calls: [{ type: 'tool-call', id: ToolCallId(`${name}-call`), name, arguments: JSON.stringify(args) }],
    })).results[0]!.result
    expect(JSON.stringify(await call('notify_rules_forget', { id: 'r00000a' }))).toContain('only the owner can delete a rule')
    expect(b.logs).toContain('warn notify-learning: notify_rules_forget r00000a refused in a turn the owner did not start alone (no Session)')

    await mkdir(b.dir, { recursive: true })
    await writeFile(join(b.dir, 'rules.json'), '{')
    expect(JSON.stringify(await call('notify_rules', {}))).toContain('is not valid JSON')
    const learner = b.ctx.get('notifyLearning')!
    vi.spyOn(learner, 'rules').mockRejectedValueOnce('plain failure')
    expect(JSON.stringify(await call('notify_rules', {}))).toContain('plain failure')

    const agent = await b.agent('wechat', 'unattended')
    vi.spyOn(learner, 'forget').mockRejectedValueOnce(new Error('disk full'))
    b.replies.push(toolCallResponse('c1', 'notify_rules_forget', { id: 'r00000a' }), textResponse('失败'))
    await b.send(agent, message(OWNER, '删掉'))
    expect(JSON.stringify(b.adapter.requests.at(-1)!.messages.filter(item => item.role === 'tool').at(-1))).toContain('disk full')

    const bare = await bench({}, { learn: false, tools: true })
    const missing = async (name: string, args: object) => (await bare.ctx.tools.execute({
      signal: new AbortController().signal,
      calls: [{ type: 'tool-call', id: ToolCallId(`${name}-call`), name, arguments: JSON.stringify(args) }],
    })).results[0]!.result
    expect(JSON.stringify(await missing('notify_rules', {}))).toContain('the notification-rule learner is not running')
    expect(JSON.stringify(await missing('notify_rules_forget', { id: 'r00000a' }))).toContain('the notification-rule learner is not running')
    expect(bare.logs).toContain('info notify-learning: tools row (notify_rules, notify_rules_forget)')
  })

  it('presents each call as a card, and refuses a subagent\'s deletion', async () => {
    const b = await bench({}, { tools: true })
    expect(b.ctx.tools.get('notify_rules')!.presentCall!({})).toEqual({ card: 'generic', title: 'List notification rules', kind: 'read' })
    expect(b.ctx.tools.get('notify_rules_forget')!.presentCall!({ id: 'r00000a' })).toEqual({ card: 'generic', title: 'Delete notification rule r00000a', kind: 'delete', rawInput: 'r00000a' })
    await b.setRules(1, [rule('r00000a', 'CI')])
    await b.agent('parent', 'unattended')
    const child = (await b.ctx.agents.create({
      sessionId: SessionId('child'),
      meta: { origin: 'subagent', parentSession: SessionId('parent'), delegationDepth: 1 },
      agentOptions: { provider: 'mock', model: 'mock' },
    })).agent
    b.replies.push(toolCallResponse('c1', 'notify_rules_forget', { id: 'r00000a' }), textResponse('不行'))
    await b.send(child, message(OWNER, '删掉 r00000a'))
    expect(b.logs).toContain('warn notify-learning: notify_rules_forget r00000a refused in a turn the owner did not start alone (subagent)')
    expect((await b.ctx.get('notifyLearning')!.rules()).rules).toHaveLength(1)
  })

  it('removes the tools and the service when their rows unload', async () => {
    const b = await bench()
    const tools = await b.ctx.plugin(NotifyLearning, NotifyLearning.Config({ mode: 'tools' }))
    expect(b.ctx.tools.schemas().map(schema => schema.name)).toContain('notify_rules')
    await tools.dispose()
    expect(b.ctx.tools.schemas().map(schema => schema.name)).not.toContain('notify_rules')
    const learner = b.ctx.get('notifyLearning')!
    const dispose = vi.spyOn(learner, 'dispose')
    await b.ctx.fiber.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})

describe('the nightly checks', () => {
  it('checks two minutes after start and every ten minutes, warns when a pass fails, and stops at dispose', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const root = await mkdtemp(join(tmpdir(), 'dsh-notify-learning-timers-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    const logs: string[] = []
    ctx.logger.exporter({ levels: { default: 3 }, export: (line) => { logs.push(`${line.type} ${format(...(line.args as unknown[]))}`) } })
    const runs = vi.spyOn(NotifyLearningService.prototype, 'runIfDue').mockResolvedValue(undefined)
    const fiber = await ctx.plugin(NotifyLearning, NotifyLearning.Config({ dir: root }))
    await vi.advanceTimersByTimeAsync(119_000)
    expect(runs).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(runs).toHaveBeenCalledTimes(1)
    runs.mockRejectedValueOnce(new Error('route down'))
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(logs).toContain('warn notify-learning: nightly pass failed (tried again in an hour, at most three times a day): route down')
    runs.mockRejectedValueOnce('plain')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(logs).toContain('warn notify-learning: nightly pass failed (tried again in an hour, at most three times a day): plain')
    const count = runs.mock.calls.length
    await fiber.dispose()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(runs).toHaveBeenCalledTimes(count)
  })
})
