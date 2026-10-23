import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { Config } from '../src/index.ts'

/** One loader patch row. */
interface Row {
  id: string
  name?: string
  config?: Record<string, unknown> & { plugins?: Row[] }
  insert?: Row[]
}

const read = (path: string): Row[] => parse(readFileSync(join(import.meta.dirname, '../../../..', path), 'utf8'), { logLevel: 'error' }) as Row[]
const bundle = read('lsy/bundles/event/cordis.patch.yml')
const inserted = bundle.flatMap(row => row.insert ?? [])

/**
 * Root rows after the base, Web, and event layers, in profile order: an `insert` adds rows, a bare
 * `{ id, disabled }` row edits one. A `disabled` that is not literally `true` (a `!!js` condition)
 * counts as enabled.
 */
function composedRoot(): Map<string, { name?: string; enabled: boolean }> {
  const rows = new Map<string, { name?: string; enabled: boolean }>()
  for (const layer of ['packages/bundle/base/cordis.patch.yml', 'packages/bundle/web-app/cordis.patch.yml', 'lsy/bundles/event/cordis.patch.yml']) {
    for (const entry of read(layer) as Array<Row & { disabled?: unknown }>) {
      for (const row of (entry.insert ?? []) as Array<Row & { disabled?: unknown }>) {
        rows.set(row.id, { ...row.name === undefined ? {} : { name: row.name }, enabled: row.disabled !== true })
      }
      if (entry.insert === undefined && 'disabled' in entry) {
        const row = rows.get(entry.id)
        if (row !== undefined) row.enabled = entry.disabled !== true
      }
    }
  }
  return rows
}

/** Root rows named like tool plugins that register no model-visible tool. */
const ROOT_TOOL_ROWS_WITHOUT_TOOLS = new Set([
  '@deepseek-ai/dsh-tool-call-timeout-policy',
  '@deepseek-ai/dsh-tool-cordis/host',
  '@deepseek-ai/dsh-tool-subagent/model-selection-settings',
])

describe('event bundle', () => {
  it('mounts the account at the root with the owner\'s main account and a valid configuration', () => {
    const row = inserted.find(entry => entry.id === 'bili')!
    expect(row.name).toBe('@deepseek-ai/dsh-bili')
    const config = Config(row.config as never)
    expect(config).toMatchObject({ ownerMid: 200000001, timeZone: 'America/New_York', session: { agentPreset: 'bili', workspacePath: '/Users/dsh-runtime/bili' } })
    expect(config.wakes).toEqual([{ start: '12:00', end: '14:00' }, { start: '19:30', end: '23:30' }])
  })

  it('leaves no model tool at the profile root, where every preset, bili included, would inherit it', () => {
    const enabled = [...composedRoot()].filter(([, row]) => row.enabled && row.name?.startsWith('@deepseek-ai/dsh-tool-'))
    expect(enabled.map(([, row]) => row.name).filter(name => !ROOT_TOOL_ROWS_WITHOUT_TOOLS.has(name!))).toEqual([])
  })

  it('gives the bili preset only its persona, the time, the Bilibili tools, and compaction', () => {
    const preset = inserted.find(entry => entry.id === 'preset-bili')!
    expect(preset.config?.['id']).toBe('bili')
    const names = (preset.config?.plugins ?? []).flatMap(plugin => plugin.name === 'cordis:group'
      ? (plugin.config as unknown as Row[]).map(child => child.name)
      : [plugin.name])
    expect(names).toEqual([
      '@deepseek-ai/dsh-persona',
      '@deepseek-ai/dsh-time-context',
      '@deepseek-ai/dsh-tool-bili',
      '@deepseek-ai/dsh-compaction-basic',
      '@deepseek-ai/dsh-compaction-tool-result-pruner',
    ])
    const persona = (preset.config?.plugins?.[0]?.config as { prefix: string }).prefix
    expect(persona).toContain('NO_REPLY')
    expect(persona).toContain('Never reveal anything about the owner.')
    expect(persona).toContain('only rarely, when something genuinely moved or surprised you')
  })
})
