import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as Style from '../src/index.ts'
import { StyleStore } from '../src/store.ts'
import { cleanup, tmp, track } from './harness.ts'

afterEach(async () => {
  vi.useRealTimers()
  await cleanup()
})

type Logs = { lines: string[]; has: (...needles: string[]) => boolean }
function capture(ctx: Context): Logs {
  const lines: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { lines.push(`${message.type}: ${String(message.args[0])} ${message.args.slice(1).map(String).join(' ')}`.trim()) } })
  return { lines, has: (...needles) => lines.some(line => needles.every(needle => line.includes(needle))) }
}

const OFF = { qq: { enabled: false }, bili: { enabled: false }, hotwatch: { enabled: false } }

/** The root plugin (optional) and one preset scope in prompt mode, over the real agent loop with a scripted model. */
type Script = ConstructorParameters<typeof MockAdapter>[0]
async function harness(script: Script, options: { root?: boolean; prompt?: Record<string, unknown> } = {}) {
  const dir = await tmp()
  await new StyleStore(join(dir, 'samples.jsonl'), { maxActive: 60, maxOwner: 20, maxPending: 40, maxTombstones: 100 })
    .ingest([{ source: 'qq', origin: { platform: 'qq', groups: 1, speakers: 2, days: 1 }, at: Date.now(), prompt: '周末去哪', reply: '宅着' }], 'optional')
  const adapter = new MockAdapter(script)
  const ctx = track(new Context())
  const logs = capture(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  if (options.root !== false) await ctx.plugin(Style, { dir, ticsFile: join(dir, 'tics.json'), ...OFF } as Style.Config)
  await ctx.plugin({ name: 'preset-scope', apply: async (scope: Context) => { await scope.plugin(Style, { mode: 'prompt', ...options.prompt } as Style.Config) } })
  ctx.llm.registerAdapter(['mock'], adapter)
  const turn = async (agent: Agent, text: string): Promise<void> => {
    const done = new Promise<void>((resolve) => {
      const dispose = ctx.on('agent/status', ({ agent: seen, status }) => { if (seen === agent && status === 'idle') { dispose(); resolve() } })
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', rpcId: `owner-${text}` } as never }))
    await done
  }
  const create = (id: string, header: Record<string, unknown> = { agentPreset: 'unattended' }) => ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' }, header)
  const blocks = (index: number): number => JSON.stringify(adapter.requests[index]!.messages).split(Style.BLOCK_INTRO).length - 1
  return { ctx, adapter, dir, logs, turn, create, blocks, style: ctx.get('speakingStyle') }
}

describe('prompt mode edge cases', () => {
  it('says so in the log when the row lists no tools, and mounts none', async () => {
    const { logs, adapter, create, turn } = await harness([textResponse('好')], { prompt: { tools: [] } })
    expect(logs.has('preset row', 'none')).toBe(true)
    await turn(await create('chat'), '在吗')
    expect((adapter.requests[0]!.tools ?? []).map(tool => tool.name)).not.toContain('style_note')
  })

  /** The prompt row on a bare context: the pre-step chain and the session events are driven directly. */
  async function bare() {
    const dir = await tmp()
    const ctx = track(new Context())
    const logs = capture(ctx)
    await ctx.plugin(Style, { dir, ticsFile: join(dir, 'tics.json'), ...OFF } as Style.Config)
    await new StyleStore(join(dir, 'samples.jsonl'), { maxActive: 60, maxOwner: 20, maxPending: 40, maxTombstones: 100 })
      .ingest([{ source: 'qq', origin: { platform: 'qq', groups: 1, speakers: 2, days: 1 }, at: Date.now(), prompt: '周末去哪', reply: '宅着' }], 'optional')
    await ctx.plugin({ name: 'preset-scope', apply: async (scope: Context) => { await scope.plugin(Style, { mode: 'prompt' } as Style.Config) } })
    const session = { id: 'chat', header: { agentPreset: 'unattended' } }
    const claimed = createUserMessage({ content: [{ type: 'text', text: '在吗' }], source: { kind: 'user', rpcId: 'owner' } as never })
    const step = async (over: { session?: object; step?: number; signal?: AbortSignal; kind?: 'enter' | 'reject' } = {}) => {
      const decision = await ctx.waterfall('agent/pre-step', {
        agent: { session: over.session ?? session }, messages: [claimed], step: over.step ?? 2,
        signal: over.signal ?? new AbortController().signal,
      } as never, async () => (over.kind === 'reject' ? { kind: 'reject', reason: 'no' } : { kind: 'enter', messages: [claimed] }) as never) as { kind: string; messages: unknown[] }
      return decision
    }
    const textOfBlock = (decision: { messages: unknown[] }): string | undefined => {
      const message = decision.messages[1] as { content: Array<{ text: string }> } | undefined
      return message?.content[0]?.text
    }
    const emit = (event: unknown) => { ctx.emit('session/event', session as never, event as never) }
    return { ctx, logs, step, textOfBlock, emit, style: ctx.get('speakingStyle') }
  }

  it('shows the block again after a compaction summarized it away, but not after a failed one', async () => {
    const { step, textOfBlock, emit } = await bare()
    const first = textOfBlock(await step())!
    expect(first).toContain(Style.BLOCK_INTRO)
    emit({ type: 'user/message', data: { source: { kind: 'speaking-style' }, content: [{ type: 'text', text: first }] } })
    expect(textOfBlock(await step())).toBeUndefined()
    emit({ type: 'compaction/end', data: { error: new Error('failed') } })
    expect(textOfBlock(await step())).toBeUndefined()
    emit({ type: 'compaction/end', data: {} })
    expect(textOfBlock(await step())).toContain(Style.BLOCK_INTRO)
  })

  it('ignores style messages that carry no marker, and messages of other sources', async () => {
    const { step, textOfBlock, emit } = await bare()
    const first = textOfBlock(await step())!
    for (const content of ['plain string', [{ type: 'image' }], [{ type: 'text' }], [{ type: 'text', text: '没有标记' }]]) {
      emit({ type: 'user/message', data: { source: { kind: 'speaking-style' }, content } })
    }
    emit({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: first }] } })
    emit({ type: 'turn/start', data: {} })
    expect(textOfBlock(await step())).toContain(Style.BLOCK_INTRO)
    emit({ type: 'user/message', data: { source: { kind: 'speaking-style' }, content: [{ type: 'text', text: first }] } })
    expect(textOfBlock(await step())).toBeUndefined()
  })

  it('passes the decision through when the step is cancelled, rejected, a subagent\'s, another preset\'s, or the first without work', async () => {
    const { step, textOfBlock } = await bare()
    const aborted = new AbortController()
    aborted.abort()
    expect(textOfBlock(await step({ signal: aborted.signal }))).toBeUndefined()
    expect((await step({ kind: 'reject' })).kind).toBe('reject')
    expect(textOfBlock(await step({ session: { id: 's', header: { agentPreset: 'unattended', origin: 'subagent' } } }))).toBeUndefined()
    expect(textOfBlock(await step({ session: { id: 's', header: {} } }))).toBeUndefined()
    expect(textOfBlock(await step({ session: { id: 's', header: { agentPreset: 'qq-digest' } } }))).toBeUndefined()
    expect(textOfBlock(await step({ step: 1 }))).toContain(Style.BLOCK_INTRO)
  })

  it.each([
    ['an Error', new Error('disk gone'), 'disk gone'],
    ['something that is not an Error', 'plain failure', 'plain failure'],
  ])('goes on without the block when it cannot be built (%s)', async (_name, failure, text) => {
    const { style, logs, step, textOfBlock } = await bare()
    style!.block = async () => { throw failure }
    expect(textOfBlock(await step())).toBeUndefined()
    expect(logs.has('style block not loaded', 'chat', text)).toBe(true)
  })

  it('warns once, and adds nothing, while the root plugin is not mounted', async () => {
    const { logs, create, turn, adapter } = await harness([textResponse('1'), textResponse('2')], { root: false })
    const agent = await create('chat')
    await turn(agent, '一')
    await turn(agent, '二')
    expect(logs.lines.filter(line => line.includes('preset row without the root speaking-style plugin'))).toHaveLength(1)
    expect(JSON.stringify(adapter.requests[1]!.messages)).not.toContain(Style.BLOCK_INTRO)
  })

  it('leaves subagent Sessions and presets outside the list alone', async () => {
    const { create, turn, adapter } = await harness([textResponse('1'), textResponse('2'), textResponse('3')])
    await turn(await create('sub', { agentPreset: 'unattended', origin: 'subagent' }), '一')
    await turn(await create('other', {}), '二')
    await turn(await create('main'), '三')
    const shown = adapter.requests.map(request => JSON.stringify(request.messages).includes(Style.BLOCK_INTRO))
    expect(shown).toEqual([false, false, true])
  })
})

