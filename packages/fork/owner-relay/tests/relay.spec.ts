import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import type { MainAgentMessage, OwnerNote } from '@deepseek-ai/dsh-event-bus'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceActiveSessionError } from '@deepseek-ai/dsh-workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readJobLeadState } from '../src/job-lead-state.ts'
import OwnerRelay, { type RelayAnswer, type RelayChannel, type RelayDecision, type RelayDelivery } from '../src/index.ts'

/** A log line the relay wrote. */
interface LogLine {
  type: string
  text: string
}

const contexts: Context[] = []
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** Let pending deliveries, fallbacks, and settle hooks run. */
async function drain(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await setImmediate()
}

/** Mount the relay with a recording notifier unless `notifier` is false. */
async function mount(options: {
  notifier?: false | ((note: OwnerNote) => Promise<void>)
  jobLeadSessionId?: string
  tellMainAgent?: (message: MainAgentMessage) => Promise<string>
  jobLeadMaxForwardBytes?: number
  host?: (ctx: Context) => void
} = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const logs: LogLine[] = []
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (message) => { logs.push({ type: message.type, text: String(message.args[0]) }) },
  })
  const notes: OwnerNote[] = []
  if (options.notifier !== false) {
    const send = options.notifier ?? (async (note: OwnerNote) => { notes.push(note) })
    ctx.provide('ownerNotifier', { send, tellMainAgent: options.tellMainAgent } as never)
  }
  options.host?.(ctx)
  await ctx.plugin(OwnerRelay, {
    ...(options.jobLeadSessionId === undefined ? {} : { jobLeadSessionId: options.jobLeadSessionId }),
    ...(options.jobLeadMaxForwardBytes === undefined ? {} : { jobLeadMaxForwardBytes: options.jobLeadMaxForwardBytes }),
  })
  const relay = ctx.ownerRelay
  const emit = (sessionId: string, event: unknown, preset = 'job-lead'): void => {
    (ctx.emit as (...args: unknown[]) => void)('session/event', { id: SessionId(sessionId), header: { agentPreset: preset, cwd: '/original' } }, event)
  }
  return { ctx, relay, notes, logs, emit }
}

/** A channel double that records its hooks and the answers it gets, in order. */
function recorder(name: string, options: { fallbackLabel?: string; deliver?: (answer: RelayAnswer) => Promise<RelayDelivery> } = {}) {
  const calls: string[] = []
  const answers: RelayAnswer[] = []
  /** How each ended turn ended, as `onTurnEnd` heard it. */
  const ends: RelayDecision['kind'][] = []
  const channel: RelayChannel = {
    name,
    ...(options.fallbackLabel === undefined ? {} : { fallbackLabel: options.fallbackLabel }),
    deliver: async (answer) => {
      calls.push(`deliver:${answer.sessionId}`)
      answers.push(answer)
      return options.deliver === undefined ? 'sent' : await options.deliver(answer)
    },
    onTurnStart: (sessionId) => { calls.push(`start:${sessionId}`) },
    onTurnEnd: (sessionId, ended) => { calls.push(`end:${sessionId}`); ends.push(ended) },
    onTurnSettled: (sessionId) => { calls.push(`settled:${sessionId}`) },
  }
  return { channel, calls, answers, ends }
}

const turnStart = { type: 'turn/start', seq: 0, data: { turn: 1 } }
function assistant(text: string): unknown {
  return { type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } } }
}
function turnEnd(reason: Record<string, unknown> = { kind: 'completed' }): unknown {
  return { type: 'turn/end', seq: 9, data: { turn: 1, reason } }
}
/** One turn of `sessionId`: start, an optional final text, and the end. */
async function turn(
  emit: (id: string, event: unknown) => void, sessionId: string, text: string | undefined, reason?: Record<string, unknown>,
): Promise<void> {
  emit(sessionId, turnStart)
  if (text !== undefined) emit(sessionId, assistant(text))
  emit(sessionId, turnEnd(reason))
  await drain()
}

