import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import * as Monitor from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function mount() {
  const ctx = new Context()
  contexts.push(ctx)
  const followups: UserMessage[] = []
  const injected: UserMessage[] = []
  const agent = {
    status: 'idle',
    session: { id: 'session-1', header: { cwd: tmpdir() } },
    followup: (message: UserMessage) => { followups.push(message) },
    inject: (message: UserMessage) => { injected.push(message) },
  }
  ctx.provide('systemPrompt', { tools: () => () => {} } as never)
  ctx.provide('agents', { get: (id: string) => (id === 'session-1' ? agent : undefined) } as never)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Monitor)
  const call = async (name: string, args: unknown, withAgent = true): Promise<Record<string, unknown>> => {
    const result = await ctx.tools.execute({
      callId: ToolCallId(`${name}-call`),
      signal: new AbortController().signal,
      name,
      arguments: args,
      ...withAgent ? { agent: agent as never } : {},
    })
    const block = result.content.find(item => item.type === 'text')
    return block?.type === 'text' ? JSON.parse(block.text) as Record<string, unknown> : {}
  }
  const until = async (predicate: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5000
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('timed out waiting')
      await new Promise((resolve) => { setTimeout(resolve, 20) })
    }
  }
  return { call, agent, followups, injected, until }
}

const textOf = (message: UserMessage | undefined): string => {
  const block = message?.content[0]
  return block?.type === 'text' ? block.text : ''
}

describe('monitor tools', () => {
  it('wakes an idle session with lines and injects into a busy one', async () => {
    const { call, agent, followups, injected, until } = await mount()
    const started = await call('monitor_start', { command: 'echo first; sleep 0.8; echo second; sleep 30', description: 'demo' })
    expect(started).toMatchObject({ status: 'running', description: 'demo' })
    await until(() => followups.length === 1)
    expect(textOf(followups[0])).toContain('printed 1 new line(s)')
    expect(textOf(followups[0])).toContain('\nfirst')
    expect(followups[0]?.source).toMatchObject({ kind: 'lsy-tool-monitor', form: 'notice' })
    agent.status = 'running'
    await until(() => injected.length === 1)
    expect(textOf(injected[0])).toContain('\nsecond')
    const listed = await call('monitor_list', {})
    expect(listed['monitors']).toEqual([expect.objectContaining({ id: started['id'], status: 'running', lines: 2 })])
    expect(await call('monitor_stop', { id: started['id'] })).toEqual({ stopped: started['id'] })
    expect(await call('monitor_stop', { id: started['id'] })).toMatchObject({ error: expect.stringContaining('no running monitor') as string })
  })

  it('runs the command without credential-shaped variables', async () => {
    process.env['LSY_MONITOR_TEST_API_KEY'] = 'leak-me'
    try {
      const { call, followups, until } = await mount()
      await call('monitor_start', { command: 'echo "key=${LSY_MONITOR_TEST_API_KEY:-unset} home=${HOME:+set}"', description: 'env' })
      // The command exits at once, so the lines notice and the ended notice may arrive together.
      await until(() => followups.length >= 1)
      expect(textOf(followups[0])).toContain('key=unset home=set')
      expect(textOf(followups[0])).not.toContain('leak-me')
    } finally {
      delete process.env['LSY_MONITOR_TEST_API_KEY']
    }
  })

  it('validates input and needs a session', async () => {
    const { call } = await mount()
    expect(await call('monitor_start', { command: ' ', description: 'x' })).toMatchObject({ error: expect.stringContaining('command') as string })
    expect(await call('monitor_start', { command: 'true', description: ' ' })).toMatchObject({ error: expect.stringContaining('description') as string })
    expect(await call('monitor_start', { command: 'true', description: 'x', timeout_minutes: 0 })).toMatchObject({ error: expect.stringContaining('timeout_minutes') as string })
    expect(await call('monitor_start', { command: 'true', description: 'x' }, false)).toEqual({ error: 'monitors need an agent session to report to' })
  })
})
