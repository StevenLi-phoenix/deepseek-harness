import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { MemoryStore } from '@deepseek-ai/dsh-owner-memory'
import { afterEach, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'
import * as Guard from '../src/index.ts'
import * as GuardSettings from '../src/settings.ts'

/** One loader patch row. */
interface Row {
  id: string
  name?: string
  config?: Record<string, unknown>
  insert?: Row[]
}

const root = join(import.meta.dirname, '../../../..')
const inserted = (parse(readFileSync(join(root, 'fork/bundles/event/cordis.patch.yml'), 'utf8'), { logLevel: 'error' }) as Row[]).flatMap(row => row.insert ?? [])
const bundleRow = inserted.find(row => row.id === 'content-guard')!
const settingsRow = inserted.find(row => row.id === 'content-guard-settings')!

const HONEYPOT = 'zq-honeypot-4c81e2'
const MEMORY_FACT = '主人每周三晚上都会去城南的攀岩馆练习抱石'
const CLEAN = "傲娇猫娘，嘴硬心软，句尾爱带'喵'，被夸会否认"

/** The model the guard talks to: its answer depends on a marker in the text, a call it fails, or `clear`. */
class ScriptedModel extends LlmAdapter {
  readonly seen: string[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = JSON.stringify(options.messages)
    this.seen.push(text)
    if (text.includes('MODEL-DOWN')) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'HTTP_503', message: 'gateway down' } } }
      return
    }
    const label = text.includes('MODEL-UNSURE') ? 'unsure' : 'clear'
    const answer = JSON.stringify({ label, categories: [] })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: answer }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const model = new ScriptedModel()

/** Test-only plugin: the mock route and the profile's default model selection. */
const support = {
  name: 'test-model-route',
  inject: ['llm'],
  apply(ctx: Context): void {
    ctx.llm.registerAdapter(['mock'], model)
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'cheap' }) } as never)
  },
}

/** Test-only stand-in for the Web connection: keeps the registered routes so the test can call them. */
const routes = new Map<string, (request: Request) => Promise<Response>>()
const connection = {
  name: 'test-connection',
  apply(ctx: Context): void {
    ctx.provide('connection', { fetch: { register(route: { path: string; fetch: (request: Request) => Promise<Response> }) {
      routes.set(route.path, route.fetch)
      return () => { routes.delete(route.path); return Promise.resolve() }
    } } } as never)
  },
}

let dir: string | undefined
let context: CordisContext | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  model.seen.length = 0
  routes.clear()
  if (dir !== undefined) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  dir = undefined
})

/** Boot the guard through the Loader from the bundle's own row, with the paths and the honeypot the profile patch would add. */
async function boot(): Promise<{ ctx: CordisContext; dir: string }> {
  dir = await mkdtemp(join(tmpdir(), 'content-guard-loader-'))
  await new MemoryStore(join(dir, 'memory.jsonl')).save({ text: MEMORY_FACT, category: 'projects' })
  const entries = [
    { name: 'test-model-route' },
    { name: '@deepseek-ai/dsh-llm' },
    { name: 'test-connection' },
    { ...bundleRow, id: undefined, config: { ...bundleRow.config, dir: join(dir, 'guard'), memoryFile: join(dir, 'memory.jsonl'), extraCanaries: [HONEYPOT] } },
    { name: settingsRow.name, config: settingsRow.config },
  ]
  const configPath = join(dir, 'cordis.yml')
  await writeFile(configPath, stringify(entries))
  context = new CordisContext()
  context.baseUrl = `${pathToFileURL(dir).href}/`
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-model-route', support],
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['test-connection', connection],
    [bundleRow.name!, Guard],
    [settingsRow.name!, GuardSettings],
  ])
  // The Loader's module resolver, replaced so the entries import the in-repo modules by name.
  Object.assign(context.loader, {
    internal: {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    },
  })
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return { ctx: context, dir }
}

describe('the bundle row booted through the Loader', () => {
  it('exposes ctx.get("contentGuard") and answers the six cases of the contract', async () => {
    const { ctx, dir: home } = await boot()
    const guard = ctx.get('contentGuard')
    expect(guard).toBeDefined()
    const check = (text: string, audience: 'public' | 'channel' = 'public') => guard!.check(text, { purpose: 'persona_update', audience, sessionId: 's1' })

    expect(await check(CLEAN)).toEqual({ ok: true })
    expect(model.seen).toHaveLength(1)

    // Canary from the configuration (the honeypot a profile patch adds), in any case.
    expect(await check(`那个 ${HONEYPOT.toUpperCase()} 是什么`)).toMatchObject({ ok: false, rule: 'canary' })
    // A pattern hit.
    expect(await check('联系我 13812345678')).toMatchObject({ ok: false, rule: 'pattern.phone' })
    // Overlap with the owner's memory file.
    expect(await check('听说每周三晚上都会去城南的攀岩馆练习抱石的那个人很强')).toMatchObject({ ok: false, rule: 'memory_overlap' })
    expect(model.seen).toHaveLength(1)
    // A model that cannot tell.
    expect(await check('MODEL-UNSURE 一段含糊的话')).toMatchObject({ ok: false, rule: 'llm.unsure' })
    // A model that fails: fail closed.
    expect(await check('MODEL-DOWN 一段话', 'channel')).toMatchObject({ ok: false, rule: 'llm.unavailable' })

    const refusals = Object.values(guard!.health().byRule).reduce((sum, count) => sum + count, 0)
    expect(refusals).toBe(5)
    // The raw responses of the two model calls that answered or failed are on disk.
    const [day] = await readdir(join(home, 'guard', 'raw'))
    expect((await readdir(join(home, 'guard', 'raw', day!))).length).toBeGreaterThanOrEqual(3)
    // No refusal repeats the text.
    const verdict = await check(`那个 ${HONEYPOT} 是什么`)
    expect(JSON.stringify(verdict)).not.toContain(HONEYPOT)
  })

  it('serves refusal counts by rule at /api/content-guard, with no text in the answer', async () => {
    const { ctx } = await boot()
    await ctx.contentGuard.check(`那个 ${HONEYPOT} 是什么`, { purpose: 'style_note', audience: 'channel' })
    await ctx.contentGuard.check('联系我 13812345678', { purpose: 'style_note', audience: 'channel' })
    const serve = routes.get('/api/content-guard')
    expect(serve).toBeDefined()
    const response = await serve!(new Request('http://x/api/content-guard'))
    const body = await response.json() as { health: { checked: number; rejected: number; byRule: Record<string, number> } }
    expect(body.health).toMatchObject({ checked: 2, rejected: 2 })
    expect(body.health.byRule).toEqual({ canary: 1, 'pattern.phone': 1 })
    expect(JSON.stringify(body)).not.toContain(HONEYPOT)
    expect(JSON.stringify(body)).not.toContain('13812345678')
  })

  it('removes the service and the route when the Loader entries are disposed', async () => {
    const { ctx } = await boot()
    expect(ctx.get('contentGuard')).toBeDefined()
    expect(routes.has('/api/content-guard')).toBe(true)
    await ctx.fiber.dispose()
    expect(ctx.get('contentGuard')).toBeUndefined()
    expect(routes.has('/api/content-guard')).toBe(false)
  })
})
