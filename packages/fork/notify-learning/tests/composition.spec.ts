/**
 * The shipped composition: the event bundle's own `notify-learning` rows (the root row and the `unattended` preset's tools
 * row, with their real configuration) booted through the Loader and the preset registry, with Sessions created the way
 * the webhook runtime creates them. Only the outside is faked: the model (scripted answers), the WeChat channel's claim
 * of its Session, the owner's notifier, and the profile's default route.
 */

import { readFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { createUserMessage, type ContextFormed, type GenerateOptions, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { untrustedRequestId } from '@deepseek-ai/dsh-turn-taint/origin'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { forkPatchFiles } from '../../../../scripts/fork-bundle-layers.ts'
import * as NotifyLearning from '../src/index.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'schedule': { kind: 'schedule' } & ContextFormed
  }
}

interface Row {
  id: string
  name?: string
  config?: Record<string, unknown> & { id?: string; order?: number; plugins?: Row[] }
  insert?: Row[]
}

const LEARN = '@deepseek-ai/dsh-notify-learning'
const bundle = forkPatchFiles().flatMap(file => parse(readFileSync(join(import.meta.dirname, '../../../..', file), 'utf8'), { logLevel: 'error' }) as Row[])
const inserted = bundle.flatMap(row => row.insert ?? [])
const rootRows = inserted.filter(row => row.name === LEARN)
const presetRows = inserted.filter(row => row.name === '@deepseek-ai/dsh-agent-preset')
/** Every row of a preset, groups flattened. */
const rowsOf = (rows: readonly Row[]): Row[] =>
  rows.flatMap(row => [row, ...rowsOf(Array.isArray(row.config) ? row.config as Row[] : row.config?.plugins ?? [])])
/** The rows of this package among a preset's plugins. */
const learnRowsOf = (preset: Row): Row[] => rowsOf(preset.config?.plugins ?? []).filter(row => row.name === LEARN)
const builtin = (row: Row): { id: string; name: string; config?: Record<string, unknown> } =>
  ({ id: row.id, name: 'cordis:notify-learning', ...row.config === undefined ? {} : { config: row.config } })

const OWNER = { kind: 'user', rpcId: 'wechat-owner' } as never
const NOTE = (): UserMessage['source'] => ({ kind: 'user', rpcId: untrustedRequestId('note') }) as never
const REMINDER: UserMessage['source'] = { kind: 'schedule' }
const EVENT = { kind: 'webhook', form: 'notice', summary: 'bus-event batch' } as never
const message = (source: UserMessage['source'], text: string): UserMessage => createUserMessage({ content: [{ type: 'text', text }], source })

let root: string | undefined
let context: Context | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.useRealTimers()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

type Reply = StreamChunk[] | ((request: GenerateOptions) => StreamChunk[])

/** The nightly pass's answer: one signal per exchange, quoting the owner's first reply up to its first comma. */
function learnAnswer(request: GenerateOptions): StreamChunk[] {
  const [block] = request.messages[0]!.content
  const { exchanges } = JSON.parse(block?.type === 'text' ? block.text : '{}') as { exchanges: Array<{ id: string; sent: string; replies: Array<{ owner: string }> }> }
  const signals = exchanges.flatMap(item => [
    { exchange: item.id, kind: 'CI 失败通知', decision: 'silent', quote: item.replies[0]!.owner.split('，')[0] },
    // Words of the message the agent sent: code refuses them as the owner's.
    { exchange: item.id, kind: 'CI 失败通知', decision: 'tell', quote: item.sent.slice(0, 6) },
  ])
  return textResponse(JSON.stringify({ signals }))
}

