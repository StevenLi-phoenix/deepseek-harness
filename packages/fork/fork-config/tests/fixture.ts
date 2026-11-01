/** A real profile with a bundle layer, the owner's patch, optionally a home patch, and this plugin mounted over a fake connection. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import * as plugin from '../src/index.ts'
import type { ConfigDescribe, ConfigSaveResult } from '../src/view.ts'

export const SAMPLE = z.object({
  url: z.string().default('ws://127.0.0.1:3001'),
  tokenEnv: z.string().role('credential-ref').default('SAMPLE_TOKEN'),
  password: z.string().role('secret'),
  groups: z.array(z.string()).default([]).volatile(),
  media: z.object({
    images: z.boolean().default(true),
    maxBytes: z.natural().min(1024).default(15 * 1024 * 1024),
    hosts: z.array(z.string()).default(['qq.com']),
  }),
  mode: z.union([z.const('fast'), z.const('slow')]).default('fast'),
  extra: z.dict(z.number()),
  note: z.string().description('Shown in the card'),
})

export interface Route {
  path: string
  methods: readonly string[]
  requestBody: string
  fetch: (request: Request) => Promise<Response>
}

export interface FixtureOptions {
  bundle?: Record<string, unknown>
  owner?: unknown[]
  /** The owner's patch as YAML text, for what JSON cannot spell (`!!js`). */
  ownerText?: string
  home?: unknown[]
}

/** Boot the profile and mount the plugin; `logs` collects `type message` lines. */
export async function configFixture(options: FixtureOptions = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'fork-config-')))
  const dir = join(home, 'profiles', 'test')
  onTestFinished(() => { rmSync(home, { recursive: true, force: true }) })
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'fork-config', name: 'cordis:forkconfig' },
    { id: 'sample', name: 'cordis:probe', config: options.bundle ?? { url: 'ws://bundle:1', password: 'private-value', media: { maxBytes: 4096 } } },
    { id: 'other', name: 'cordis:probe', config: { password: 'x', media: {} } },
    { id: 'bare', name: 'cordis:bare' },
    { id: 'off', name: 'cordis:probe', disabled: true },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  if (options.owner !== undefined) writeFileSync(join(dir, 'cordis.patch.yml'), JSON.stringify(options.owner))
  if (options.ownerText !== undefined) writeFileSync(join(dir, 'cordis.patch.yml'), options.ownerText)
  if (options.home !== undefined) writeFileSync(join(home, 'cordis.patch.yml'), JSON.stringify(options.home))
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  const routes: Route[] = []
  const logs: string[] = []
  const applied: unknown[] = []
  const Probe = { Config: SAMPLE, apply: (_ctx: Context, config: unknown) => { applied.push(config) } }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (root) => {
    root.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push(`${message.type} ${String(message.args[0])}`) } })
    root.provide('profileContext', profile)
    root.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    root.provide('connection', { fetch: { register: (route: Route) => { routes.push(route); return () => Promise.resolve() } } } as never)
    Object.assign(root.loader.builtins, {
      editor: ConfigEditor, settings: Settings, probe: Probe, bare: { apply: () => {} }, forkconfig: plugin,
    })
  })
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const route = (): Route => {
    const found = routes.find(entry => entry.path === '/api/fork.config')
    if (found === undefined) throw new Error('route not registered')
    return found
  }
  const get = async (ids = 'sample', exclude = ''): Promise<ConfigDescribe> => {
    const response = await route().fetch(new Request(`http://127.0.0.1/api/fork.config?entries=${ids}&exclude=${exclude}`))
    expect200(response)
    return await response.json() as ConfigDescribe
  }
  const post = async (body: unknown): Promise<{ status: number; body: ConfigSaveResult }> => {
    const response = await route().fetch(new Request('http://127.0.0.1/api/fork.config', { method: 'POST', body: JSON.stringify(body) }))
    return { status: response.status, body: await response.json() as ConfigSaveResult }
  }
  return { ctx, profile, home, routes, logs, applied, get, post }
}

function expect200(response: Response): void {
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
}
