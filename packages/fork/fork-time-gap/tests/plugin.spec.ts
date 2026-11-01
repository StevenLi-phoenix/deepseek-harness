/** Real agent-loop turns through the time-gap plugin: the notice in the model request and the Session log. */

import { format } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, type ContextFormed, type GenerateOptions, type UserMessage } from '@deepseek-ai/dsh-llm'
import { untrustedRequestId } from '@deepseek-ai/dsh-fork-taint'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as TimeGap from '../src/index.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'schedule': { kind: 'schedule' } & ContextFormed
    'fork-wechat': { kind: 'fork-wechat' } & ContextFormed
  }
}

const MIN = 60_000
const start = Date.parse('2026-11-01T13:00:00Z')
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.useRealTimers()
})

type Source = UserMessage['source']
const OWNER: Source = { kind: 'user', rpcId: 'web' } as never
const message = (source: Source, text = 'hello'): UserMessage => createUserMessage({ content: [{ type: 'text', text }], source })

interface Bench {
  ctx: Context
  adapter: MockAdapter
  logs: string[]
  agent(id: string, agentPreset?: string): Promise<Agent>
  /** Wake the agent with these messages at `at` and wait for the turn to end. */
  send(agent: Agent, at: number, ...messages: UserMessage[]): Promise<void>
}

async function bench(config: Partial<TimeGap.Config> = {}, claims: Record<string, string> = {}): Promise<Bench> {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(start)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(Array.from({ length: 20 }, (_, index) => textResponse(`reply ${index}`)))
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.provide('ownerRelay', { ownerOf: (id: string) => claims[id] } as never)
  const logs: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (line) => { logs.push(`${line.type} ${format(...(line.args as unknown[]))}`) } })
  await ctx.plugin(TimeGap, TimeGap.Config(config))
  return {
    ctx, adapter, logs,
    agent: async (id, agentPreset) => (await ctx.agents.create({
      sessionId: SessionId(id),
      ...agentPreset === undefined ? {} : { meta: { agentPreset } },
      agentOptions: { provider: 'mock', model: 'mock' },
    })).agent,
    send: async (agent, at, ...messages) => {
      vi.setSystemTime(at)
      for (const item of messages) agent.followup(item)
      await agent.whenIdle()
    },
  }
}

/** The text blocks of the latest model request, in order. */
function lastRequestTexts(adapter: MockAdapter): string[] {
  const request: GenerateOptions = adapter.requests.at(-1)!
  return request.messages.filter(item => item.role === 'user').flatMap(item => item.content).flatMap(block => (block.type === 'text' ? [block.text] : []))
}

function notices(agent: Agent): UserMessage[] {
  return agent.session.snapshotEvents().flatMap(event => (event.type === 'user/message' && event.data.source.kind === 'fork-time-gap' ? [event.data] : []))
}