describe('OwnerRelay rules', () => {
  it('relays every text of a completed turn to the channel that claimed the Session', async () => {
    const h = await mount()
    const wechat = recorder('wechat')
    h.relay.registerChannel(wechat.channel)
    h.relay.claim('chat-1', 'wechat')
    h.emit('chat-1', turnStart)
    h.emit('chat-1', assistant('draft'))
    h.emit('chat-1', { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'thinking', thinking: 'hm' }] } } })
    h.emit('chat-1', { type: 'tool/result', seq: 3, data: {} })
    h.emit('chat-1', assistant('Final answer.'))
    h.emit('chat-1', turnEnd())
    await drain()
    expect(wechat.answers).toEqual([{ sessionId: 'chat-1', text: 'draft\n\nFinal answer.', outcome: 'completed', parts: ['draft', 'Final answer.'] }])
    expect(h.logs.some(line => line.type === 'info' && line.text === 'owner-relay: Session chat-1 ended a turn (completed); relaying 20 chars from 2 messages through wechat')).toBe(true)
    expect(h.logs.some(line => line.text === 'owner-relay: wechat sent the answer of Session chat-1')).toBe(true)
    // Bodies stay out of the logs.
    expect(h.logs.filter(line => line.text.includes('Final answer.') || line.text.includes('draft'))).toEqual([])
    expect(h.notes).toEqual([])
  })

  it('sends nothing for NO_REPLY, a turn the owner stopped, or a completed turn without text, and says why', async () => {
    const h = await mount()
    const wechat = recorder('wechat')
    h.relay.registerChannel(wechat.channel)
    h.relay.claim('chat-1', 'wechat')
    await turn(h.emit, 'chat-1', ' NO_REPLY\n')
    await turn(h.emit, 'chat-1', 'half an answer', { kind: 'aborted', reason: { kind: 'user' } })
    await turn(h.emit, 'chat-1', undefined)
    expect(wechat.answers).toEqual([])
    expect(h.notes).toEqual([])
    const reasons = h.logs.filter(line => line.type === 'info' && line.text.startsWith('owner-relay: Session chat-1 ended a turn')).map(line => line.text)
    expect(reasons).toEqual([
      'owner-relay: Session chat-1 ended a turn (completed) that answered NO_REPLY; nothing is relayed',
      'owner-relay: Session chat-1 ended a turn (aborted) the owner stopped; nothing is relayed',
      'owner-relay: Session chat-1 ended a turn (completed) without text; nothing is relayed',
    ])
    // Every turn still ends and settles, so typing and per-turn state clear.
    expect(wechat.calls).toEqual(['start:chat-1', 'end:chat-1', 'settled:chat-1', 'start:chat-1', 'end:chat-1', 'settled:chat-1', 'start:chat-1', 'end:chat-1', 'settled:chat-1'])
    // The channel hears why, so it can tell a turn with nothing to say from one the owner stopped.
    expect(wechat.ends).toEqual(['silent', 'stopped', 'empty'])
    await turn(h.emit, 'chat-1', 'An answer.')
    expect(wechat.ends.at(-1)).toBe('answer')
  })

  it('relays an unfinished turn with a warning and the failure reason', async () => {
    const h = await mount()
    const wechat = recorder('wechat')
    h.relay.registerChannel(wechat.channel)
    h.relay.claim('chat-1', 'wechat')
    await turn(h.emit, 'chat-1', 'partial', { kind: 'aborted', reason: { kind: 'legacy' } })
    await turn(h.emit, 'chat-1', undefined, { kind: 'error', error: { code: 'AUTH', message: '401 User not found.', status: 401 } })
    expect(wechat.answers).toEqual([
      { sessionId: 'chat-1', text: 'partial\n\n⚠️ 本轮未完成（aborted）', outcome: 'aborted' },
      { sessionId: 'chat-1', text: '⚠️ 本轮未完成（error）\n原因：AUTH: 401 User not found.', outcome: 'error', detail: 'AUTH: 401 User not found.' },
    ])
    expect(h.logs.some(line => line.text.startsWith('owner-relay: Session chat-1 ended a turn (error: AUTH: 401 User not found.); relaying'))).toBe(true)
  })

  it('ignores Sessions nobody claimed', async () => {
    const h = await mount()
    const wechat = recorder('wechat')
    h.relay.registerChannel(wechat.channel)
    await turn(h.emit, 'other', 'not mine')
    expect(wechat.calls).toEqual([])
    expect(h.logs.filter(line => line.text.includes('other'))).toEqual([])
  })
})

