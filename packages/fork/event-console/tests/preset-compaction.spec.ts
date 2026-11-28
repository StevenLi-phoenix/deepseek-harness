import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  resolveConfig,
  resolveCompactSpec,
  resolveTargetPolicy,
} from '../../../compaction/compaction-basic/src/config.ts'
import { forkBundleLayers } from '../../../../scripts/fork-bundle-layers.ts'

/** One loader patch row. */
interface Row {
  id: string
  name?: string
  config?: unknown
  insert?: Row[]
}

/** The child rows a `cordis:group` carries in `config`. */
const groupRows = (config: unknown): Row[] => {
  if (!Array.isArray(config)) throw new Error('cordis:group config is not an array')
  return config as Row[]
}

const read = (file: string): Row[] =>
  parse(readFileSync(join(import.meta.dirname, '../../../..', file), 'utf8'), { logLevel: 'error' }) as Row[]

/** The compaction group the event bundle gives one preset. */
function compactionGroup(presetRow: string): Row[] {
  const layer = forkBundleLayers().find(entry => entry.name === '@deepseek-ai/dsh-event-bundle')
  if (layer === undefined) throw new Error('the event bundle is not mounted by the profile')
  const preset = read(layer.file).flatMap(row => row.insert ?? []).find(row => row.id === presetRow)
  if (preset === undefined) throw new Error(`the event bundle mounts no ${presetRow}`)
  const plugins = (preset.config as { plugins?: Row[] }).plugins ?? []
  const group = plugins.find(row => row.id === 'compaction')
  if (group === undefined) throw new Error(`${presetRow} mounts no compaction group`)
  return groupRows(group.config)
}

/** The `compaction-basic` config the event bundle gives one preset, the unattended one by default. */
function unattendedCompactionConfig(presetRow = 'preset-unattended'): Record<string, unknown> {
  const basic = compactionGroup(presetRow).find(row => row.id === 'compaction-basic')
  if (basic === undefined) throw new Error('the compaction group mounts no compaction-basic')
  return (basic.config ?? {}) as Record<string, unknown>
}

const ROUTE = { provider: 'opencode-go', model: 'opencode-go/deepseek-v4.1-flash' }
/** The route's capacity: the 1M-token context and the 384k request output reservation. */
const CONTEXT_WINDOW = 1_000_000
const RESERVED_COMPLETION_TOKENS = 384_000

describe('the unattended preset condenses near the window, not early', () => {
  it('keeps the trigger near the top of the window and a large verbatim tail', () => {
    const config = unattendedCompactionConfig()
    expect(config['thresholdRatio']).toBe(0.8)
    expect(config['headroomTokens']).toBe(8_192)
    expect(config['retainTokens']).toBe(131_072)
    expect(config['maxTokens']).toBe(32_768)
  })

  it('resolves to a trigger at or above 600k and a 128k verbatim tail on the routed model', () => {
    const spec = resolveCompactSpec(
      resolveTargetPolicy(resolveConfig(unattendedCompactionConfig()), ROUTE),
      CONTEXT_WINDOW,
      RESERVED_COMPLETION_TOKENS,
    )
    expect(spec.thresholdTokens).toBe(607_808)
    expect(spec.retainTokens).toBe(131_072)
    expect(spec.maxTokens).toBe(32_768)
  })

  it('stays above the plugin default it replaces, and above the 600k the owner asked for', () => {
    const spec = resolveCompactSpec(
      resolveTargetPolicy(resolveConfig(), ROUTE),
      CONTEXT_WINDOW,
      RESERVED_COMPLETION_TOKENS,
    )
    expect(spec.thresholdTokens).toBe(550_464)
    // The configured trigger must never condense earlier than the plugin's own default.
    const configured = resolveCompactSpec(
      resolveTargetPolicy(resolveConfig(unattendedCompactionConfig()), ROUTE),
      CONTEXT_WINDOW,
      RESERVED_COMPLETION_TOKENS,
    )
    expect(configured.thresholdTokens).toBeGreaterThan(spec.thresholdTokens)
    expect(configured.thresholdTokens).toBeGreaterThanOrEqual(600_000)
  })
})

/** The job pipeline's route: Codex GPT-6.2 Sol, a 500k window with 128k reserved for output (pi-ai's catalog). */
const JOB_ROUTE = { provider: 'codex', model: 'codex/gpt-6.2-sol' }
const JOB_CONTEXT_WINDOW = 500_000
const JOB_RESERVED_COMPLETION_TOKENS = 128_000

describe('the job presets condense before the window', () => {
  // The job lead is one Session the schedule feeds every two hours; without compaction it reached 519k tokens on
  // a 500k route, and from 00:15 ET on 2026-11-28 each of its turns ended CONTEXT_WINDOW_EXCEEDED (2026-11-28).
  it.each(['preset-job-lead', 'preset-job-apply', 'preset-job-inbox'])('%s mounts the unattended compaction and pruner', (preset) => {
    expect(unattendedCompactionConfig(preset)).toEqual(unattendedCompactionConfig())
    expect(compactionGroup(preset).map(row => row.name)).toEqual(compactionGroup('preset-unattended').filter(row => row.id !== 'command-compact').map(row => row.name))
  })

  it('resolves to a trigger below the window on the job route', () => {
    const spec = resolveCompactSpec(
      resolveTargetPolicy(resolveConfig(unattendedCompactionConfig('preset-job-lead')), JOB_ROUTE),
      JOB_CONTEXT_WINDOW,
      JOB_RESERVED_COMPLETION_TOKENS,
    )
    expect(spec.thresholdTokens).toBe(363_808)
    expect(spec.retainTokens).toBe(131_072)
  })
})
