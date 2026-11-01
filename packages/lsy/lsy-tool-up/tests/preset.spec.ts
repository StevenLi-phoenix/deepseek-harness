import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { afterEach, describe, expect, it } from 'vitest'
import { leakedServices } from '../../../preset/agent-preset-registry/src/mount.ts'
import * as ToolUp from '../src/index.ts'

const contexts: Context[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'lsy-tool-up-preset-'))
  dirs.push(dir)
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('systemPrompt', { tools: () => () => {} } as never)
  ctx.provide('credentials', { resolve: async () => ({ value: 't' }) } as never)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  return { ctx, config: ToolUp.Config({ notes: { file: join(dir, 'notes.json') }, evidence: { saltFile: join(dir, 'salt') } } as never) }
}

// The agent-preset registry refuses a preset whose rows publish a service outside an isolate realm
// (`leakedServices`); the `up` preset's `bili-channel` group (`isolate: { biliEvidence: true }`) is that realm.
describe('ctx.biliEvidence and the up preset\'s isolate realm', () => {
  it('leaks into the root realm when mounted without one, which the preset registry refuses', async () => {
    const { ctx, config } = await setup()
    const fiber = await ctx.plugin(ToolUp, config)
    expect(leakedServices(ctx, fiber)).toEqual(['biliEvidence'])
  })

  it('stays in the realm of the group that isolates biliEvidence', async () => {
    const { ctx, config } = await setup()
    const realm = ctx.isolate('biliEvidence')
    const fiber = await realm.plugin(ToolUp, config)
    expect(leakedServices(ctx, fiber)).toEqual([])
    expect(ctx.get('biliEvidence')).toBeUndefined()
    expect(typeof realm.get('biliEvidence')?.evidenceOf).toBe('function')
  })
})
