/** `ctx.notifyLearning`: the capture's writes, the nightly pass with a scripted model, the retries, and the owner's notice. */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { format } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { type GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import type { Exchange, Rule } from '../src/records.ts'
import { localClock, NotifyLearning, type LearningSettings } from '../src/service.ts'
import { LearningStore } from '../src/store.ts'

const SETTINGS: LearningSettings = {
  enabled: true, channel: 'wechat', timeZone: 'America/New_York', hour: 5, windowHours: 12, maxReplies: 3, maxExchanges: 100,
  maxBatch: 30, minExchanges: 2, clueDays: 14, maxRules: 20, maxClues: 40, maxEvidence: 5, kindChars: 40, quoteChars: 120,
  notify: true, provider: 'mock', model: 'mock', maxOutputTokens: 2000, rawKept: 30,
}
/** 05:00 in New York, the hour of the pass. */
const NOW = new Date('2026-11-27T10:00:00Z')
const HOUR = 3_600_000

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

type Script = ConstructorParameters<typeof MockAdapter>[0]

async function bench(options: { settings?: Partial<LearningSettings>; script?: Script; notifier?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-notify-learning-service-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  const logs: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (line) => { logs.push(`${line.type} ${format(...(line.args as unknown[]))}`) } })
  await ctx.plugin(LlmRuntime)
  const adapter = new MockAdapter(options.script ?? [])
  ctx.llm.registerAdapter(['mock'], adapter)
  const notices: Array<{ title: string; body?: string; safety?: boolean; origin?: string }> = []
  if (options.notifier !== false) ctx.provide('ownerNotifier', { send: (note: (typeof notices)[number]) => { notices.push(note); return Promise.resolve() } } as never)
  ctx.provide('ownerRelay', { ownerOf: (id: string) => (id === 'wechat' ? 'wechat' : undefined) } as never)
  const store = new LearningStore(join(root, 'notify-learning'), error => logs.push(`failure ${String(error)}`))
  const service = new NotifyLearning(ctx, { ...SETTINGS, ...options.settings }, store)
  return { ctx, adapter, logs, notices, store, service, dir: store.dir }
}

const exchange = (id: string, at: Date, owner: string[] = []): Exchange => ({
  id, session: 'wechat', at: at.toISOString(), trigger: 'peer:note', sent: 'CI 失败：build #12',
  replies: owner.map(text => ({ at: at.toISOString(), owner: text, agent: '好' })),
})

/** A model answer that names one signal per exchange of the request, quoting its first reply. */
const agreeing = (kind = 'CI 失败通知', decision = 'silent') => (request: GenerateOptions) => {
  const [block] = request.messages[0]!.content
  const { exchanges } = JSON.parse(block?.type === 'text' ? block.text : '{}') as { exchanges: Array<{ id: string; replies: Array<{ owner: string }> }> }
  return textResponse(`\`\`\`json\n${JSON.stringify({ signals: exchanges.map(item => ({ exchange: item.id, kind, decision, quote: item.replies[0]!.owner })) })}\n\`\`\``)
}

describe('localClock', () => {
  it('reads the day and hour in the zone', () => {
    expect(localClock(NOW, 'America/New_York')).toEqual({ day: '2026-11-27', hour: 5 })
    expect(localClock(new Date('2026-11-27T16:30:00Z'), 'Asia/Shanghai')).toEqual({ day: '2026-11-28', hour: 0 })
  })
})

