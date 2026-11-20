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

/** The `compaction-basic` config the event bundle gives the unattended preset. */
function unattendedCompactionConfig(): Record<string, unknown> {
  const layer = forkBundleLayers().find(entry => entry.name === '@deepseek-ai/dsh-event-bundle')
  if (layer === undefined) throw new Error('the event bundle is not mounted by the profile')
  const preset = read(layer.file).flatMap(row => row.insert ?? []).find(row => row.id === 'preset-unattended')
  if (preset === undefined) throw new Error('the event bundle mounts no unattended preset')
  const plugins = (preset.config as { plugins?: Row[] }).plugins ?? []
  const group = plugins.find(row => row.id === 'compaction')
  if (group === undefined) throw new Error('the unattended preset mounts no compaction group')
  const basic = groupRows(group.config).find(row => row.id === 'compaction-basic')
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
