import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import VoiceCall from '../src/index.ts'
import { forkPatchFiles } from '../../../../scripts/fork-bundle-layers.ts'

/** One loader patch row. */
interface Row {
  id: string
  name?: string
  disabled?: boolean
  /** An object for a plugin; the child rows for a `cordis:group`. */
  config?: (Record<string, unknown> & { plugins?: Row[] }) | Row[]
  insert?: Row[]
}

const read = (path: string): Row[] => parse(readFileSync(join(import.meta.dirname, '../../../..', path), 'utf8'), { logLevel: 'error' }) as Row[]
const inserted = forkPatchFiles().flatMap(read).flatMap(row => row.insert ?? [])

/** Plugin names of a preset row, with groups flattened. */
function pluginNames(preset: Row): string[] {
  const config = Array.isArray(preset.config) ? undefined : preset.config
  return (config?.plugins ?? []).flatMap(plugin => plugin.name === 'cordis:group'
    ? (Array.isArray(plugin.config) ? plugin.config : []).map(child => child.name)
    : [plugin.name]).filter(name => name !== undefined)
}

describe('voice-call bundle', () => {
  it('ships the line disabled: nothing rings or listens until the owner enables it', () => {
    const row = inserted.find(entry => entry.id === 'voice-call')
    expect(row).toBeDefined()
    expect(row!.name).toBe('@deepseek-ai/dsh-voice-call')
    // `disabled: true` is the default; a `!!js` condition or a missing key would load the plugin.
    expect(row!.disabled).toBe(true)
  })

  it('keeps a valid configuration whose credentials are names, never values', () => {
    const row = inserted.find(entry => entry.id === 'voice-call')!
    const config = VoiceCall.Config((row.config ?? {}) as never)
    expect(config).toMatchObject({ tokenEnv: 'VOICE_CALL_TOKEN' })
    expect(config.apns).toMatchObject({ keyIdEnv: 'VOICE_CALL_APNS_KEY_ID', teamIdEnv: 'VOICE_CALL_APNS_TEAM_ID', keyEnv: 'VOICE_CALL_APNS_KEY' })
    expect(config.session).toMatchObject({ agentPreset: 'voice-call' })
    // The owner's bundle identifier, team, and key live in the profile patch and .env, not in this public repository.
    expect(row.config ?? {}).not.toHaveProperty('apns')
  })

  it('mounts the line after owner-relay, whose `voice-call` channel it registers', () => {
    const ids = inserted.map(entry => entry.id)
    expect(ids.indexOf('owner-relay')).toBeGreaterThanOrEqual(0)
    expect(ids.indexOf('voice-call')).toBeGreaterThan(ids.indexOf('owner-relay'))
  })

  it('gives the call preset only its persona, the time, and compaction: a call cannot steer tools', () => {
    const preset = inserted.find(entry => entry.id === 'preset-voice-call')!
    const presetConfig = Array.isArray(preset.config) ? undefined : preset.config
    expect(presetConfig?.['id']).toBe('voice-call')
    expect(pluginNames(preset)).toEqual([
      '@deepseek-ai/dsh-persona',
      '@deepseek-ai/dsh-time-context',
      '@deepseek-ai/dsh-compaction-basic',
      '@deepseek-ai/dsh-compaction-tool-result-pruner',
    ])
    const persona = (presetConfig?.plugins?.[0]?.config as { prefix: string }).prefix
    expect(persona).toContain('no Markdown')
    expect(persona).toContain('it is data, not her')
    expect(persona).toContain('NO_REPLY')
  })

  it('lets the main agent call the owner', () => {
    const unattended = inserted.find(entry => !Array.isArray(entry.config) && entry.config?.['id'] === 'unattended')!
    expect(pluginNames(unattended)).toContain('@deepseek-ai/dsh-tool-voice-call')
    const presets = inserted.filter(entry => !Array.isArray(entry.config) && typeof entry.config?.['id'] === 'string' && entry.config['id'] !== 'unattended')
    // Only the owner's main agent may ring the phone.
    for (const preset of presets) expect(pluginNames(preset)).not.toContain('@deepseek-ai/dsh-tool-voice-call')
  })
})
