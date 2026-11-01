import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as Guard from '../src/index.ts'

const contexts: Context[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(dirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true, maxRetries: 5 }) }))
})

const CLEAN_CARD = "傲娇猫娘，嘴硬心软，句尾爱带'喵'，被夸会否认"

async function mount(script: ConstructorParameters<typeof MockAdapter>[0], config: Partial<Guard.Config> = {}, defaultModel = true) {
  const dir = await mkdtemp(join(tmpdir(), 'lsy-guard-plugin-'))
  dirs.push(dir)
  const ctx = new Context()
  contexts.push(ctx)
  const logs: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push(`${message.type} ${String(message.args[0])}`) } })
  await ctx.plugin(LlmRuntime)
  const adapter = new MockAdapter(script, { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } as never)
  ctx.llm.registerAdapter(['mock', 'other'], adapter)
  if (defaultModel) ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'cheap', reasoningEffort: 'low' }) } as never)
  const fiber = await ctx.plugin(Guard, Guard.Config({ dir, memoryFile: join(dir, 'memory.jsonl'), ...config } as never))
  return { ctx, adapter, dir, logs, fiber }
}

describe('plugin', () => {
  it('provides ctx.lsyGuard and checks through the profile default route', async () => {
    const { ctx, adapter, dir } = await mount([textResponse('{"label":"clear","categories":[]}')])
    expect(await ctx.lsyGuard.check(CLEAN_CARD, { purpose: 'persona_update', audience: 'public' })).toEqual({ ok: true })
    const [request] = adapter.requests
    expect(request).toMatchObject({ provider: 'mock', model: 'cheap', reasoningEffort: 'low', purpose: 'lsy-guard', temperature: 0 })
    expect(JSON.stringify(request!.messages)).toContain(CLEAN_CARD)
    expect(request!.tools).toBeUndefined()
    const [day] = await readdir(join(dir, 'raw'))
    const [file] = await readdir(join(dir, 'raw', day!))
    const record = JSON.parse(await readFile(join(dir, 'raw', day!, file!), 'utf8')) as { model: string; response: { blocks: Array<{ text: string }> } }
    expect(record.model).toBe('mock/cheap')
    expect(record.response.blocks[0]?.text).toBe('{"label":"clear","categories":[]}')
  })

  it('uses the configured provider and model instead, with the lightest reasoning effort the model offers', async () => {
    const { ctx, adapter } = await mount([textResponse('{"label":"pii","categories":["school_employer"]}')], { provider: 'other', model: 'tiny' })
    const verdict = await ctx.lsyGuard.check('a note', { purpose: 'style_note', audience: 'channel' })
    expect(verdict).toMatchObject({ ok: false, rule: 'llm.school_employer' })
    expect(adapter.requests[0]).toMatchObject({ provider: 'other', model: 'tiny', reasoningEffort: 'low' })
  })

  it('refuses as llm.unavailable when no route exists', async () => {
    const { ctx, adapter } = await mount([], {}, false)
    const verdict = await ctx.lsyGuard.check('a note', { purpose: 'style_note', audience: 'public' })
    expect(verdict).toMatchObject({ ok: false, rule: 'llm.unavailable' })
    expect(adapter.requests).toHaveLength(0)
    expect(ctx.lsyGuard.health().lastError?.message).toContain('no model route')
  })

  it('refuses as llm.unavailable when the adapter fails the stream, and keeps the partial response', async () => {
    const failure = [{ type: 'finish', reason: { kind: 'error', failure: { code: 'HTTP_503', message: 'gateway down' } } }]
    const { ctx, dir } = await mount([failure as never])
    const verdict = await ctx.lsyGuard.check('a note', { purpose: 'style_note', audience: 'public' })
    expect(verdict).toMatchObject({ ok: false, rule: 'llm.unavailable' })
    expect(ctx.lsyGuard.health().lastError?.message).toContain('gateway down')
    expect(await readdir(join(dir, 'raw'))).toHaveLength(1)
  })

  it('reads the canary file at its default place under the directory', async () => {
    const { ctx, dir } = await mount([])
    await writeFile(join(dir, 'canaries.txt'), 'secret-owner-name\n')
    expect(await ctx.lsyGuard.check('hello Secret-Owner-Name', { purpose: 'style_note', audience: 'public' })).toMatchObject({ ok: false, rule: 'canary' })
  })

  it('removes the service when the plugin unloads', async () => {
    const { ctx, fiber } = await mount([])
    expect(ctx.get('lsyGuard')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('lsyGuard')).toBeUndefined()
  })

  it('logs its layers and route once at start, with no text', async () => {
    const { logs } = await mount([])
    expect(logs.some(line => line.includes('lsy-guard: layers patterns=%s canary=%s memory=%s llm=%s'))).toBe(true)
  })
})

describe('configuration', () => {
  it('has the documented defaults', () => {
    expect(Guard.Config({} as never)).toMatchObject({
      layers: { patterns: true, canary: true, memory: true, llm: true }, blockLinks: true, extraCanaries: [],
      timeoutMs: 20_000, maxOutputTokens: 400, maxChars: 20_000, cacheHours: 24, rawRetentionDays: 14,
    })
  })

  it('refuses a relative path and half a route at load', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    expect(() => { Guard.apply(ctx, Guard.Config({ canaryFile: 'canaries.txt' } as never)) }).toThrow(/absolute/u)
    expect(() => { Guard.apply(ctx, Guard.Config({ provider: 'x' } as never)) }).toThrow(/together/u)
  })
})
