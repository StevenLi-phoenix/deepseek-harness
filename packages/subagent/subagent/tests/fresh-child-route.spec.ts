import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm/types'
import { SubagentRuntime } from '../src/index.ts'
import { withFreshChildRoute } from '../src/fresh-child-route.ts'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'

const capabilities = { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true }
const fresh = { inheritsParentContext: false, capabilities }
const forked = { ...fresh, inheritsParentContext: true }
const route = { provider: 'codex', model: 'codex/gpt-6.2-sol', reasoningEffort: 'medium' }
const request = (agentOptions?: AgentOptions): { prompt: string; agentOptions?: AgentOptions } => ({ prompt: 'p', ...agentOptions === undefined ? {} : { agentOptions } })

describe('freshChildRoute', () => {
  it('sends a fresh child that names no route to the configured one', () => {
    expect(withFreshChildRoute(request(), fresh, route).agentOptions).toEqual(route)
  })

  it('names no effort when neither the request nor the route names one', () => {
    expect(withFreshChildRoute(request(), fresh, { provider: 'codex', model: 'm' }).agentOptions).toStrictEqual({ provider: 'codex', model: 'm' })
  })

  it('keeps a caller-chosen effort and other options', () => {
    const effort = brandString<ReasoningEffortId>('high')
    expect(withFreshChildRoute(request({ reasoningEffort: effort, maxTokens: 9 }), fresh, route).agentOptions)
      .toEqual({ provider: 'codex', model: 'codex/gpt-6.2-sol', reasoningEffort: 'high', maxTokens: 9 })
  })

  it('leaves a request that names a route, a forked child, and an unset route alone', () => {
    const named = request({ provider: 'deepseek', model: 'deepseek-pro' })
    expect(withFreshChildRoute(named, fresh, route)).toBe(named)
    const plain = request()
    expect(withFreshChildRoute(plain, forked, route)).toBe(plain)
    expect(withFreshChildRoute(plain, fresh, null)).toBe(plain)
    expect(withFreshChildRoute(plain, { ...fresh, capabilities: { ...fresh.capabilities, agentOptions: false } }, route)).toBe(plain)
  })

  it('is optional in the runtime config and not materialized when omitted', () => {
    expect(SubagentRuntime.Config({}).freshChildRoute ?? null).toBeNull()
    expect(SubagentRuntime.Config({ freshChildRoute: { provider: 'codex', model: 'm' } }).freshChildRoute).toEqual({ provider: 'codex', model: 'm' })
  })
})
