import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

/**
 * Memory and PII stay per channel: what the agent knows from WeChat (the owner memory, the chat Session,
 * the owner's accounts, people) is not visible to the Bilibili and QQ personas. Only a personality and style
 * layer may be shared between channels. These tests read the event bundle's composition, so a new plugin in
 * one of the other presets fails here until someone decides it is safe.
 */

/** One loader patch row; a `cordis:group` carries its rows as an array in `config`. */
interface Row {
  id: string
  name?: string
  config?: Record<string, unknown> | Row[]
  insert?: Row[]
}

const ROOT = join(import.meta.dirname, '../../../..')
const bundle = parse(readFileSync(join(ROOT, 'fork/bundles/event/cordis.patch.yml'), 'utf8'), { logLevel: 'error' }) as Row[]
const rootRows = bundle.flatMap(row => row.insert ?? [])
const presets = new Map(rootRows.filter(row => row.id.startsWith('preset-')).map(row => [row.id.slice('preset-'.length), row]))

/** Every plugin row of a preset, groups flattened. */
function pluginsOf(preset: Row): Row[] {
  const config = preset.config as { plugins?: Row[] }
  const rows: Row[] = []
  const walk = (list: Row[]): void => {
    for (const row of list) {
      rows.push(row)
      if (Array.isArray(row.config)) walk(row.config)
    }
  }
  walk(config.plugins ?? [])
  return rows
}

const names = (preset: string): string[] => pluginsOf(presets.get(preset)!).map(row => row.name ?? '')
const fieldsOf = (row: Row): Record<string, unknown> => (Array.isArray(row.config) ? {} : row.config ?? {})

/** The only preset that faces the owner on WeChat: the chat Session, watches, reminders, and the owner memory. */
const WECHAT_PRESET = 'unattended'
/** Presets that face Bilibili or QQ: strangers' text goes in, the persona's answer comes out. */
const OUTSIDE_PRESETS = ['bili', 'up', 'qqbot', 'qq-digest'] as const

/** Plugins that carry the owner's memory or reach the WeChat side, and why none may run in an outside preset. */
const WECHAT_SIDE: Record<string, string> = {
  '@deepseek-ai/dsh-fork-memory': 'injects the owner memory block and registers memory_search/save/forget (feedbackScope mode is the one exception, below)',
  '@deepseek-ai/dsh-fork-tool-wechat': 'sends files to the owner on WeChat',
  '@deepseek-ai/dsh-fork-cc-bridge': 'talks to Claude Code sessions and the WeChat chat Session on the owner\'s behalf',
  '@deepseek-ai/dsh-fork-tool-watch': 'creates watches that report into the WeChat chat Session',
  '@deepseek-ai/dsh-fork-tool-monitor': 'monitors whose output returns to a Session with the owner\'s context',
  '@deepseek-ai/dsh-fork-tool-voice': 'speaks to the owner through the WeChat notifier',
  '@deepseek-ai/dsh-fork-taint': 'only meaningful beside the memory and bridge tools',
  '@deepseek-ai/dsh-tool-schedule': 'reminders that start turns in the owner\'s Sessions',
  '@deepseek-ai/dsh-agent-instructions': 'reads the workspace instruction files, which hold what the owner told the main agent',
}

/** Everything an outside preset may mount today. A new row must be added here on purpose. */
const ALLOWED: Record<(typeof OUTSIDE_PRESETS)[number], string[]> = {
  'bili': [
    '@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-time-context', '@deepseek-ai/dsh-tool-bili',
    'cordis:group', '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-compaction-tool-result-pruner',
  ],
  // `fork-feedback` below is the one memory-package row an outside preset may have: see the dedicated test.
  'up': ['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-time-context', '@deepseek-ai/dsh-fork-tool-up', '@deepseek-ai/dsh-fork-memory'],
  'qqbot': [
    '@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-time-context',
    'cordis:group', '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-compaction-tool-result-pruner',
  ],
  // fork-tool-qq reads only what the QQ observer recorded; it carries no owner memory and reaches no WeChat side.
  'qq-digest': ['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-fork-tool-qq', 'cordis:group', '@deepseek-ai/dsh-compaction-basic'],
}

