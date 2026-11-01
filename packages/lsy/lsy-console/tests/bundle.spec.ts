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

const ROOT = join(import.meta.dirname, '../../../..')
const read = (path: string): Row[] => parse(readFileSync(join(ROOT, path), 'utf8'), { logLevel: 'error' }) as Row[]
const bundle = read('lsy/bundles/event/cordis.patch.yml')
const inserted = bundle.flatMap(row => row.insert ?? [])

/** Every plugin name inside the presets, however deeply grouped. */
function presetNames(row: Row): string[] {
  return (row.config?.plugins ?? []).flatMap(plugin => plugin.name === 'cordis:group'
    ? (plugin.config as unknown as Row[]).map(child => child.name ?? '')
    : [plugin.name ?? ''])
}

describe('event bundle', () => {
  it('mounts the Settings console and the Claude Code service at the root, where the Host routes and root services live', () => {
    for (const [id, name] of [['lsy-console', '@deepseek-ai/dsh-lsy-console'], ['lsy-cc-admin', '@deepseek-ai/dsh-lsy-cc-admin']]) {
      const row = inserted.find(entry => entry.id === id)
      expect(row, id).toBeDefined()
      expect(row!.name).toBe(name)
      expect(row).not.toHaveProperty('disabled')
    }
  })

  it('mounts neither inside a preset: a preset mount cannot publish a root service and nothing outside it can reach its tools', () => {
    const inPresets = inserted.filter(entry => entry.id.startsWith('preset-')).flatMap(presetNames)
    expect(inPresets).not.toContain('@deepseek-ai/dsh-lsy-console')
    expect(inPresets).not.toContain('@deepseek-ai/dsh-lsy-cc-admin')
    expect(inPresets).toContain('@deepseek-ai/dsh-lsy-cc-bridge')
  })

  it('works with its defaults, which probe only this Mac\'s loopback services', () => {
    const row = inserted.find(entry => entry.id === 'lsy-console')!
    expect(row.config ?? {}).toEqual({})
    const config = Config({} as never)
    expect(config.bili.url).toBe('http://127.0.0.1:8097')
    expect(config.ams.url).toBe('http://127.0.0.1:18090')
    expect(config.subscriptions).toMatchObject({ agentPreset: 'unattended', workspacePath: '/Users/dsh-runtime/work' })
  })

  it('is part of the setup script\'s plugin links and its self-check', () => {
    const setup = readFileSync(join(ROOT, 'lsy/deploy/setup-profile.sh'), 'utf8')
    const check = readFileSync(join(ROOT, 'lsy/deploy/check-setup-profile.sh'), 'utf8')
    expect(setup).toContain('\'@deepseek-ai/dsh-lsy-console\'')
    expect(setup).toContain('\'@deepseek-ai/dsh-lsy-cc-admin\'')
    expect(check).toContain('@deepseek-ai/dsh-lsy-console')
    expect(check).toContain('^- id: lsy-cc-admin$')
  })
})