describe('configured job-lead route', () => {
  it('claims only the configured Session and reports only the final answer to the main agent', async () => {
    const told: MainAgentMessage[] = []
    const h = await mount({ jobLeadSessionId: 'lead-1', tellMainAgent: async (message) => { told.push(message); return 'main' } })
    const direct = recorder('wechat')
    h.relay.registerChannel(direct.channel)
    h.relay.claim('lead-1', 'wechat')
    h.relay.claim('other', 'job-lead')
    expect(h.relay.ownerOf('lead-1')).toBe('job-lead')
    expect(h.relay.ownerOf('other')).toBeUndefined()
    expect(h.relay.release('lead-1')).toBe(false)
    await turn(h.emit, 'other', 'wrong Session')
    await turn((id, event) => { h.emit(id, event, 'unattended') }, 'lead-1', 'wrong preset')
    h.emit('lead-1', turnStart)
    h.emit('lead-1', assistant('progress'))
    h.emit('lead-1', assistant('NO_REPLY'))
    h.emit('lead-1', turnEnd())
    await turn(h.emit, 'lead-1', 'submitted 2')
    expect(told).toEqual([{ text: 'submitted 2', from: 'job-lead', origin: 'job' }])
    expect(direct.answers).toEqual([])
    expect(h.notes).toEqual([])
  })

  it('never sends a direct note if the main agent is missing, rejects delivery, or no target is configured', async () => {
    const unavailable = await mount({ jobLeadSessionId: 'lead' })
    const refused = await mount({ jobLeadSessionId: 'lead', tellMainAgent: async () => { throw new Error('queue closed') } })
    const unconfigured = await mount({ tellMainAgent: async () => { throw new Error('must not try') } })
    for (const h of [unavailable, refused, unconfigured]) {
      await turn(h.emit, 'lead', 'a report')
      expect(h.notes).toEqual([])
    }
    expect(unconfigured.relay.ownerOf('lead')).toBeUndefined()
    expect(unavailable.logs.some(line => line.text.includes('no main-agent notifier'))).toBe(true)
    expect(refused.logs.some(line => line.text.includes('queue closed'))).toBe(true)
    expect(unconfigured.logs.some(line => line.text.includes('could not deliver'))).toBe(false)
  })
})