describe('channel isolation of the event bundle\'s presets', () => {
  it('composes the presets this test knows, so a new one is looked at', () => {
    expect([...presets.keys()].toSorted()).toEqual([WECHAT_PRESET, ...OUTSIDE_PRESETS].toSorted())
  })

  it.each(OUTSIDE_PRESETS)('the %s preset mounts nothing that carries the owner memory or reaches the WeChat side', (preset) => {
    const mounted = pluginsOf(presets.get(preset)!).filter(row => row.name !== undefined && row.name in WECHAT_SIDE)
    // `up` mounts the memory package once, in feedback mode; every other row here is a failure with its reason.
    const offenders = mounted
      .filter(row => !(preset === 'up' && row.id === 'fork-feedback'))
      .map(row => `${row.name!}: ${WECHAT_SIDE[row.name!]!}`)
    expect(offenders).toEqual([])
  })

  it.each(OUTSIDE_PRESETS)('the %s preset mounts only the plugins reviewed for it', (preset) => {
    const unreviewed = names(preset).filter(name => !ALLOWED[preset].includes(name))
    // No shell, file, web, job, or subagent tool means no way to call the Host's own HTTP routes from the model.
    expect(unreviewed).toEqual([])
  })

  it('mounts the owner memory in the WeChat preset only, with its tools and taint rules beside it', () => {
    const wechat = pluginsOf(presets.get(WECHAT_PRESET)!)
    const memory = wechat.filter(row => row.name === '@deepseek-ai/dsh-fork-memory')
    expect(memory.map(row => row.id)).toEqual(['fork-memory'])
    expect(fieldsOf(memory[0]!)).not.toHaveProperty('feedbackScope')
    for (const name of ['@deepseek-ai/dsh-fork-taint', '@deepseek-ai/dsh-fork-tool-wechat']) {
      expect(wechat.map(row => row.name)).toContain(name)
    }
  })

  it('lets the up preset read only the owner\'s keep/delete verdicts on its own replies, and nothing of the memory', () => {
    // Why this exception exists: the verdicts are a style layer (tone to match or avoid), written by the owner's own
    // service through `memory-admin feedback add`, scoped to `up`. `feedbackScope` mode registers no memory tool and
    // does not read memory.jsonl (fork-memory's feedback spec asserts both), so no WeChat-side fact reaches the persona.
    const memory = pluginsOf(presets.get('up')!).filter(row => row.name === '@deepseek-ai/dsh-fork-memory')
    expect(memory.map(row => row.id)).toEqual(['fork-feedback'])
    expect(fieldsOf(memory[0]!)).toEqual({ feedbackScope: 'up' })
    // No other outside preset reads even the verdicts.
    for (const preset of ['bili', 'qqbot', 'qq-digest'] as const) expect(names(preset)).not.toContain('@deepseek-ai/dsh-fork-memory')
  })

  it('keeps the owner memory out of every root row, since root rows reach every preset', () => {
    expect(rootRows.filter(row => !row.id.startsWith('preset-')).map(row => row.name)).not.toContain('@deepseek-ai/dsh-fork-memory')
    expect(rootRows.filter(row => !row.id.startsWith('preset-')).map(row => row.name)).not.toContain('@deepseek-ai/dsh-fork-tool-wechat')
  })
})

describe('/api/fork.memory is not reachable from any preset\'s tools', () => {
  const settings = readFileSync(join(ROOT, 'packages/fork/fork-memory/src/settings.ts'), 'utf8')

  it('is a root row beside the page, not part of any preset', () => {
    const row = rootRows.find(entry => entry.name === '@deepseek-ai/dsh-fork-memory/settings')
    expect(row?.id).toBe('fork-memory-settings')
    for (const preset of presets.keys()) expect(names(preset)).not.toContain('@deepseek-ai/dsh-fork-memory/settings')
  })

  it('needs only the connection service and registers no tool, so no model can call it', () => {
    expect(settings).toMatch(/export const inject = \['connection'\]/u)
    expect(settings).not.toMatch(/defineTool|\.tools\b|tools\.register/u)
  })

  it('is answered only to the owner\'s signed-in Web UI (the connection refuses every other principal)', () => {
    // The contract is the connection's: "Only owner Peers reach an exact route; the shared handler answers 403 for
    // every other principal" (ConnectionFetchRoute in packages/client/connection/src/rpc.ts). The outside presets also
    // have no shell, file, web, or job tool to send a request with (see the reviewed lists above).
    const contract = readFileSync(join(ROOT, 'packages/client/connection/src/rpc.ts'), 'utf8')
    expect(contract).toContain('Only owner Peers reach an exact route')
  })
})
