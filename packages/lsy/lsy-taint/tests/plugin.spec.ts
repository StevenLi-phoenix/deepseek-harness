import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Taint from '../src/index.ts'
import { untrustedRequestId } from '../src/origin.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'schedule': { kind: 'schedule' } & ContextFormed
  }
}

const contexts: Context[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

type Source = Parameters<typeof createUserMessage>[0]['source']
const OWNER: Source = { kind: 'user', rpcId: 'owner-1' } as never
const PEER: Source = { kind: 'user', rpcId: untrustedRequestId('bili') } as never

function agentOn(session: Session): Agent {
  return {
    id: session.id, options: {}, session, inbox: unsupportedInbox(), model: { current: () => undefined, select: () => {} }, status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function turn(inputs: Source[], tools: string[] = [], id = 'chat'): Agent {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  for (const source of inputs) session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'hi' }], source }), { surfaceOp: 'append' })
  for (const name of tools) session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId(`${name}-0`), name, arguments: '{}' })
  return agentOn(session)
}

async function mount(config: Partial<Taint.Config> = {}) {
  const notices: Array<{ title: string; body?: string }> = []
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('systemPrompt', { tools: () => () => {} } as never)
  ctx.provide('lsyNotifier', { send: (note: { title: string; body?: string }) => { notices.push(note); return Promise.resolve() } } as never)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  const ran: string[] = []
  for (const toolName of ['cc_send', 'cc_start', 'cc_list_sessions', 'schedule_create', 'watch_create']) {
    ctx.tools.register(defineTool({
      name: toolName,
      description: toolName,
      parameters: {},
      output: { schema: { type: 'json' }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
      execute() { ran.push(toolName); return Promise.resolve({ ok: true }) },
      presentCall: () => ({ card: 'generic', title: toolName, kind: 'other' }),
    }))
  }
  await ctx.plugin(Taint, config)
  const call = async (toolName: string, agent: Agent): Promise<string> => {
    const batch = await ctx.tools.execute({ signal: new AbortController().signal, agent, calls: [{ type: 'tool-call', id: ToolCallId(`${toolName}-call`), name: toolName, arguments: '{}' }] })
    const result = batch.results[0]!.result
    return result.content.map(block => (block.type === 'text' ? block.text : '')).join('\n')
  }
  const endTurn = (agent: Agent): void => {
    ctx.emit('session/event', agent.session, { type: 'turn/end', seq: agent.session.seq as never, time: 0, data: { turn: 1, reason: { kind: 'completed' } } } as SessionEvent)
  }
  return { ctx, call, ran, notices, endTurn }
}

describe('owner-only tools', () => {
  it('lets a clean owner turn message Claude Code', async () => {
    const { call, ran } = await mount()
    expect(await call('cc_send', turn([OWNER]))).toContain('"ok":true')
    expect(await call('cc_start', turn([OWNER]))).toContain('"ok":true')
    expect(ran).toEqual(['cc_send', 'cc_start'])
  })

  it.each([
    ['a message another Session relayed', [PEER], [], 'peer:bili'],
    ['a reminder', [{ kind: 'schedule' } as never], [], 'scheduled'],
    ['an owner turn that read a web page', [OWNER], ['web_fetch'], 'owner+web_fetch'],
  ] satisfies Array<[string, Source[], string[], string]>)('refuses cc_send and cc_start in a turn started by %s, and says why', async (_label, inputs, tools, label) => {
    const { call, ran } = await mount()
    for (const toolName of ['cc_send', 'cc_start']) {
      const text = await call(toolName, turn(inputs, tools))
      expect(text).toContain(`${toolName} is only available in a turn the owner started alone`)
      expect(text).toContain(label)
    }
    expect(ran).toEqual([])
  })

  it('leaves the read-only tool and a call outside any Agent alone', async () => {
    const { call, ran, ctx } = await mount()
    expect(await call('cc_list_sessions', turn([PEER]))).toContain('"ok":true')
    const batch = await ctx.tools.execute({ signal: new AbortController().signal, calls: [{ type: 'tool-call', id: ToolCallId('x'), name: 'cc_send', arguments: '{}' }] })
    expect(batch.results[0]!.result.content.map(block => (block.type === 'text' ? block.text : '')).join('\n')).toContain('"ok":true')
    expect(ran).toEqual(['cc_list_sessions', 'cc_send'])
  })

  it('only logs what it would refuse when enforcement is off', async () => {
    const { call, ran } = await mount({ enforce: false })
    expect(await call('cc_send', turn([PEER]))).toContain('"ok":true')
    expect(ran).toEqual(['cc_send'])
  })

  it('takes the guarded tools from the configuration', async () => {
    const { call, ran } = await mount({ ownerOnlyTools: ['cc_list_sessions'] })
    expect(await call('cc_list_sessions', turn([PEER]))).toContain('only available')
    expect(await call('cc_send', turn([PEER]))).toContain('"ok":true')
    expect(ran).toEqual(['cc_send'])
  })
})

describe('audited tools', () => {
  it('allows a reminder or watch from any turn and tells the owner once per turn where it came from', async () => {
    const { call, ran, notices, endTurn } = await mount()
    const agent = turn([PEER])
    expect(await call('schedule_create', agent)).toContain('"ok":true')
    expect(await call('watch_create', agent)).toContain('"ok":true')
    expect(ran).toEqual(['schedule_create', 'watch_create'])
    expect(notices).toEqual([])
    endTurn(agent)
    await vi.waitFor(() => { expect(notices).toHaveLength(1) })
    expect(notices[0]!.title).toBe('⚠️ 非你本人发起的回合留下了 2 个会在之后触发的东西')
    expect(notices[0]!.body).toContain('· schedule_create（回合来源：peer:bili）')
    expect(notices[0]!.body).toContain('· watch_create（回合来源：peer:bili）')
  })

  it('says nothing about the owner\'s own turn, and nothing when notices are off', async () => {
    const owner = await mount()
    const agent = turn([OWNER])
    await owner.call('schedule_create', agent)
    owner.endTurn(agent)
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(owner.notices).toEqual([])
    const quiet = await mount({ notify: false })
    const peer = turn([PEER])
    await quiet.call('watch_create', peer)
    quiet.endTurn(peer)
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(quiet.notices).toEqual([])
  })

  it('sends a notice that lingers too long even if the turn never ends', async () => {
    vi.useFakeTimers()
    const { call, notices } = await mount()
    await call('schedule_create', turn([PEER]))
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10)
    expect(notices).toHaveLength(1)
  })
})
