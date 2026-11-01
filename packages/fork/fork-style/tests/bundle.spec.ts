import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { Config } from '../src/index.ts'

/** One loader patch row. */
interface Row {
  id: string
  name?: string
  config?: Record<string, unknown> & { id?: string; plugins?: Row[] }
  insert?: Row[]
}

const read = (path: string): Row[] => parse(readFileSync(join(import.meta.dirname, '../../../..', path), 'utf8'), { logLevel: 'error' }) as Row[]
const inserted = read('fork/bundles/event/cordis.patch.yml').flatMap(row => row.insert ?? [])
const presets = inserted.filter(row => row.name === '@deepseek-ai/dsh-agent-preset')
const styleRows = (rows: readonly Row[]): Row[] => rows.filter(row => row.name === '@deepseek-ai/dsh-fork-style')

describe('event bundle', () => {
  it('collects at the root with the defaults: on, review optional, the up token, the owner\'s account 猫灯', () => {
    const [root] = styleRows(inserted)
    expect(root?.id).toBe('fork-style')
    const config = Config((root?.config ?? {}) as never)
    expect(config).toMatchObject({ mode: 'collect', enabled: true, review: 'optional', maxActive: 60, maxOwner: 20, maxChars: 30, presets: ['unattended'] })
    expect(config.bili).toMatchObject({ tokenEnv: 'BILI_SVC_TOKEN_UP', ownerAccount: 'maodeng' })
    // This public repository carries no identity marker of the owner; the profile patch adds them.
    expect(config.identityMarkers).toEqual([])
  })

  it('shows the block in the unattended preset only', () => {
    const mounted = presets.map(preset => [preset.config?.id, styleRows(preset.config?.plugins ?? []).map(row => row.config?.['mode'])])
    expect(mounted.filter(([, modes]) => (modes as unknown[]).length > 0)).toEqual([['unattended', ['prompt']]])
  })
})
