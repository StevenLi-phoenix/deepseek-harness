import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
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

interface MountOptions {
  /** Pass the configuration to `apply` as given, without the schema filling in defaults. */
  raw?: boolean
  /** `none` registers no notifier; `fail` and `fail-text` register one whose send rejects with an Error or a bare string. */
  notifier?: 'none' | 'fail' | 'fail-text'
  /** Live Sessions the plugin may look a parent up in. */
  sessions?: (id: string) => Session | undefined
}

async function mount(config: Partial<Taint.Config> = {}, options: MountOptions = {}) {
  const notices: Array<{ title: string; body?: string }> = []
  const logs: string[] = []
  const ctx = new Context()
  contexts.push(ctx)
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push(`${message.type} ${message.args.map(String).join(' ')}`) } })
  ctx.provide('systemPrompt', { tools: () => () => {} } as never)
  // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- A bare string rejection is the case under test.
  const rejectText = (): Promise<void> => Promise.reject('busy')
  if (options.notifier === 'fail-text') ctx.provide('lsyNotifier', { send: (note: { title: string; body?: string }) => { notices.push(note); return rejectText() } } as never)
  else if (options.notifier === 'fail') ctx.provide('lsyNotifier', { send: (note: { title: string; body?: string }) => { notices.push(note); return Promise.reject(new Error('wechat down')) } } as never)
  else if (options.notifier !== 'none') ctx.provide('lsyNotifier', { send: (note: { title: string; body?: string }) => { notices.push(note); return Promise.resolve() } } as never)
  if (options.sessions !== undefined) ctx.provide('sessions', { get: options.sessions } as never)
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
  if (options.raw === true) await ctx.plugin({ name: 'lsy-taint-raw', apply: (inner: Context) => { Taint.apply(inner, config) } })
  else await ctx.plugin(Taint, config)
  const call = async (toolName: string, agent: Agent): Promise<string> => {
    const batch = await ctx.tools.execute({ signal: new AbortController().signal, agent, calls: [{ type: 'tool-call', id: ToolCallId(`${toolName}-call`), name: toolName, arguments: '{}' }] })
    const result = batch.results[0]!.result
    return result.content.map(block => (block.type === 'text' ? block.text : '')).join('\n')
  }
  const endTurn = (agent: Agent): void => {
    ctx.emit('session/event', agent.session, { type: 'turn/end', seq: agent.session.seq as never, time: 0, data: { turn: 1, reason: { kind: 'completed' } } } as SessionEvent)
  }
  return { ctx, call, ran, notices, logs, endTurn }
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

  it('lets LSY_TAINT_ENFORCE=0 in the environment switch the refusal off', async () => {
    vi.stubEnv('LSY_TAINT_ENFORCE', '0')
    try {
      const { call, ran } = await mount()
      expect(await call('cc_send', turn([PEER]))).toContain('"ok":true')
      expect(ran).toEqual(['cc_send'])
    } finally {
      vi.unstubAllEnvs()
    }
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
    expect(notices[0]!.title).toBe('一次不是你本人发起的回合（来源：B站猫猫的传话）设置了 2 个之后会自己触发的东西')
    expect(notices[0]).toMatchObject({ safety: true })
    expect(notices[0]!.body).toBe('· 定时提醒（schedule_create）\n· 监控（watch_create）')
    expect(JSON.stringify(notices[0])).not.toMatch(/让我|回复|告诉我/u)
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

describe('defaults without a configuration', () => {
  it('refuses the owner-only tools and audits the lingering ones when apply gets an empty configuration', async () => {
    const { call, ran, notices, logs, endTurn } = await mount({}, { raw: true })
    expect(logs[0]).toContain('enforce %s (%s)')
    expect(logs[0]).toContain(' on ')
    expect(logs[0]).toContain('cc_send, cc_start')
    expect(await call('cc_send', turn([PEER]))).toContain('only available')
    const agent = turn([PEER])
    expect(await call('schedule_create', agent)).toContain('"ok":true')
    endTurn(agent)
    await vi.waitFor(() => { expect(notices).toHaveLength(1) })
    expect(ran).toEqual(['schedule_create'])
  })
})

describe('audit notice delivery', () => {
  it('drops the queued lines without error when no notifier is mounted', async () => {
    const { call, notices, logs, endTurn } = await mount({}, { notifier: 'none' })
    const agent = turn([PEER])
    await call('schedule_create', agent)
    endTurn(agent)
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(notices).toEqual([])
    expect(logs.filter(line => line.includes('told the owner'))).toEqual([])
  })

  it('shows the first six audited calls and counts the rest', async () => {
    const { call, notices, endTurn } = await mount()
    const agent = turn([PEER])
    for (let index = 0; index < 7; index += 1) await call('schedule_create', agent)
    endTurn(agent)
    await vi.waitFor(() => { expect(notices).toHaveLength(1) })
    expect(notices[0]!.title).toContain('设置了 7 个')
    expect(notices[0]!.body!.split('\n')).toEqual([...Array.from({ length: 6 }, () => '· 定时提醒（schedule_create）'), '…另有 1 个'])
  })

  it('names an audited tool outside the built-in list by its own name', async () => {
    const { call, notices, endTurn } = await mount({ auditedTools: ['cc_list_sessions'] })
    const agent = turn([PEER])
    await call('cc_list_sessions', agent)
    endTurn(agent)
    await vi.waitFor(() => { expect(notices).toHaveLength(1) })
    expect(notices[0]!.body).toBe('· cc_list_sessions（cc_list_sessions）')
  })

  it('logs a warning when the notice cannot be sent', async () => {
    const { call, notices, logs, endTurn } = await mount({}, { notifier: 'fail' })
    const agent = turn([PEER])
    await call('watch_create', agent)
    endTurn(agent)
    await vi.waitFor(() => { expect(logs.some(line => line.includes('audit notice for session') && line.endsWith('wechat down'))).toBe(true) })
    expect(notices).toHaveLength(1)
  })

  it('logs a non-Error failure of the notice as text', async () => {
    const { call, logs, endTurn } = await mount({}, { notifier: 'fail-text' })
    const agent = turn([PEER])
    await call('watch_create', agent)
    endTurn(agent)
    await vi.waitFor(() => { expect(logs.some(line => line.startsWith('warn') && line.endsWith('busy'))).toBe(true) })
  })

  it('drops queued notices when the plugin is disposed before the turn ends', async () => {
    vi.useFakeTimers()
    const { call, ctx, notices } = await mount()
    await call('watch_create', turn([PEER]))
    await ctx.fiber.dispose()
    await vi.advanceTimersByTimeAsync(6 * 60_000)
    expect(notices).toEqual([])
  })
})

describe('subagent turns', () => {
  it('looks up the parent Session through the sessions service and refuses when the parent turn was a peer\'s', async () => {
    const parent = turn([PEER], [], 'parent').session
    const child = Session.create(SessionId('child'), undefined, {
      version: SESSION_FORMAT_VERSION, id: SessionId('child'), createdAt: 0, isSeeded: false, origin: 'subagent', parentSession: SessionId('parent'),
    })
    child.append('turn/start', { turn: 1 })
    child.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: OWNER }), { surfaceOp: 'append' })
    const looked: string[] = []
    const { call, ran } = await mount({}, { sessions: (id) => { looked.push(id); return id === 'parent' ? parent : undefined } })
    expect(await call('cc_send', agentOn(child))).toContain('peer:bili')
    expect(looked).toContain('parent')
    expect(ran).toEqual([])
  })
})