describe('job-lead overflow recovery', () => {
  const overflow = { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'different wording' } }
  const notice = (count: number) => `job-lead 上下文溢出，已换新会话（第 ${count} 次/24h）`
  const halfHour = 30 * 60_000

  async function fixture({ noDirectory, ...config }: { jobLeadMaxForwardBytes?: number; noDirectory?: boolean } = {}) {
    const home = await mkdtemp(join(tmpdir(), 'relay-recovery-'))
    vi.stubEnv('DSH_HOME', home)
    cleanups.push(async () => { await rm(home, { recursive: true }) })
    const file = join(home, 'data', 'owner-relay', 'job-lead.json')
    const profileDir = join(home, 'profiles', 'event')
    const profile = join(profileDir, 'cordis.patch.yml')
    await mkdir(profileDir, { recursive: true })
    await writeFile(profile, 'jobLeadSessionId: seed\n')
    const told: string[] = []
    const tellMainAgent = vi.fn(async (message: MainAgentMessage) => { told.push(message.text); return 'main' })
    const create = vi.fn(async (_request: { cwd: string; agentPreset: string }) => ({ sessionId: SessionId(`new-${create.mock.calls.length}`) }))
    const prompt = vi.fn(async (_request: { sessionId: string; content: { text: string }[] }) => ({ accepted: true }))
    const archiveSession = vi.fn<(id: string) => Promise<void>>(async () => {})
    const close = vi.fn(async () => {})
    const setup = () => mount({ ...config, jobLeadSessionId: 'seed', tellMainAgent, host: (ctx) => {
      ctx.provide('sessionController', { create, prompt } as never)
      ctx.provide('workspaceRegistry', { archiveSession } as never)
      if (noDirectory !== true) ctx.provide('workingDirectory', { get: () => '/current' } as never)
      ctx.provide('agents', { get: () => ({ whenIdle: async () => {}, ctx: { fiber: { dispose: close } } }) } as never)
    } })
    const h = await setup()
    const fail = (id: string, reason = overflow) => { h.emit(id, turnEnd(reason)) }
    return { h, setup, file, profile, told, create, prompt, archiveSession, close, fail, tellMainAgent }
  }

  it('replaces the active root once, preserves the profile, and restores the new target on remount', async () => {
    const f = await fixture()
    f.fail('seed')
    f.fail('seed')
    await vi.waitFor(() => expect(f.told).toEqual([notice(1)]))
    expect(f.create.mock.calls).toEqual([[{ cwd: '/current', agentPreset: 'job-lead' }]])
    expect(f.archiveSession.mock.calls).toEqual([['seed']])
    expect(f.prompt).toHaveBeenCalledTimes(1)
    expect(f.prompt.mock.calls[0]?.[0]).toMatchObject({ sessionId: 'new-1', content: [{ text: expect.stringMatching(/job_repo.*tracker.*issues.*Continue/is) }] })
    expect(f.h.relay.jobLeadSessionId).toBe('new-1')
    expect(f.h.notes).toEqual([])
    expect(await readFile(f.profile, 'utf8')).toBe('jobLeadSessionId: seed\n')
    expect(await readdir(join(f.file, '..'))).toEqual(['job-lead.json'])
    expect(JSON.parse(await readFile(f.file, 'utf8'))).toMatchObject({ jobLeadSessionId: 'new-1', resets: [{ oldSessionId: 'seed', reason: 'CONTEXT_WINDOW_EXCEEDED' }] })
    await f.h.ctx.fiber.dispose()
    const remounted = await f.setup()
    expect(remounted.relay.jobLeadSessionId).toBe('new-1')
    remounted.emit('seed', turnEnd(overflow))
    await drain()
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.told).toEqual([notice(1)])
  })

  it('does not reset on an error message that merely mentions context overflow', async () => {
    const f = await fixture()
    f.fail('seed', { kind: 'error', error: { code: 'AUTH', message: 'context overflow' } })
    await drain()
    expect(f.create).not.toHaveBeenCalled()
    expect(f.told).toEqual(['⚠️ 本轮未完成（error）\n原因：AUTH: context overflow'])
  })

  it('honors the rolling cooldown and reports a saturated window once across remount', async () => {
    const f = await fixture()
    const start = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => start)
    f.fail('seed', { kind: 'error', error: { code: 'context overflow', message: 'legacy code' } })
    await vi.waitFor(() => expect(f.told).toEqual([notice(1)]))
    vi.mocked(Date.now).mockReturnValue(start + halfHour - 1)
    f.fail('new-1')
    await drain()
    expect(f.told).toEqual([notice(1)])
    vi.mocked(Date.now).mockReturnValue(start + halfHour)
    f.fail('new-1')
    await vi.waitFor(() => expect(f.told).toEqual([notice(1), notice(2)]))
    vi.mocked(Date.now).mockReturnValue(start + 2 * halfHour)
    f.fail('new-2')
    await vi.waitFor(() => expect(f.told).toEqual([notice(1), notice(2), notice(3)]))
    f.fail('new-3')
    f.fail('new-3')
    await vi.waitFor(() => expect(f.told).toHaveLength(4))
    expect(f.told[3]).toMatch(/24 小时内已重置 3 次/)
    expect(f.create).toHaveBeenCalledTimes(3)
    await f.h.ctx.fiber.dispose()
    const remounted = await f.setup()
    remounted.emit('new-3', turnEnd(overflow))
    await drain()
    expect(f.told).toHaveLength(4)
    vi.mocked(Date.now).mockReturnValue(start + 48 * halfHour)
    remounted.emit('new-3', turnEnd(overflow))
    await vi.waitFor(() => expect(f.told[4]).toBe(notice(3)))
    expect(f.create).toHaveBeenCalledTimes(4)
  })

  it('closes an agent whose non-forced archive would affect schedules and reports the attached IDs', async () => {
    const f = await fixture()
    f.archiveSession.mockRejectedValueOnce(new WorkspaceActiveSessionError(SessionId('seed'), [{ kind: 'schedule', items: [{ id: 'task-1', label: 'Recurring work' }] }]))
    f.fail('seed')
    await vi.waitFor(() => expect(f.told).toEqual([`${notice(1)}；旧会话仍绑定日程：task-1`]))
    expect(f.archiveSession.mock.calls).toEqual([['seed']])
    expect(f.close).toHaveBeenCalledTimes(1)
    expect(JSON.parse(await readFile(f.file, 'utf8'))).toMatchObject({ poisonedSessionStillscheduled: ['task-1'] })
  })

  it('reports a failed recovery once per cooldown without forwarding the overflow error', async () => {
    const told = vi.fn(async (_message: MainAgentMessage) => 'main')
    const h = await mount({ jobLeadSessionId: 'seed', tellMainAgent: told })
    await turn(h.emit, 'seed', undefined, overflow)
    await turn(h.emit, 'seed', undefined, overflow)
    expect(told).toHaveBeenCalledExactlyOnceWith({ text: 'job-lead 上下文溢出，自动换新会话失败；请查看中继日志。', from: 'job-lead', origin: 'job' })
    expect(h.notes).toEqual([])
    expect(h.logs.some(line => line.text.includes('recovery requires a live Agent'))).toBe(true)
  })

  it('keeps the replacement selected when retiring the writer or queueing its boot fails', async () => {
    const f = await fixture({ noDirectory: true })
    f.archiveSession.mockRejectedValueOnce(new Error('archive write failed'))
    f.close.mockRejectedValueOnce(new Error('writer close failed'))
    f.prompt.mockRejectedValueOnce(new Error('queue closed'))
    f.fail('seed')
    await vi.waitFor(() => expect(f.told).toEqual([`${notice(1)}；旧会话归档或关闭失败，请查看中继日志；启动指令未入队，请查看中继日志`]))
    expect(f.h.relay.jobLeadSessionId).toBe('new-1')
    expect(f.create.mock.calls).toEqual([[{ cwd: '/original', agentPreset: 'job-lead' }]])
    expect(f.h.notes).toEqual([])
  })

  it('still reports an attached schedule when persisting its ID fails', async () => {
    const f = await fixture()
    f.archiveSession.mockImplementationOnce(async () => {
      await rename(f.file, `${f.file}.saved`)
      await mkdir(f.file)
      throw new WorkspaceActiveSessionError(SessionId('seed'), [{ kind: 'turn' }, { kind: 'schedule' }, { kind: 'schedule', items: [{ id: 'task-2', label: 'Owner task' }] }])
    })
    f.fail('seed')
    await vi.waitFor(() => expect(f.told).toEqual([`${notice(1)}；旧会话仍绑定日程：task-2`]))
    expect(f.h.logs.some(line => line.text.includes('could not record schedules still on Session'))).toBe(true)
  })

  it('does not use a direct note if a recovery notice cannot reach the main agent', async () => {
    const f = await fixture()
    f.tellMainAgent.mockRejectedValueOnce(new Error('queue closed'))
    f.fail('seed')
    await vi.waitFor(() => expect(f.h.logs.some(line => line.text.includes('recovery notice for Session new-1 failed'))).toBe(true))
    expect(f.h.notes).toEqual([])
  })

  it('rejects unreadable or invalid runtime state instead of reusing an overflowed seed', async () => {
    const f = await fixture()
    await mkdir(f.file, { recursive: true })
    expect(() => readJobLeadState(f.file, SessionId('seed'))).toThrow()
    const bad = `${f.file}.bad`
    for (const data of [null, {}, { jobLeadSessionId: '', resets: [] }, { jobLeadSessionId: 'new', resets: null },
      { jobLeadSessionId: 'new', resets: [null] }, { jobLeadSessionId: 'new', resets: [], limitReported: false },
      { jobLeadSessionId: 'new', resets: [], poisonedSessionStillscheduled: 'task' },
      { jobLeadSessionId: 'new', resets: [], poisonedSessionStillscheduled: [0] }]) {
      await writeFile(bad, JSON.stringify(data))
      expect(() => readJobLeadState(bad, SessionId('seed'))).toThrow('invalid job-lead state')
    }
    await writeFile(bad, JSON.stringify({ jobLeadSessionId: 'new', resets: [], poisonedSessionStillscheduled: ['task'] }))
    expect(readJobLeadState(bad, SessionId('seed')).poisonedSessionStillscheduled).toEqual(['task'])
  })

  it('caps forwarded UTF-8 text and errors including exact omitted bytes; it does not forward raw tool events', async () => {
    const f = await fixture({ jobLeadMaxForwardBytes: 48 })
    const large = '🐈'.repeat(100)
    f.h.emit('seed', turnStart)
    f.h.emit('seed', { type: 'tool/result', seq: 3, data: { content: 'do not forward'.repeat(1_000) } })
    await turn(f.h.emit, 'seed', large)
    f.fail('seed', { kind: 'error', error: { code: 'AUTH', message: large } })
    await drain()
    expect(f.told[0]).toBe(`${'🐈'.repeat(6)}…[truncated 376 bytes]`)
    const unbounded = `⚠️ 本轮未完成（error）\n原因：AUTH: ${large}`
    const match = f.told[1]?.match(/^(.*)…\[truncated (\d+) bytes\]$/s)
    expect(match).not.toBeNull()
    expect(Number(match?.[2])).toBe(Buffer.byteLength(unbounded) - Buffer.byteLength(match?.[1] ?? ''))
    expect(f.told.every(text => Buffer.byteLength(text) <= 48)).toBe(true)
    expect(f.told).toHaveLength(2)
  })
})

