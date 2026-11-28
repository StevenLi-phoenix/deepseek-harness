import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { estimateContent } from '../../../llm/token-meter/src/estimate.ts'
import { forkBundleLayers } from '../../../../scripts/fork-bundle-layers.ts'

/** One loader patch row, as the bundles write it. */
interface Row {
  id?: string
  config?: unknown
  insert?: Row[]
}

const read = (file: string): Row[] =>
  parse(readFileSync(join(import.meta.dirname, '../../../..', file), 'utf8'), { logLevel: 'error' }) as Row[]

/** Every row a patch mounts, through inserts, preset plugin lists and group rows. */
function* rowsOf(rows: readonly Row[]): Generator<Row> {
  for (const row of rows) {
    yield row
    if (row.insert !== undefined) yield* rowsOf(row.insert)
    const config = row.config
    if (Array.isArray(config)) yield* rowsOf(config as Row[])
    const plugins = (config as { plugins?: unknown } | undefined)?.plugins
    if (Array.isArray(plugins)) yield* rowsOf(plugins as Row[])
  }
}

const find = (rows: readonly Row[], id: string): Row => {
  const row = [...rowsOf(rows)].find(candidate => candidate.id === id)
  if (row === undefined) throw new Error(`no ${id} row`)
  return row
}

const eventBundle = (): Row[] => {
  const layer = forkBundleLayers().find(entry => entry.name === '@deepseek-ai/dsh-event-bundle')
  if (layer === undefined) throw new Error('the event bundle is not mounted by the profile')
  return read(layer.file)
}

describe('a job-apply worker reads every web_fetch window whole', () => {
  // Live find-simplify, 2026-11-28 06:12: each 200,000-character window spilled past the inline cap, the worker
  // cannot read the spill file, and about 150,000 characters of every window went unseen.
  it('keeps one window under the spill policy inline cap', () => {
    const tools = find(eventBundle(), 'preset-job-apply')
    const web = find([tools], 'tool-web').config as { fetchMaxOutputChars?: number }
    const spill = find(read('packages/bundle/base/cordis.patch.yml'), 'spill-policy').config as { maxInlineTokens: number }
    const window = web.fetchMaxOutputChars
    expect(window).toBeDefined()
    expect(estimateContent([{ type: 'text', text: 'x'.repeat(window ?? 0) }])).toBeLessThanOrEqual(spill.maxInlineTokens)
  })

  it('fetches the whole of an 850,000-character README for the windows to cover', () => {
    const provider = find(eventBundle(), 'web-fetch-http').config as { maxBodyChars?: number }
    expect(provider.maxBodyChars).toBeGreaterThanOrEqual(850_000)
  })
})
