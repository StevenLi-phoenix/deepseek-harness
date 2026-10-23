import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import * as Memory from '../src/index.ts'
import { MemoryStore } from '../src/store.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'lsy-memory-test': { kind: 'lsy-memory-test' } & ContextFormed
  }
}

const contexts: Context[] = []
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(dirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }) }))
})

async function mount(config: Partial<Memory.Config> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'lsy-memory-plugin-'))
  dirs.push(dir)
  const file = join(dir, 'memory.jsonl')
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('systemPrompt', { tools: () => () => {} } as never)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(Memory, { file, ...config })
  const call = async (name: string, args: unknown): Promise<unknown> => {
    const result = await ctx.tools.execute({ callId: ToolCallId(`${name}-call`), signal: new AbortController().signal, name, arguments: args })
    const block = result.content.find(item => item.type === 'text')
    return block?.type === 'text' ? JSON.parse(block.text) : undefined
  }
  return { ctx, call, store: new MemoryStore(file) }
}

function agentOn(session: Session): Agent {
  return {
    id: session.id,
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('lsy-memory must enter through the pre-step decision') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** Run one pre-step with a user prompt and append what it decides, as the agent loop does. */
async function step(ctx: Context, agent: Agent, stepNumber = 1, signal = new AbortController().signal): Promise<string[]> {
  const prompt = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'lsy-memory-test' } })
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [prompt], turn: 1, step: stepNumber, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [prompt] }),
  )
  if (decision.kind !== 'enter') return []
  for (const message of decision.messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
  return decision.messages.map(message => message.source.kind)
}

function memoryTexts(session: Session): string[] {
  return session.snapshotEvents()
    .filter(event => event.type === 'user/message' && event.data.source.kind === 'lsy-memory')
    .map(event => event.type === 'user/message' ? (event.data.content[0] as { text: string }).text : '')
}

describe('memory tools', () => {
  it('saves, searches, corrects, and forgets through the store', async () => {
    const { call, store } = await mount()
    const saved = await call('memory_save', { text: 'Prefers pnpm over npm', category: 'instructions' }) as { outcome: string; entry: { id: string } }
    expect(saved.outcome).toBe('added')
    expect(await call('memory_search', { query: 'PNPM' })).toEqual({ entries: [expect.objectContaining({ id: saved.entry.id })], more: 0 })
    expect(await call('memory_save', { id: saved.entry.id, text: 'Prefers pnpm; npm only for global tools', category: 'instructions' }))
      .toMatchObject({ outcome: 'replaced', entry: { id: saved.entry.id } })
    expect(await call('memory_forget', { id: saved.entry.id })).toMatchObject({ forgot: { id: saved.entry.id } })
    expect(await store.list()).toEqual([])
  })

  it('answers refused input with a code instead of throwing', async () => {
    const { call } = await mount()
    expect(await call('memory_forget', { id: 'abcdef' })).toEqual({ error: 'not_found', message: 'no entry with id abcdef.' })
    expect(await call('memory_save', { text: ' ', category: 'identity' })).toMatchObject({ error: 'invalid_text' })
  })

  it('clamps the search limit', async () => {
    const { call, store } = await mount()
    await store.importDrafts(Array.from({ length: 60 }, (_, index) => ({ category: 'projects' as const, date: '2026-01-01', text: `project ${String(index)}` })))
    expect(await call('memory_search', { query: 'project', limit: 500 })).toMatchObject({ more: 10 })
    expect(await call('memory_search', { query: 'project', limit: 0 })).toMatchObject({ more: 59 })
  })
})

describe('memory block', () => {
  it('enters a root Session once, right after the prompt', async () => {
    const { ctx, store } = await mount()
    await store.save({ text: 'Search before claiming', category: 'instructions' })
    const session = Session.create(SessionId('root'))
    const agent = agentOn(session)
    expect(await step(ctx, agent)).toEqual(['lsy-memory-test', 'lsy-memory'])
    expect(await step(ctx, agent, 2)).toEqual(['lsy-memory-test'])
    expect(memoryTexts(session)).toHaveLength(1)
    expect(memoryTexts(session)[0]).toContain('Search before claiming')
  })

  it('comes back after compaction shadows it, with what was saved since', async () => {
    const { ctx, store } = await mount()
    await store.save({ text: 'old fact', category: 'instructions' })
    const session = Session.create(SessionId('compacted'))
    const agent = agentOn(session)
    await step(ctx, agent)
    await store.save({ text: 'new fact', category: 'instructions' })
    const nodes = session.surface.nodes
    const first = nodes[0] ?? SessionSeq(0)
    const last = nodes.at(-1) ?? SessionSeq(0)
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'summary' }], source: { kind: 'lsy-memory-test' } }), {
      surfaceOp: { op: 'replace', startSeq: first, endSeq: last },
      sourceEventSeqs: [...nodes],
    })
    expect(await step(ctx, agent, 2)).toEqual(['lsy-memory-test', 'lsy-memory'])
    expect(memoryTexts(session).at(-1)).toContain('new fact')
  })

  it('skips subagents, empty memory, and empty first steps', async () => {
    const { ctx, store } = await mount()
    const empty = Session.create(SessionId('empty'))
    expect(await step(ctx, agentOn(empty))).toEqual(['lsy-memory-test'])
    await store.save({ text: 'fact', category: 'identity' })
    const child = Session.create(SessionId('child'), undefined, { version: SESSION_FORMAT_VERSION, id: SessionId('child'), createdAt: 0, isSeeded: false, origin: 'subagent' })
    expect(await step(ctx, agentOn(child))).toEqual(['lsy-memory-test'])
    const idle = Session.create(SessionId('idle'))
    const decision = await agentEvents(ctx, agentOn(idle)).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )
    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })

  it('lets the request go without memory when the file cannot be read', async () => {
    const { ctx, store } = await mount()
    await store.save({ text: 'fact', category: 'identity' })
    const { appendFile } = await import('node:fs/promises')
    await appendFile(store.file, 'broken\n')
    expect(await step(ctx, agentOn(Session.create(SessionId('broken'))))).toEqual(['lsy-memory-test'])
  })
})