describe('OwnerRelay claims', () => {
  it('claims, moves, and releases Sessions', async () => {
    const h = await mount()
    const wechat = recorder('wechat')
    const bili = recorder('bili-dm', { fallbackLabel: 'the Bilibili account\'s Session' })
    h.relay.registerChannel(wechat.channel)
    h.relay.registerChannel(bili.channel)
    expect(h.relay.ownerOf('s1')).toBeUndefined()
    h.relay.claim('s1', 'wechat')
    expect(h.relay.ownerOf('s1')).toBe('wechat')
    h.relay.claim('s1', 'bili-dm')
    expect(h.relay.ownerOf('s1')).toBe('bili-dm')
    await turn(h.emit, 's1', 'to bili')
    expect(bili.answers.map(answer => answer.text)).toEqual(['to bili'])
    expect(wechat.answers).toEqual([])
    expect(h.relay.release('s1')).toBe(true)
    expect(h.relay.release('s1')).toBe(false)
    expect(h.relay.ownerOf('s1')).toBeUndefined()
    await turn(h.emit, 's1', 'nobody relays this')
    expect(bili.answers).toHaveLength(1)
  })

  it('releases a channel\'s claims when the channel goes away, and refuses a second channel of the same name', async () => {
    const h = await mount()
    const first = recorder('wechat')
    const dispose = h.relay.registerChannel(first.channel)
    expect(() => h.relay.registerChannel(recorder('wechat').channel)).toThrow('owner-relay: a channel named wechat is already registered')
    h.relay.claim('chat-1', 'wechat')
    h.relay.claim('chat-2', 'wechat')
    dispose()
    expect(h.relay.ownerOf('chat-1')).toBeUndefined()
    expect(h.relay.ownerOf('chat-2')).toBeUndefined()
    const second = recorder('wechat')
    h.relay.registerChannel(second.channel)
    h.relay.claim('chat-1', 'wechat')
    await turn(h.emit, 'chat-1', 'after re-registering')
    expect(second.answers).toHaveLength(1)
    expect(first.answers).toEqual([])
  })

  it('keeps a claim and its log quiet when the same channel claims a Session again', async () => {
    const h = await mount()
    h.relay.registerChannel(recorder('wechat').channel)
    h.relay.claim('s1', 'wechat')
    h.relay.claim('s1', 'wechat')
    expect(h.relay.ownerOf('s1')).toBe('wechat')
    expect(h.logs.filter(line => line.text.includes('Session s1'))).toEqual([
      { type: 'debug', text: 'owner-relay: wechat claims Session s1' },
    ])
  })

  it('releases only its own claims when a channel goes away, and ignores a second disposal of it', async () => {
    const h = await mount()
    const dispose = h.relay.registerChannel(recorder('wechat').channel)
    const bili = recorder('bili-dm')
    h.relay.registerChannel(bili.channel)
    h.relay.claim('chat-1', 'wechat')
    h.relay.claim('bili-1', 'bili-dm')
    dispose()
    expect(h.relay.ownerOf('chat-1')).toBeUndefined()
    expect(h.relay.ownerOf('bili-1')).toBe('bili-dm')
    expect(h.logs.filter(line => line.text.includes('wechat removed'))).toHaveLength(1)
    // A stale disposer must not remove a channel that registered under the name since.
    const replacement = recorder('wechat')
    h.relay.registerChannel(replacement.channel)
    h.relay.claim('chat-2', 'wechat')
    dispose()
    expect(h.relay.ownerOf('chat-2')).toBe('wechat')
    await turn(h.emit, 'chat-2', 'still routed')
    expect(replacement.answers.map(answer => answer.text)).toEqual(['still routed'])
    expect(h.logs.filter(line => line.text.includes('wechat removed'))).toHaveLength(1)
  })

  it('relays nothing for a Session whose channel is not registered, and says so', async () => {
    const h = await mount()
    h.relay.claim('s1', 'bili-dm')
    await turn(h.emit, 's1', 'lost')
    expect(h.notes).toEqual([])
    expect(h.logs.some(line => line.type === 'warn' && line.text === 'owner-relay: Session s1 ended a turn (completed), but its channel bili-dm is not registered; nothing is relayed')).toBe(true)
  })
})