describe('collect mode events', () => {
  const session = (id: string, header: Record<string, unknown> = { agentPreset: 'unattended' }) => ({ id, header })
  const assistant = (content: unknown) => ({ type: 'assistant/message', data: { message: { content } } })

  /** The root plugin alone on a bare context, so a synthetic session event reaches nothing but its listeners. */
  async function root() {
    const dir = await tmp()
    const ctx = track(new Context())
    const logs = capture(ctx)
    await ctx.plugin(Style, { dir, ticsFile: join(dir, 'tics.json'), ...OFF } as Style.Config)
    return { ctx, dir, logs, style: ctx.get('speakingStyle'), emit: (who: unknown, event: unknown) => { ctx.emit('session/event', who as never, event as never) } }
  }
  const counted = async (dir: string): Promise<unknown[]> => {
    const stored = JSON.parse(await readFile(join(dir, 'answers.json'), 'utf8')) as { days: Record<string, unknown> }
    return Object.values(stored.days)
  }

  it('counts the length of the last answer of a turn of the listed presets, and nothing else', async () => {
    const { dir, emit } = await root()
    const chat = session('chat')
    emit(chat, { type: 'turn/start', data: {} })
    emit(chat, assistant([{ type: 'text', text: '先说一句' }]))
    emit(chat, assistant([{ type: 'text', text: ' 好的呀 ' }, { type: 'image' }, { type: 'text' }]))
    emit(chat, { type: 'turn/end', data: {} })
    await vi.waitFor(async () => { expect(await counted(dir)).toEqual([{ answers: 1, chars: 3 }]) })
    // A turn with no assistant message, a string answer, NO_REPLY, a subagent, and a preset outside the list.
    emit(chat, { type: 'turn/start', data: {} })
    emit(chat, { type: 'turn/end', data: {} })
    emit(chat, assistant('plain string'))
    emit(chat, { type: 'turn/end', data: {} })
    emit(chat, assistant([{ type: 'text', text: 'NO_REPLY' }]))
    emit(chat, { type: 'turn/end', data: {} })
    for (const other of [session('sub', { agentPreset: 'unattended', origin: 'subagent' }), session('other', {}), session('qq', { agentPreset: 'qq-digest' })]) {
      emit(other, assistant([{ type: 'text', text: '不会被数' }]))
      emit(other, { type: 'turn/end', data: {} })
    }
    // The log writes in order, so once this last answer is counted nothing above was.
    emit(chat, { type: 'turn/start', data: {} })
    emit(chat, assistant([{ type: 'text', text: '再说一句' }]))
    emit(chat, { type: 'turn/end', data: {} })
    await vi.waitFor(async () => { expect(await counted(dir)).toEqual([{ answers: 2, chars: 7 }]) })
  })

  it('feeds the miner the text of each web result, forgets the oldest open call past 200, and warns when the inbox cannot be written', async () => {
    const { dir, emit, style, logs } = await root()
    const web = session('chat')
    for (let index = 0; index <= 201; index += 1) emit(web, { type: 'tool/call', data: { callId: `c${String(index)}`, name: 'web_search' } })
    const result = (id: string, text: string) => ({ type: 'tool/result', data: { message: { toolCallId: id, content: [{ type: 'text', text }] } } })
    emit(web, result('c0', '最早的调用已经被忘记。'))
    emit(web, result('c201', '最近的调用还记得。'))
    await vi.waitFor(async () => { expect(await readFile(join(dir, 'web-inbox.json'), 'utf8')).toContain('最近的调用还记得') })
    expect(await readFile(join(dir, 'web-inbox.json'), 'utf8')).not.toContain('最早的调用')
    style!.feedWeb = async () => { throw new Error('inbox read-only') }
    emit(web, result('c200', '会失败的写入。'))
    await vi.waitFor(() => { expect(logs.has('web inbox write failed', 'inbox read-only')).toBe(true) })
    style!.feedWeb = async () => { throw 'closed' }
    emit(web, result('c199', '又一次失败的写入。'))
    await vi.waitFor(() => { expect(logs.has('web inbox write failed', 'closed')).toBe(true) })
  })

  it('warns when the first read of the data fails', async () => {
    const dir = await tmp()
    await mkdir(join(dir, 'notes.json'))
    const ctx = track(new Context())
    const logs = capture(ctx)
    await ctx.plugin(Style, { dir, ticsFile: join(dir, 'tics.json'), ...OFF } as Style.Config)
    await vi.waitFor(() => { expect(logs.has('first read failed', 'EISDIR')).toBe(true) })
  })

  it('warns with the text of a first-read failure that is not an Error', async () => {
    const dir = await tmp()
    const ctx = track(new Context())
    const logs = capture(ctx)
    const panel = vi.spyOn(Style.StyleService.prototype, 'panel').mockRejectedValueOnce('plain failure')
    await ctx.plugin(Style, { dir, ticsFile: join(dir, 'tics.json'), ...OFF } as Style.Config)
    await vi.waitFor(() => { expect(logs.has('first read failed', 'plain failure')).toBe(true) })
    panel.mockRestore()
  })

  it('checks for a due run two minutes after start and every ten minutes, warns when a check fails, and stops at dispose', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const { style, logs, ctx } = await root()
    const runs = vi.fn(async () => undefined)
    style!.runIfDue = runs
    await vi.advanceTimersByTimeAsync(119_000)
    expect(runs).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(runs).toHaveBeenCalledTimes(1)
    style!.runIfDue = async () => { throw new Error('run broke') }
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await vi.waitFor(() => { expect(logs.has('scheduled run failed', 'run broke')).toBe(true) })
    style!.runIfDue = async () => { throw 'plain' }
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await vi.waitFor(() => { expect(logs.has('scheduled run failed', 'plain')).toBe(true) })
    style!.runIfDue = runs
    await ctx.fiber.dispose()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(runs).toHaveBeenCalledTimes(1)
  })
})