describe('NotifyLearning', () => {
  it('keeps what the capture reports and logs it, and nothing while learning is off', async () => {
    const b = await bench()
    const session = { id: 'wechat', header: {} } as Session
    const feed = (events: Array<{ type: string; data: unknown }>): void => {
      for (const event of events) b.service.observe(session, event as SessionEvent)
    }
    const turn = (source: unknown, text: string) => [
      { type: 'turn/start', data: {} },
      { type: 'user/message', data: { source, content: [{ type: 'text', text }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `re: ${text}` }] } } },
      { type: 'turn/end', data: {} },
    ]
    // An owner turn with nothing open is no reaction.
    feed(turn({ kind: 'user' }, '在吗'))
    feed(turn({ kind: 'schedule' }, '交作业'))
    await b.store.drain()
    feed(turn({ kind: 'user' }, '知道了'))
    await b.store.drain()
    const [kept] = await b.store.exchanges()
    expect(kept).toMatchObject({ trigger: 'scheduled', sent: 're: 交作业', replies: [{ owner: '知道了', agent: 're: 知道了' }] })
    expect(b.logs).toContain(`info notify-learning: kept ${kept!.id} from Session wechat (scheduled, 7 chars) for the owner's reaction`)
    expect(b.logs).toContain('info notify-learning: the owner\'s turn (3 chars) follows 1 open message(s)')
    expect(b.logs.filter(line => line.includes('follows'))).toHaveLength(1)

    const off = await bench({ settings: { enabled: false } })
    for (const event of turn({ kind: 'schedule' }, 'x')) off.service.observe(session, event as SessionEvent)
    await off.store.drain()
    expect(await off.store.exchanges()).toEqual([])
  })

  it('logs a capture write that failed', async () => {
    const b = await bench()
    await b.store.update(state => ({ state }))
    await import('node:fs/promises').then(fs => fs.writeFile(join(b.dir, 'exchanges.json'), 'broken'))
    const session = { id: 'wechat', header: {} } as Session
    for (const event of [
      { type: 'turn/start', data: {} },
      { type: 'user/message', data: { source: { kind: 'schedule' }, content: [{ type: 'text', text: 'r' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' }] } } },
      { type: 'turn/end', data: {} },
    ]) b.service.observe(session, event as SessionEvent)
    await b.store.drain()
    expect(b.logs.some(line => line.startsWith('failure LearningFileError:'))).toBe(true)
  })

  it('shows the rules block only while on and with a rule', async () => {
    const b = await bench()
    expect(await b.service.block(true)).toBeUndefined()
    const rule: Rule = { id: 'r00000a', kind: 'CI', decision: 'silent', since: NOW.toISOString(), evidence: [] }
    await b.store.update(state => ({ state: { ...state, revision: 2, rules: [rule] } }))
    expect(await b.service.rules()).toEqual({ revision: 2, rules: [rule] })
    const block = await b.service.block(false)
    expect(block?.revision).toBe(2)
    expect(block?.text).toContain('- (r00000a) CI → silent')
    const off = new NotifyLearning(b.ctx, { ...SETTINGS, enabled: false }, b.store)
    expect(await off.block(true)).toBeUndefined()
  })

  it('deletes a rule the owner names, with a history line, and nothing for an unknown id', async () => {
    const b = await bench()
    const rule: Rule = { id: 'r00000a', kind: 'CI', decision: 'silent', since: NOW.toISOString(), evidence: [] }
    await b.store.update(state => ({ state: { ...state, revision: 2, rules: [rule] } }))
    expect(await b.service.forget('r0000ff')).toBeUndefined()
    expect(await b.service.forget('r00000a')).toEqual(rule)
    expect(await b.service.rules()).toEqual({ revision: 3, rules: [] })
    const [line] = (await readFile(join(b.dir, 'history.jsonl'), 'utf8')).trim().split('\n').map(item => JSON.parse(item) as Record<string, unknown>)
    expect(line).toMatchObject({ revision: 3, by: 'owner', added: [], removed: [rule] })
    expect(b.logs).toContain('info notify-learning: the owner deleted rule r00000a (silent)')
  })

  it('drops messages nobody answered and keeps the open ones when there is nothing to read', async () => {
    const b = await bench()
    await b.store.addExchange(exchange('x00000001', new Date(NOW.getTime() - 13 * HOUR)), SETTINGS)
    await b.store.addExchange(exchange('x00000002', new Date(NOW.getTime() - HOUR), ['还没完']), SETTINGS)
    expect(await b.service.runIfDue(NOW)).toEqual({ outcome: 'nothing', dropped: 1 })
    expect((await b.store.exchanges()).map(item => item.id)).toEqual(['x00000002'])
    expect((await b.store.state()).lastRunDay).toBe('2026-11-27')
    expect(b.adapter.requests).toEqual([])
    expect(b.logs).toContain('info notify-learning: pass of 2026-11-27: no replies to read; 1 message(s) without one dropped')
    // Done for the day.
    expect(await b.service.runIfDue(new Date(NOW.getTime() + 5 * HOUR))).toBeUndefined()
  })

  it('learns a rule from two agreeing exchanges, keeps the raw answer and a history line, and tells the owner', async () => {
    const b = await bench({ script: [agreeing()] })
    await b.store.addExchange(exchange('x00000001', new Date(NOW.getTime() - 30 * HOUR), ['这种 CI 失败别发了']), SETTINGS)
    // Closed early: it has maxReplies turns.
    await b.store.addExchange(exchange('x00000002', new Date(NOW.getTime() - HOUR), ['又是 CI', '别发', '真的']), SETTINGS)
    await b.store.addExchange(exchange('x00000003', new Date(NOW.getTime() - HOUR), ['等等']), SETTINGS)
    const report = await b.service.runIfDue(NOW)
    expect(report).toMatchObject({ outcome: 'learned', read: 2, dropped: 0, accepted: 2, rejected: [], removed: [], model: 'mock/mock' })
    const request = b.adapter.requests[0]!
    expect(request).toMatchObject({ provider: 'mock', model: 'mock', temperature: 0, maxTokens: 2000, purpose: 'notify-learning' })
    expect(request.messages[0]!.source).toEqual({ kind: 'notify-learning' })
    const { rules, revision, lastRunDay, attempts } = await b.store.state()
    expect({ revision, lastRunDay, attempts }).toEqual({ revision: 1, lastRunDay: '2026-11-27', attempts: undefined })
    expect(rules.map(rule => [rule.kind, rule.decision, rule.evidence.map(item => item.quote)])).toEqual([['CI 失败通知', 'silent', ['又是 CI', '这种 CI 失败别发了']]])
    expect((await b.store.exchanges()).map(item => item.id)).toEqual(['x00000003'])
    const raw = await readdir(join(b.dir, 'raw'))
    expect(raw).toEqual(['2026-11-27T10-00-00.000Z.json'])
    const saved = JSON.parse(await readFile(join(b.dir, 'raw', raw[0]!), 'utf8')) as { model: string; text: string }
    expect(saved.model).toBe('mock/mock')
    expect(saved.text).toContain('"signals"')
    expect(JSON.parse(await readFile(join(b.dir, 'history.jsonl'), 'utf8'))).toMatchObject({ revision: 1, by: 'nightly', model: 'mock/mock', removed: [] })
    expect(b.notices.map(note => ({ ...note, body: note.body?.split('\n')[0] }))).toEqual([{
      title: '主动消息的规则有变化',
      body: '新规则：「CI 失败通知」→ 不用告诉你（11/27「又是 CI」、11/25「这种 CI 失败别发了」）',
      safety: true,
      origin: 'the notification-rule learner (its nightly pass)',
    }])
    expect(b.logs).toContain('info notify-learning: pass of 2026-11-27 on mock/mock read 2 exchange(s): 2 signal(s) taken, 0 refused (none), 1 rule(s) added, 0 removed, revision 1')
  })

  it('reads at most maxBatch exchanges, and with no change writes no history and sends no notice', async () => {
    const b = await bench({ settings: { maxBatch: 1 }, script: [textResponse('{"signals":[{"exchange":"x0000000f","kind":"a","decision":"tell","quote":"b"}]}')] })
    await b.store.addExchange(exchange('x00000001', new Date(NOW.getTime() - 20 * HOUR), ['a']), SETTINGS)
    await b.store.addExchange(exchange('x00000002', new Date(NOW.getTime() - 20 * HOUR), ['b']), SETTINGS)
    expect(await b.service.run(NOW)).toMatchObject({ outcome: 'learned', read: 1, accepted: 0, rejected: [{ index: 0, why: 'unknown_exchange' }], added: [] })
    expect((await b.store.exchanges()).map(item => item.id)).toEqual(['x00000002'])
    await expect(readFile(join(b.dir, 'history.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(b.notices).toEqual([])
    expect(b.logs.some(line => line.includes('1 refused (unknown_exchange)'))).toBe(true)
  })

  it('learns without a notice when notify is off, and warns when no notifier is mounted', async () => {
    for (const [settings, notifier] of [[{ notify: false }, true], [{}, false]] as const) {
      const b = await bench({ settings, notifier, script: [agreeing()] })
      await b.store.addExchange(exchange('x00000001', new Date(NOW.getTime() - 20 * HOUR), ['别发了']), SETTINGS)
      await b.store.addExchange(exchange('x00000002', new Date(NOW.getTime() - 20 * HOUR), ['别发了']), SETTINGS)
      expect((await b.service.run(NOW)).outcome).toBe('learned')
      expect(b.notices).toEqual([])
      expect(b.logs.includes('warn notify-learning: no owner notifier; the owner was not told of 1 new and 0 dropped rule(s)')).toBe(!notifier)
    }
  })

  it('waits for the hour, retries a failed pass an hour later at most three times a day, then tries again the next day', async () => {
    const script: Script = Array.from({ length: 4 }, () => textResponse('the owner seems annoyed'))
    const b = await bench({ script })
    await b.store.addExchange(exchange('x00000001', new Date(NOW.getTime() - 20 * HOUR), ['别发了']), SETTINGS)
    expect(await b.service.runIfDue(new Date(NOW.getTime() - HOUR))).toBeUndefined()
    await expect(b.service.runIfDue(NOW)).rejects.toThrow('the answer is not JSON')
    expect((await b.store.state()).attempts).toEqual({ day: '2026-11-27', count: 1, at: NOW.toISOString() })
    expect(await b.service.runIfDue(new Date(NOW.getTime() + HOUR / 2))).toBeUndefined()
    await expect(b.service.runIfDue(new Date(NOW.getTime() + HOUR))).rejects.toThrow()
    await expect(b.service.runIfDue(new Date(NOW.getTime() + 2 * HOUR))).rejects.toThrow()
    expect((await b.store.state()).attempts?.count).toBe(3)
    expect(await b.service.runIfDue(new Date(NOW.getTime() + 5 * HOUR))).toBeUndefined()
    expect(b.adapter.requests).toHaveLength(3)
    // The exchange waits for the next try.
    expect(await b.store.exchanges()).toHaveLength(1)
    await expect(b.service.runIfDue(new Date(NOW.getTime() + 24 * HOUR))).rejects.toThrow()
    expect((await b.store.state()).attempts).toEqual({ day: '2026-11-28', count: 1, at: new Date(NOW.getTime() + 24 * HOUR).toISOString() })
  })

  it('fails without a route when neither the model nor the profile\'s default route is set', async () => {
    const b = await bench({ settings: { provider: undefined, model: undefined } })
    await b.store.addExchange(exchange('x00000001', new Date(NOW.getTime() - 20 * HOUR), ['别发了']), SETTINGS)
    await expect(b.service.run(NOW)).rejects.toThrow('no model route: set provider and model, or mount agentDefaultModel')
  })

  it('runs one pass at a time, and dispose stops a running call and drains', async () => {
    const b = await bench({ script: ['hang'] })
    await b.store.addExchange(exchange('x00000001', new Date(NOW.getTime() - 20 * HOUR), ['别发了']), SETTINGS)
    const running = b.service.run(NOW)
    const failed = running.catch((error: unknown) => error)
    expect(b.service.run(NOW)).toBe(running)
    expect(await b.service.runIfDue(NOW)).toBeUndefined()
    await new Promise(resolve => setTimeout(resolve, 10))
    await b.service.dispose()
    expect(await failed).toBeInstanceOf(Error)
    expect(await b.store.exchanges()).toHaveLength(1)
    // Off means no pass at all.
    const off = new NotifyLearning(b.ctx, { ...SETTINGS, enabled: false }, b.store)
    expect(await off.runIfDue(NOW)).toBeUndefined()
    await off.dispose()
  })
})