describe('the time-gap notice in a real agent loop', () => {
  it('adds nothing to the first message of a Session or to one inside the threshold', async () => {
    const b = await bench()
    const agent = await b.agent('web-chat')
    await b.send(agent, start, message(OWNER, 'first'))
    await b.send(agent, start + 4 * MIN, message(OWNER, 'soon after'))
    expect(notices(agent)).toEqual([])
    expect(lastRequestTexts(b.adapter).filter(text => text.startsWith('Time check'))).toEqual([])
    expect(b.logs.filter(line => line.includes('input after'))).toEqual([])
    expect(b.logs).toContain('info fork-time-gap: notice after 5 min of silence (America/New_York); presets excluded: qq-digest; sender presets: qqbot; channels with their own check: wechat')
  })

  it('puts the owner notice just before a Web UI message that ends a quiet spell, as a logged context notice', async () => {
    const b = await bench()
    const agent = await b.agent('web-chat')
    await b.send(agent, start, message(OWNER, 'first'))
    await b.send(agent, start + 3 * 3_600_000 + 5 * MIN, message(OWNER, 'back again'))
    const texts = lastRequestTexts(b.adapter)
    const at = texts.indexOf('back again')
    expect(texts[at - 1]).toBe(
      'Time check: the owner sent the message below at Sun 2026-11-01 11:05 (America/New_York), after 3 h 5 min of silence in this Session.'
      + ' Before it, the last exchange here was your own reply, at Sun 2026-11-01 08:00.'
      + ' Read the message on its own terms: it starts a new exchange unless it clearly refers back to something earlier.'
      + ' Things outside this conversation (files, processes, services, accounts, other people\'s messages) may have changed since then; check again before relying on what you saw earlier.',
    )
    // Durable and source-attributed, so Chat shows a collapsed notice row rather than an owner bubble, and replay rebuilds the request.
    expect(notices(agent).map(item => item.source)).toEqual([{ kind: 'fork-time-gap', form: 'notice', summary: 'Time check: 3 h 5 min since the last exchange' }])
    expect(b.logs).toContain('info fork-time-gap: Session web-chat, owner input after 3 h 5 min of silence')
    expect(b.logs.join('\n')).not.toContain('back again')
  })

  it('leaves the system prompt alone, so the cached prefix stays the same', async () => {
    const b = await bench()
    const agent = await b.agent('web-chat')
    await b.send(agent, start, message(OWNER, 'first'))
    await b.send(agent, start + 60 * MIN, message(OWNER, 'later'))
    const [first, second] = b.adapter.requests
    expect(second!.system).toEqual(first!.system)
    expect(second!.messages.slice(0, first!.messages.length)).toEqual(first!.messages)
  })

  it('says "the sender" in a channel bot\'s Session and for a message another Session passed on', async () => {
    const b = await bench()
    const qq = await b.agent('qq-chat', 'qqbot')
    await b.send(qq, start, message(OWNER, '[QQ 私聊 · ab12] hi'))
    await b.send(qq, start + 2 * 3_600_000, message(OWNER, '[QQ 私聊 · ab12] still there?'))
    expect(lastRequestTexts(b.adapter).find(text => text.startsWith('Time check'))).toMatch(/^Time check: the sender sent the message below at Sun 2026-11-01 10:00 \(America\/New_York\), after 2 h of silence/u)

    const main = await b.agent('main', 'unattended')
    await b.send(main, start, message(OWNER, 'hi'))
    await b.send(main, start + 30 * MIN, message({ kind: 'user', rpcId: untrustedRequestId('bili') } as never, 'from the sibling'))
    expect(lastRequestTexts(b.adapter).find(text => text.startsWith('Time check'))).toMatch(/^Time check: the sender sent the message below at .*, after 30 min of silence/u)
  })

  it('calls the owner\'s own Bilibili messages the owner\'s', async () => {
    const b = await bench()
    const bili = await b.agent('bili-dm', 'bili')
    await b.send(bili, start, message(OWNER))
    await b.send(bili, start + 10 * MIN, message(OWNER, 'again'))
    expect(lastRequestTexts(b.adapter).find(text => text.startsWith('Time check'))).toMatch(/^Time check: the owner sent the message below/u)
  })

  it('words a reminder days later and a bus event as arriving after the silence', async () => {
    const b = await bench()
    const agent = await b.agent('main', 'unattended')
    await b.send(agent, start, message(OWNER, 'remind me'))
    await b.send(agent, start + 3 * 86_400_000, message({ kind: 'schedule' }, '[reminder] check the parcel'))
    expect(lastRequestTexts(b.adapter).find(text => text.startsWith('Time check'))).toBe(
      'Time check: this reminder arrived at Wed 2026-11-04 08:00 (America/New_York), after 3 d of silence in this Session.'
      + ' Before it, the last exchange here was your own reply, at Sun 2026-11-01 08:00.'
      + ' Treat it as arriving now, not as part of the last exchange: what it concerns may have changed since then, so check the current state before acting on it.',
    )
    await b.send(agent, start + 3 * 86_400_000 + 6 * 3_600_000, message({ kind: 'webhook', form: 'notice', summary: 'fork-event batch' } as never, 'a batch'))
    expect(lastRequestTexts(b.adapter).find(text => text.startsWith('Time check: this event'))).toMatch(/^Time check: this event arrived at Wed 2026-11-04 14:00 \(America\/New_York\), after 6 h of silence/u)
    expect(notices(agent)).toHaveLength(2)
  })

  it('leaves the owner\'s messages in a WeChat chat Session to fork-wechat, but still marks a reminder there', async () => {
    const b = await bench({}, { wechat: 'wechat' })
    const agent = await b.agent('wechat', 'unattended')
    await b.send(agent, start, message(OWNER))
    // fork-wechat's own notice comes just before the owner message; this plugin adds no second one.
    const wechatNotice = createUserMessage({ content: [{ type: 'text', text: 'Time check: the owner sent the message below at … in this WeChat chat.' }], source: { kind: 'fork-wechat', form: 'notice', summary: 'time since the last chat message' } })
    await b.send(agent, start + 2 * 3_600_000, wechatNotice, message(OWNER, 'wechat later'))
    expect(lastRequestTexts(b.adapter).filter(text => text.startsWith('Time check'))).toEqual(['Time check: the owner sent the message below at … in this WeChat chat.'])
    expect(notices(agent)).toEqual([])
    await b.send(agent, start + 5 * 3_600_000, message({ kind: 'schedule' }, 'reminder'))
    expect(notices(agent)).toHaveLength(1)
    expect(b.logs).toContain('info fork-time-gap: Session wechat, reminder input after 3 h of silence')
    expect(b.logs).toContain('debug fork-time-gap: Session wechat belongs to wechat, which writes its own time check')
  })

  it('skips an excluded preset and a subagent\'s Session', async () => {
    const b = await bench({ excludePresets: ['qq-digest', 'up'] })
    const digest = await b.agent('digest', 'up')
    await b.send(digest, start, message({ kind: 'webhook' } as never))
    await b.send(digest, start + 86_400_000, message({ kind: 'webhook' } as never))
    expect(notices(digest)).toEqual([])
    const parent = await b.agent('parent')
    const child = (await b.ctx.agents.create({
      sessionId: SessionId('child'), parentAgent: parent,
      meta: { origin: 'subagent', parentSession: SessionId('parent'), delegationDepth: 1 },
      agentOptions: { provider: 'mock', model: 'mock' },
    })).agent
    await b.send(child, start, message(OWNER))
    await b.send(child, start + 86_400_000, message(OWNER))
    expect(notices(child)).toEqual([])
  })

  it('adds nothing when disabled', async () => {
    const b = await bench({ enabled: false })
    const agent = await b.agent('web-chat')
    await b.send(agent, start, message(OWNER))
    await b.send(agent, start + 86_400_000, message(OWNER))
    expect(notices(agent)).toEqual([])
  })

  it('measures from the previous input when it got no reply, and ignores injected context', async () => {
    const b = await bench({ thresholdMs: 10 * MIN })
    const agent = await b.agent('web-chat')
    await b.send(agent, start, message(OWNER))
    // An injected notice (another plugin's context) is not an input: it neither starts the count nor gets a notice.
    agent.inject(message({ kind: 'fork-wechat', form: 'notice', summary: 'x' } as never, 'context'))
    await b.send(agent, start + 9 * MIN, message(OWNER, 'nine minutes'))
    expect(notices(agent)).toEqual([])
    await b.send(agent, start + 25 * MIN, message(OWNER, 'later'))
    expect(lastRequestTexts(b.adapter).find(text => text.startsWith('Time check'))).toContain('after 16 min of silence')
  })

  it('refuses a time zone the runtime does not know', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(TimeGap, TimeGap.Config({ timeZone: 'Mars/Olympus' }))).rejects.toThrow('fork-time-gap: timeZone "Mars/Olympus" is not a known IANA zone')
  })
})