describe('OwnerRelay delivery', () => {
  it('calls onTurnStart before deliver and onTurnSettled only once deliver resolves', async () => {
    const h = await mount()
    let finish: (delivery: RelayDelivery) => void = () => {}
    const wechat = recorder('wechat', { deliver: () => new Promise((resolve) => { finish = resolve }) })
    h.relay.registerChannel(wechat.channel)
    h.relay.claim('chat-1', 'wechat')
    await turn(h.emit, 'chat-1', 'slow')
    expect(wechat.calls).toEqual(['start:chat-1', 'end:chat-1', 'deliver:chat-1'])
    finish('sent')
    await drain()
    expect(wechat.calls).toEqual(['start:chat-1', 'end:chat-1', 'deliver:chat-1', 'settled:chat-1'])
  })

  it('takes a channel\'s kept answer as final: no fallback', async () => {
    const h = await mount()
    const bili = recorder('bili-dm', { fallbackLabel: 'the Bilibili account\'s Session', deliver: async () => 'kept' })
    h.relay.registerChannel(bili.channel)
    h.relay.claim('bili-1', 'bili-dm')
    await turn(h.emit, 'bili-1', 'a Web UI answer')
    expect(bili.answers).toHaveLength(1)
    expect(h.notes).toEqual([])
    expect(h.logs.some(line => line.type === 'info' && line.text === 'owner-relay: bili-dm kept the answer of Session bili-1 in the Session')).toBe(true)
    expect(bili.calls.at(-1)).toBe('settled:bili-1')
  })

  it('falls back to the notifier with the channel\'s label when deliver rejects, then settles', async () => {
    const h = await mount()
    const label = 'the Bilibili account\'s Session (its answer could not go out as a Bilibili message)'
    const bili = recorder('bili-dm', { fallbackLabel: label, deliver: () => Promise.reject(new Error('the write guard failed')) })
    h.relay.registerChannel(bili.channel)
    h.relay.claim('bili-1', 'bili-dm')
    await turn(h.emit, 'bili-1', 'a share')
    expect(h.notes).toEqual([{ title: '↪️ 这条回答没能从原渠道发出，改发这里', body: 'a share\n\n原因：the write guard failed', origin: label }])
    expect(h.logs.some(line => line.type === 'warn' && line.text === 'owner-relay: bili-dm could not deliver the answer of Session bili-1: the write guard failed')).toBe(true)
    expect(h.logs.some(line => line.type === 'info' && line.text === 'owner-relay: sent the answer of Session bili-1 to ownerNotifier instead of bili-dm')).toBe(true)
    expect(bili.calls.at(-1)).toBe('settled:bili-1')
  })

  it('has no fallback for the notifier\'s own channel, nor without a notifier, and survives a failing one', async () => {
    const own = await mount()
    const wechat = recorder('wechat', { deliver: () => Promise.reject(new Error('storage closed')) })
    own.relay.registerChannel(wechat.channel)
    own.relay.claim('chat-1', 'wechat')
    await turn(own.emit, 'chat-1', 'answer')
    expect(own.notes).toEqual([])
    expect(own.logs.some(line => line.text === 'owner-relay: wechat has no fallback label; the answer of Session chat-1 was not delivered')).toBe(true)
    expect(wechat.calls.at(-1)).toBe('settled:chat-1')

    const bare = await mount({ notifier: false })
    bare.relay.registerChannel(recorder('bili-dm', { fallbackLabel: 'x', deliver: () => Promise.reject(new Error('down')) }).channel)
    bare.relay.claim('bili-1', 'bili-dm')
    await turn(bare.emit, 'bili-1', 'answer')
    expect(bare.logs.some(line => line.text === 'owner-relay: no ownerNotifier is mounted; the answer of Session bili-1 was not delivered')).toBe(true)

    const failing = await mount({ notifier: () => Promise.reject(new Error('wechat down')) })
    const bili = recorder('bili-dm', { fallbackLabel: 'x', deliver: () => Promise.reject(new Error('down')) })
    failing.relay.registerChannel(bili.channel)
    failing.relay.claim('bili-1', 'bili-dm')
    await turn(failing.emit, 'bili-1', 'answer')
    expect(failing.logs.some(line => line.text === 'owner-relay: the fallback of Session bili-1 failed too: wechat down')).toBe(true)
    expect(bili.calls.at(-1)).toBe('settled:bili-1')
  })

  it('keeps relaying when a channel hook throws', async () => {
    const h = await mount()
    const answers: string[] = []
    h.relay.registerChannel({
      name: 'wechat',
      deliver: async (answer) => { answers.push(answer.text); return 'sent' },
      onTurnStart: () => { throw new Error('typing broke') },
    })
    h.relay.claim('chat-1', 'wechat')
    await turn(h.emit, 'chat-1', 'still relayed')
    expect(answers).toEqual(['still relayed'])
    expect(h.logs.some(line => line.type === 'warn' && line.text === 'owner-relay: wechat onTurnStart failed for Session chat-1: typing broke')).toBe(true)
  })

  it('logs a non-Error rejection of deliver by its string form', async () => {
    const h = await mount()
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error arm is the case under test.
    const wechat = recorder('wechat', { deliver: () => Promise.reject('plain string failure') })
    h.relay.registerChannel(wechat.channel)
    h.relay.claim('chat-1', 'wechat')
    await turn(h.emit, 'chat-1', 'answer')
    expect(h.logs.some(line => line.type === 'warn' && line.text === 'owner-relay: wechat could not deliver the answer of Session chat-1: plain string failure')).toBe(true)
  })
})
