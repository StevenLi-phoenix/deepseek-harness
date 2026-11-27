import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { forkBundleLayers } from '../../../../scripts/fork-bundle-layers.ts'

const ROOT = join(import.meta.dirname, '../../../..')

interface Row {
  id: string
  name?: string
  insert?: Row[]
  config?: { id?: string; plugins?: Row[] }
  [key: string]: unknown
}

const entries = (file: string): Row[] => parse(readFileSync(join(ROOT, file), 'utf8'), { logLevel: 'error' }) as Row[]

/**
 * Which bundle holds which root row: the event skeleton keeps the service itself, and every feature
 * owns the rows it mounts. Moving a row between bundles is a composition change; this table makes
 * that deliberate instead of accidental.
 */
const ROW_OWNER: Record<string, string> = {
  'logger-console': 'event',
  'webhook-runtime': 'event',
  'owner-relay': 'event',
  'time-gap': 'event',
  'notify-learning': 'event',
  'event-bus': 'event',
  'event-ingest': 'event',
  'plugin-config': 'event',
  'event-console': 'event',
  'preset-notify': 'event',
  'preset-unattended': 'event',
  'preset-job-apply': 'event',
  'preset-job-inbox': 'event',
  'preset-job-lead': 'event',
  'webhook-github': 'github',
  'github-sensor': 'github',
  'headless-browser': 'headless-browser',
  'provider-balance': 'provider-balance',
  'subagent-activity': 'subagent-activity',
  'sysmon': 'sysmon',
  'owner-memory-admin': 'memory',
  'owner-memory-settings': 'memory',
  'presence': 'presence',
  'wechat-settings': 'wechat',
  'wechat': 'wechat',
  'cc-admin': 'cc-admin',
  'voice': 'voice',
  'bili': 'bili',
  'preset-bili': 'bili',
  'preset-up': 'bili',
  'qq': 'qq',
  'qq-login': 'qq',
  'preset-qq-digest': 'qq',
  'preset-qq-main': 'qq',
  'courses': 'courses',
  'courses-settings': 'courses',
  'gmail': 'gmail',
  'gmail-settings': 'gmail',
  'qqbot': 'qqbot',
  'preset-qqbot': 'qqbot',
  'integrity-watch': 'integrity',
  'content-guard': 'guard',
  'content-guard-settings': 'guard',
  'speaking-style': 'style',
  'speaking-style-settings': 'style',
}

/** The order the profile mounts the layers in, after the skeleton. */
const FEATURE_ORDER = [
  'github', 'headless-browser', 'provider-balance', 'subagent-activity', 'sysmon', 'memory', 'presence',
  'wechat', 'cc-admin', 'voice', 'bili', 'qq', 'courses', 'gmail', 'qqbot', 'integrity', 'guard', 'style',
]

describe('fork bundle layers', () => {
  it('mounts every fork bundle after the event skeleton, in the documented order', () => {
    const layers = forkBundleLayers()
    expect(layers[0]).toMatchObject({ name: '@deepseek-ai/dsh-event-bundle', dir: 'event' })
    expect(layers.slice(1).map(layer => layer.dir)).toEqual(FEATURE_ORDER)
  })

  it('names each bundle after its directory and points at the patch file it mounts', () => {
    for (const layer of forkBundleLayers()) {
      const manifest = JSON.parse(readFileSync(join(ROOT, `fork/bundles/${layer.dir}/package.json`), 'utf8')) as {
        name: string
        private?: boolean
        dsh?: { bundle?: { patch?: string[] } }
      }
      // A feature bundle is `@deepseek-ai/<feature>`; the skeleton keeps the name it shipped with.
      expect(manifest.name, layer.dir).toBe(layer.dir === 'event' ? '@deepseek-ai/dsh-event-bundle' : `@deepseek-ai/${layer.dir}`)
      expect(manifest.dsh?.bundle?.patch, layer.dir).toEqual(['./cordis.patch.yml'])
      expect(manifest.private, layer.dir).toBe(true)
    }
  })

  it('keeps every root row in exactly one bundle, the one this table names', () => {
    const owners = new Map<string, string[]>()
    for (const layer of forkBundleLayers()) {
      for (const entry of entries(layer.file)) {
        for (const row of entry.insert ?? []) owners.set(row.id, [...owners.get(row.id) ?? [], layer.dir])
      }
    }
    for (const [id, owner] of Object.entries(ROW_OWNER)) expect(owners.get(id), id).toEqual([owner])
    expect([...owners.keys()].sort()).toEqual(Object.keys(ROW_OWNER).sort())
  })

  it('keeps the skeleton free of feature rows and the root overrides in the event bundle only', () => {
    const overrides = forkBundleLayers()
      .flatMap(layer => entries(layer.file).filter(entry => entry.insert === undefined).map(() => layer.dir))
    // Every bare `{ id, disabled }` / `{ id, config }` row edits a row the base or Web bundles mount.
    expect(new Set(overrides)).toEqual(new Set(['event']))
    for (const layer of forkBundleLayers().slice(1)) {
      for (const entry of entries(layer.file)) {
        expect(entry.insert, layer.dir).toBeDefined()
        expect(entry.disabled, layer.dir).toBeUndefined()
      }
    }
  })

  it('ships a translated README pair for every bundle', () => {
    for (const layer of forkBundleLayers()) {
      for (const name of ['README.md', 'README.zh.md', 'README.i18n.yaml']) {
        expect(readFileSync(join(ROOT, `fork/bundles/${layer.dir}/${name}`), 'utf8').length, `${layer.dir}/${name}`).toBeGreaterThan(0)
      }
    }
  })
})
