import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { Config } from '../src/index.ts'
import type { Config as StyleConfig } from '../src/index.ts'

/** One loader patch row. */
interface Row {
  id: string
  name?: string
  config?: Record<string, unknown> & { id?: string; plugins?: Row[] }
  insert?: Row[]
}

const read = (path: string): Row[] => parse(readFileSync(join(import.meta.dirname, '../../../..', path), 'utf8'), { logLevel: 'error' }) as Row[]
const inserted = read('lsy/bundles/event/cordis.patch.yml').flatMap(row => row.insert ?? [])
const presets = inserted.filter(row => row.name === '@deepseek-ai/dsh-agent-preset')
const STYLE = '@deepseek-ai/dsh-lsy-style'
const MEMORY = '@deepseek-ai/dsh-lsy-memory'
/** Every row of a preset, groups flattened. */
const rowsOf = (rows: readonly Row[]): Row[] =>
  rows.flatMap(row => [row, ...rowsOf(Array.isArray(row.config) ? row.config as Row[] : row.config?.plugins ?? [])])
const pluginsOf = (id: string): Row[] => rowsOf(presets.find(preset => preset.config?.id === id)?.config?.plugins ?? [])

describe('event bundle', () => {
  it('collects at the root with the defaults: on, review optional, the up token, the owner\'s account 猫灯, and the four presets', () => {
    const roots = inserted.filter(row => row.name === STYLE)
    expect(roots.map(row => row.id)).toEqual(['lsy-style'])
    const config = Config((roots[0]?.config ?? {}) as never)
    expect(config).toMatchObject({ mode: 'collect', enabled: true, review: 'optional', maxActive: 60, maxOwner: 20, maxChars: 30 })
    expect(config.presets).toEqual(['unattended', 'up', 'bili', 'qqbot'])
    expect(config.answerPresets).toEqual(['unattended'])
    expect(config.tone).toEqual({ enabled: true, maxShown: 8, maxChars: 600 })
    expect(config.memes).toMatchObject({ enabled: true, maxIndex: 40, expireDays: 14 })
    expect(config.traits).toEqual({ enabled: true, max: 10 })
    expect(config.persona).toMatchObject({ enabled: true, maxChars: 600, minIntervalHours: 6 })
    expect(config.notes.sources).toEqual({ 'qq-digest': 'qq', 'up': 'bili', 'unattended': 'web' })
    expect(config.hotwatch).toMatchObject({ enabled: true, url: 'http://100.97.163.18:8000', maxIndex: 15, ttlMs: 3_600_000 })
    expect(config.bili).toMatchObject({ tokenEnv: 'BILI_SVC_TOKEN_UP', ownerAccount: 'maodeng' })
    // This public repository carries no identity marker of the owner; the profile patch adds them.
    expect(config.identityMarkers).toEqual([])
  })

  it('mounts the Settings section at the root', () => {
    expect(inserted.find(row => row.id === 'lsy-style-settings')?.name).toBe('@deepseek-ai/dsh-lsy-style-settings')
  })

  it('shows the block in exactly the presets the root row lists, and mounts the writers only where the groups are read', () => {
    const mounted: Record<string, StyleConfig> = Object.fromEntries(presets.flatMap((preset) => {
      const rows = pluginsOf(preset.config?.id ?? '').filter(row => row.name === STYLE)
      return rows.map((row): [string, StyleConfig] => [preset.config?.id ?? '', Config({ ...row.config } as never)])
    }))
    const shape = (config: StyleConfig): unknown => ({ block: config.block, tools: config.tools })
    expect(Object.fromEntries(Object.entries(mounted).map(([id, config]) => [id, shape(config)]))).toEqual({
      'unattended': { block: true, tools: ['meme_lookup', 'style_note', 'persona_update'] },
      'up': { block: true, tools: ['meme_lookup', 'style_note', 'persona_update'] },
      'bili': { block: true, tools: ['meme_lookup'] },
      'qqbot': { block: true, tools: ['meme_lookup'] },
      'qq-digest': { block: false, tools: ['style_note', 'persona_update'] },
    })
    expect(Object.values(mounted).every(config => config.mode === 'prompt')).toBe(true)
  })

  it('keeps owner memory out of the presets that share the persona block: style only, nothing from WeChat', () => {
    for (const id of ['bili', 'up', 'qqbot', 'qq-digest']) {
      const memory = pluginsOf(id).filter(row => row.name === MEMORY)
      // The up preset's only memory row is the owner's keep/delete verdicts on its own replies (feedback mode).
      expect(memory.every(row => row.config?.['feedbackScope'] !== undefined)).toBe(true)
    }
    expect(pluginsOf('unattended').filter(row => row.name === MEMORY && row.config?.['feedbackScope'] === undefined)).toHaveLength(1)
  })
})
