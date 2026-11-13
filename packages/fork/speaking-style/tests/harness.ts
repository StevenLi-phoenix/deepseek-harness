import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as Style from '../src/index.ts'

/** Shared fixtures and fake services of the speaking-style specs: every external service is a recorded or scripted fake. */

export const fixture = (name: string): unknown => {
  const value: unknown = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/miner', name), 'utf8'))
  return value
}
export const fixtureText = (name: string): string => readFileSync(join(import.meta.dirname, 'fixtures/miner', name), 'utf8')

const contexts: Context[] = []
const dirs: string[] = []

/** Dispose every context and directory the specs made; call from `afterEach`. */
export async function cleanup(): Promise<void> {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(dirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true, maxRetries: 5 }) }))
}

export async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'speaking-style-'))
  dirs.push(dir)
  return dir
}

export function track(ctx: Context): Context {
  contexts.push(ctx)
  return ctx
}

/** A guard that refuses texts holding any of the listed markers, as the content-guard layers would. */
export function fakeGuard(markers: Record<string, string> = { 'CANARY-7': 'canary', 'MEMORY-SPAN': 'memory-overlap', 'sk-live-': 'pattern' }) {
  const calls: Array<{ text: string; options: unknown }> = []
  return {
    calls,
    check: (text: string, options: unknown) => {
      calls.push({ text, options })
      const hit = Object.entries(markers).find(([marker]) => text.includes(marker))
      return Promise.resolve(hit === undefined ? { ok: true as const } : { ok: false as const, rule: hit[1], publicReason: 'this text looks like protected content' })
    },
  }
}

/** A scripted web search service: records the queries, answers with the given result. */
export function fakeWeb(result: unknown) {
  const queries: string[] = []
  return { queries, search: (request: { query: string }) => { queries.push(request.query); return Promise.resolve(result) } }
}

/** A scripted model: answers by the system prompt, so the order of the miner's two calls does not matter. */
export function minerScript(answers: { propose?: unknown; meaning?: unknown }) {
  const pick = (options: GenerateOptions) => {
    const system = typeof options.system === 'string' ? options.system : JSON.stringify(options.system)
    const answer = system.includes('学网络热梗') ? answers.propose : answers.meaning
    return textResponse(JSON.stringify(answer ?? {}))
  }
  return [pick, pick, pick, pick, pick, pick]
}

export const minerModel = (answers: { propose?: unknown; meaning?: unknown }): MockAdapter => new MockAdapter(minerScript(answers))


export interface MountOptions {
  config?: Partial<Style.Config>
  guard?: ReturnType<typeof fakeGuard> | 'absent'
  adapter?: MockAdapter
  web?: ReturnType<typeof fakeWeb>
  hot?: { comments?: unknown[]; words?: unknown[] }
  qq?: { texts?: string[]; shown?: Record<string, string[]> }
  notifier?: Array<{ title: string; body?: string; safety?: true }>
}

/** The style service at the root with fake external services and the agent loop's test dependencies. */
export async function mountStyle(options: MountOptions = {}) {
  const dir = await tmp()
  const ctx = track(new Context())
  await mountAgentLoopTestDependencies(ctx)
  const guard = options.guard === 'absent' ? undefined : options.guard ?? fakeGuard()
  if (guard !== undefined) ctx.provide('contentGuard' as never, guard as never)
  if (options.hot !== undefined) {
    ctx.provide('biliHot' as never, { comments: () => Promise.resolve(options.hot?.comments ?? []), words: () => Promise.resolve(options.hot?.words ?? []) } as never)
  }
  if (options.web !== undefined) ctx.provide('web', options.web as never)
  const notes = options.notifier ?? []
  ctx.provide('ownerNotifier', { send: (note: { title: string }) => { notes.push(note); return Promise.resolve() } } as never)
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) } as never)
  const shown = options.qq?.shown ?? {}
  const messages = (options.qq?.texts ?? []).map((text, index) => ({
    messageId: String(index), userId: `u${String(index)}`, at: Date.now() - 3_600_000, text, replyTo: null, kinds: 'text', card: '', nickname: '',
  }))
  ctx.provide('qq', {
    groupOverview: () => Promise.resolve([{ groupId: 'g1', recorded: messages.length > 0 }]),
    recentMessages: () => Promise.resolve(messages),
    recentTextOf: (sessionId: string) => shown[sessionId],
  } as never)
  const adapter = options.adapter ?? new MockAdapter([])
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(Style, {
    dir, ticsFile: join(dir, 'tics.json'), qq: { enabled: false }, bili: { enabled: false }, hotwatch: { enabled: false }, ...options.config,
  } as Style.Config)
  return { ctx, dir, adapter, notices: notes, guard, style: ctx.get('speakingStyle')! }
}
