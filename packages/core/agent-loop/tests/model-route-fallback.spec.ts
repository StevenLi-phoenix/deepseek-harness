/** A Session whose recorded model left the configuration continues on the configured route. */
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmError, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from './mock-adapter.ts'

/** Serves every model except the listed ones, which fail like a pi-ai route that no longer has them. */
class PartialAdapter extends MockAdapter {
  constructor(script: ConstructorParameters<typeof MockAdapter>[0], readonly missing: string[], private readonly code = 'UNKNOWN_MODEL') {
    super(script)
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (this.missing.includes(model)) return Promise.reject(new LlmError(`provider "${provider}" has no configured model "${model}"`, this.code))
    return super.resolveModel(provider, model)
  }
}

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('route-fallback'), { provider: 'mock', model: 'mock/current' })
  return { ctx, agent }
}

async function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

const turnEnds = (agent: Agent) => agent.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)

describe('recorded route that left the configuration', () => {
  it('continues on the configured route after the recorded model is removed, and records the switch', async () => {
    const adapter = new PartialAdapter([textResponse('ok'), textResponse('again'), textResponse('still')], [])
    const { agent } = await harness(adapter)
    agent.model.select({ provider: 'mock', model: 'renamed' })
    await send(agent, 'hello')
    adapter.missing.push('renamed')
    await send(agent, 'still there?')
    await send(agent, 'and now?')
    expect(turnEnds(agent)).toEqual(['completed', 'completed', 'completed'])
    expect(adapter.requests.map(request => request.model)).toEqual(['renamed', 'mock/current', 'mock/current'])
    expect(agent.model.current()).toEqual({ provider: 'mock', model: 'mock/current' })
    expect(agent.session.snapshotEvents().filter(event => event.type === 'model/selection').at(-1)?.data)
      .toEqual({ provider: 'mock', model: 'mock/current' })
  })

  it('keeps a recorded route that still resolves', async () => {
    const adapter = new PartialAdapter([textResponse('ok')], ['renamed'])
    const { agent } = await harness(adapter)
    agent.model.select({ provider: 'mock', model: 'chosen' })
    await send(agent, 'hello')
    expect(adapter.requests.map(request => request.model)).toEqual(['chosen'])
    expect(agent.model.current()).toEqual({ provider: 'mock', model: 'chosen' })
  })

  it('leaves other resolution failures to the step', async () => {
    const adapter = new PartialAdapter([textResponse('unused')], ['broken'], 'INVALID_CONFIG')
    const { agent } = await harness(adapter)
    agent.model.select({ provider: 'mock', model: 'broken' })
    await send(agent, 'hello')
    expect(turnEnds(agent)).toEqual(['error'])
    expect(adapter.requests).toEqual([])
    expect(agent.model.current()).toEqual({ provider: 'mock', model: 'broken' })
  })
})
