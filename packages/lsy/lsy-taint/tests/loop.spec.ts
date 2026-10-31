import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as Taint from '../src/index.ts'

/** The guard in the real agent loop with a scripted model: the origin is read from the log the loop writes. */

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

async function harness(script: ConstructorParameters<typeof MockAdapter>[0], config: Partial<Taint.Config> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const sent: Array<{ title: string; body?: string }> = []
  ctx.provide('lsyNotifier', { send: (note: { title: string; body?: string }) => { sent.push(note); return Promise.resolve() } } as never)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const ran: string[] = []
  for (const name of ['cc_send', 'schedule_create']) {
    ctx.tools.register(defineTool({
      name,
      description: name,
      parameters: {},
      output: { schema: { type: 'json' }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
      execute() { ran.push(name); return Promise.resolve({ ok: true }) },
      presentCall: () => ({ card: 'generic', title: name, kind: 'other' }),
    }))
  }
  await ctx.plugin(Taint, config)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const agent = await ctx.agentLoop.create(SessionId('chat'), { provider: 'mock', model: 'mock' })
  return { ctx, agent, ran, sent }
}

function idle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: seen, status }) => { if (seen === agent && status === 'idle') { dispose(); resolve() } })
  })
}

const say = (agent: Agent, rpcId: string): void => {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'do it' }], source: { kind: 'user', rpcId } as never }))
}

describe('cc_send in the real agent loop', () => {
  it('runs in a turn the owner started and is refused in one a relayed message started', async () => {
    const { ctx, agent, ran } = await harness([
      toolCallResponse('c1', 'cc_send', {}), textResponse('owner turn done'),
      toolCallResponse('c2', 'cc_send', {}), textResponse('peer turn done'),
    ])
    const first = idle(ctx, agent)
    say(agent, 'owner-1')
    await first
    expect(ran).toEqual(['cc_send'])
    const second = idle(ctx, agent)
    say(agent, 'lsy-untrusted:cc:11111111-1111-4111-8111-111111111111')
    await second
    expect(ran).toEqual(['cc_send'])
    const refused = agent.session.snapshotEvents().filter(event => event.type === 'tool/result').at(-1)
    expect(JSON.stringify(refused)).toContain('only available in a turn the owner started alone')
  })

  it('lets a reminder through from a relayed turn and reports it when the turn ends', async () => {
    const { ctx, agent, ran, sent } = await harness([toolCallResponse('c1', 'schedule_create', {}), textResponse('done')])
    const done = idle(ctx, agent)
    say(agent, 'lsy-untrusted:bili:22222222-2222-4222-8222-222222222222')
    await done
    expect(ran).toEqual(['schedule_create'])
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.body).toContain('定时提醒（schedule_create）')
  })
})
