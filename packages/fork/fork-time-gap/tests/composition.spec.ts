/** Real Loader composition: a test-only cordis.yml mounts the plugin through its shipped exports beside a real agent loop. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as timeGapModule from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.useRealTimers()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('fork-time-gap through the real Loader', () => {
  it('reads its row\'s config and adds the notice to a request after a quiet spell; a config change applies on reload', { timeout: 60_000 }, async () => {
    expect('default' in timeGapModule).toBe(false)
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.parse('2026-11-01T13:00:00Z')
    vi.setSystemTime(start)
    root = await mkdtemp(join(tmpdir(), 'dsh-time-gap-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- name: fixture-agents',
      '- id: fork-time-gap',
      "  name: '@deepseek-ai/dsh-fork-time-gap'",
      '  config:',
      '    thresholdMs: 600000',
      '    timeZone: Asia/Shanghai',
      '',
    ].join('\n'))
    const adapter = new MockAdapter(Array.from({ length: 6 }, (_, index) => textResponse(`reply ${index}`)))
    let host: Context | undefined
    const agents = {
      name: 'fixture-agents',
      async apply(ctx: Context) {
        host = ctx
        await mountAgentLoopTestDependencies(ctx)
        await ctx.plugin(AgentLoop, { agents: [] })
        ctx.effect(() => ctx.get('llm')!.registerAdapter(['mock'], adapter))
      },
    }
    const modules = new Map<string, unknown>([['fixture-agents', agents], ['@deepseek-ai/dsh-fork-time-gap', timeGapModule]])
    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    Reflect.set(context.loader, 'internal', {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    })
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()
    expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])

    const { agent } = await host!.get('agents')!.create({ sessionId: SessionId('owner-chat'), agentOptions: { provider: 'mock', model: 'mock' } })
    const say = async (at: number, text: string): Promise<string[]> => {
      vi.setSystemTime(at)
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
      // Only this turn's messages: the ones after the last assistant message of the history.
      const messages = adapter.requests.at(-1)!.messages
      const turn = messages.slice(messages.findLastIndex(item => item.role === 'assistant') + 1)
      return turn.flatMap(item => item.content).flatMap(block => (block.type === 'text' && block.text.startsWith('Time check') ? [block.text] : []))
    }
    expect(await say(start, 'first')).toEqual([])
    // Nine minutes is under the row's ten.
    expect(await say(start + 9 * 60_000, 'second')).toEqual([])
    const [notice] = await say(start + 9 * 60_000 + 2 * 3_600_000, 'third')
    expect(notice?.startsWith('Time check: the owner sent the message below at Sun 2026-11-01 23:09 (Asia/Shanghai), after 2 h of silence')).toBe(true)

    // Settings saves rewrite the row and reload the plugin: the new instance reads the new threshold.
    const entry = [...context.loader.entries()].find(item => item.options.name === '@deepseek-ai/dsh-fork-time-gap')!
    await context.loader.update(entry.id, { config: { thresholdMs: 36_000_000, timeZone: 'Asia/Shanghai' } })
    await context.loader.await()
    expect(await say(start + 9 * 60_000 + 6 * 3_600_000, 'fourth')).toEqual([])
    await context.loader.update(entry.id, { config: { enabled: false } })
    await context.loader.await()
    expect(await say(start + 30 * 3_600_000, 'fifth')).toEqual([])
  })
})