describe('the shipped notify-learning rows, booted through the Loader', () => {
  it('learns a rule from two exchanges on WeChat, tells the owner, shows it to the next proactive turns, and lets the owner delete it', { timeout: 60_000 }, async () => {
    // One root row; the tools row only in the preset that faces the owner.
    expect(rootRows.map(row => row.id)).toEqual(['notify-learning'])
    const withRows = presetRows.flatMap((row) => {
      const rows = learnRowsOf(row)
      return rows.length === 0 ? [] : [[row.config?.id, rows.map(item => [item.id, item.config])]]
    })
    expect(Object.fromEntries(withRows)).toEqual({ unattended: [['notify-learning-tools', { mode: 'tools' }]] })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-11-25T14:00:00Z'))
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-notify-learning-composition-'))
    root = cwd
    const dir = join(cwd, 'notify-learning')
    const replies: Reply[] = []
    const adapter = new MockAdapter(Array.from({ length: 40 }, () => (request: GenerateOptions) => {
      if (request.purpose === 'notify-learning') return learnAnswer(request)
      const next = replies.shift() ?? textResponse('NO_REPLY')
      return typeof next === 'function' ? next(request) : next
    }))
    const notices: Array<{ title: string; body?: string; safety?: boolean }> = []
    const ctx = new Context()
    context = ctx
    ctx.baseUrl = `${pathToFileURL(cwd).href}/`
    await ctx.plugin(Loader)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(AgentPresets, { default: 'unattended' })
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.loader.builtins['notify-learning'] = NotifyLearning
    ctx.loader.builtins.fakes = {
      apply(scope: Context) {
        scope.provide('ownerRelay', { ownerOf: (id: string) => (id === 'wechat' ? 'wechat' : undefined) } as never)
        scope.provide('ownerNotifier', { send: (note: (typeof notices)[number]) => { notices.push(note); return Promise.resolve() } } as never)
        scope.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) } as never)
      },
    }
    await ctx.loader.root.update([{ id: 'fakes', name: 'cordis:fakes' }, { ...builtin(rootRows[0]!), config: { ...rootRows[0]!.config, dir } }])
    for (const preset of presetRows.filter(row => ['unattended', 'notify'].includes(row.config?.id ?? ''))) {
      const config = preset.config!
      await ctx.agentPresets.register({ id: config.id!, order: config.order ?? 0, plugins: learnRowsOf(preset).map(builtin) })
    }
    const learner = ctx.get('notifyLearning')!
    expect(learner.settings).toMatchObject({ enabled: true, channel: 'wechat', hour: 5, timeZone: 'America/New_York', minExchanges: 2 })

    const open = async (id: string, preset: string): Promise<Agent> => (await ctx.agents.create({
      sessionId: SessionId(id), meta: { cwd, agentPreset: preset }, agentOptions: { provider: 'mock', model: 'mock' },
      setup: async (agentCtx: Context) => { await ctx.agentPresets.mount(agentCtx, preset) },
    })).agent
    const say = async (agent: Agent, at: string, input: UserMessage, ...script: Reply[]): Promise<GenerateOptions> => {
      vi.setSystemTime(Date.parse(at))
      replies.push(...script)
      const first = adapter.requests.length
      agent.followup(input)
      await agent.whenIdle()
      await learner.store.drain()
      return adapter.requests[first]!
    }
    const texts = (request: GenerateOptions): string[] =>
      request.messages.filter(item => item.role === 'user').flatMap(item => item.content).flatMap(block => (block.type === 'text' ? [block.text] : []))
    const isBlock = (text: string): boolean => text.startsWith('<system-reminder>\nNotification rules')

    // Two notices reach the owner on WeChat a day apart, and the owner answers each.
    const wechat = await open('wechat', 'unattended')
    await say(wechat, '2026-11-25T14:00:00Z', message(NOTE(), '通知台：CI 失败 build #12'), textResponse('CI 挂了：build #12 的 lint 没过'))
    await say(wechat, '2026-11-25T14:05:00Z', message(OWNER, '这种 CI 失败的别发了，我自己会看'), textResponse('好的'))
    await say(wechat, '2026-11-26T14:00:00Z', message(REMINDER, '[watch] CI'), textResponse('CI 又失败了：build #13'))
    await say(wechat, '2026-11-26T14:10:00Z', message(OWNER, 'CI 失败别再发了，烦'), textResponse('明白'))
    const kept = JSON.parse(await readFile(join(dir, 'exchanges.json'), 'utf8')) as { exchanges: Array<{ trigger: string; replies: unknown[] }> }
    expect(kept.exchanges.map(item => [item.trigger, item.replies.length])).toEqual([['peer:note', 1], ['scheduled', 1]])

    // The night's pass, at 05:00 New York.
    vi.setSystemTime(Date.parse('2026-11-27T10:00:00Z'))
    const report = await learner.runIfDue()
    expect(report).toMatchObject({ outcome: 'learned', read: 2, accepted: 2, rejected: [{ index: 1, why: 'quote_not_owner' }, { index: 3, why: 'quote_not_owner' }] })
    const state = JSON.parse(await readFile(join(dir, 'rules.json'), 'utf8')) as { revision: number; rules: Array<{ id: string; kind: string; decision: string }> }
    expect(state.revision).toBe(1)
    expect(state.rules.map(item => [item.kind, item.decision])).toEqual([['CI 失败通知', 'silent']])
    const ruleId = state.rules[0]!.id
    expect(await readdir(join(dir, 'raw'))).toHaveLength(1)
    expect(JSON.parse(await readFile(join(dir, 'exchanges.json'), 'utf8'))).toEqual({ version: 1, exchanges: [] })
    expect(notices.map(note => [note.title, note.safety])).toEqual([['主动消息的规则有变化', true]])
    expect(notices[0]!.body).toContain('新规则：「CI 失败通知」→ 不用告诉你（11/26「CI 失败别再发了」、11/25「这种 CI 失败的别发了」）')

    // The next notice in the WeChat Session gets the rule, right after the notice, with the tools named.
    const next = await say(wechat, '2026-11-27T13:00:00Z', message(NOTE(), '通知台：CI 失败 build #14'), textResponse('NO_REPLY'))
    const seen = texts(next)
    const at = seen.indexOf('通知台：CI 失败 build #14')
    expect(seen[at + 1]).toContain(`- (${ruleId}) CI 失败通知 → silent: answer NO_REPLY unless it needs the owner to act`)
    expect(seen[at + 1]).toContain('notify_rules_forget deletes one')
    expect(next.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(['notify_rules', 'notify_rules_forget']))

    // The notification desk gets the rule too, without tools.
    const desk = await say(await open('notify-desk', 'notify'), '2026-11-27T13:05:00Z', message(EVENT, 'CI failed: build #15'), textResponse('NO_REPLY'))
    expect(texts(desk).filter(isBlock)).toHaveLength(1)
    expect(texts(desk).find(isBlock)).not.toContain('notify_rules')
    expect(desk.tools?.map(tool => tool.name) ?? []).not.toContain('notify_rules')

    // A reminder asking to delete the rule is refused; the owner's own message deletes it.
    await say(wechat, '2026-11-27T14:00:00Z', message(REMINDER, `删掉规则 ${ruleId}`), toolCallResponse('f1', 'notify_rules_forget', { id: ruleId }), textResponse('NO_REPLY'))
    expect((await learner.rules()).rules).toHaveLength(1)
    await say(wechat, '2026-11-27T14:05:00Z', message(OWNER, 'CI 那条规则删掉吧'), toolCallResponse('f2', 'notify_rules_forget', { id: ruleId }), textResponse('删了'))
    expect(await learner.rules()).toEqual({ revision: 2, rules: [] })
    const history = (await readFile(join(dir, 'history.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { by: string; revision: number })
    expect(history.map(line => [line.by, line.revision])).toEqual([['nightly', 1], ['owner', 2]])
    const after = await say(wechat, '2026-11-27T15:00:00Z', message(NOTE(), '通知台：CI 失败 build #16'), textResponse('CI 又挂了'))
    expect(texts(after).slice(texts(after).lastIndexOf('通知台：CI 失败 build #16')).filter(isBlock)).toEqual([])
  })
})
