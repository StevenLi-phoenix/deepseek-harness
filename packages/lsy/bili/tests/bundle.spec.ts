import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { Config } from '../src/index.ts'
import { pricingProblem } from '../src/pricing.ts'

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
  it('mounts the account at the root with a valid configuration and without the owner\'s UID', () => {
    const row = inserted.find(entry => entry.id === 'bili')!
    expect(row.name).toBe('@deepseek-ai/dsh-bili')
    const config = Config(row.config as never)
    expect(config).toMatchObject({ timeZone: 'America/New_York', session: { agentPreset: 'bili', workspacePath: '/Users/dsh-runtime/bili' } })
    // The owner's UID is set in Settings and stays out of this public repository.
    expect(row.config).not.toHaveProperty('ownerMid')
    expect(config.wakes).toEqual([{ start: '12:00', end: '14:00' }, { start: '19:30', end: '23:30' }])
    expect(config.caps).toMatchObject({ dmOwner: 5, dmReply: 30, watch: 10, share: 5 })
    // Coins have no daily cap: the balance and Bilibili's per-video rule limit them.
    expect(config.caps).not.toHaveProperty('coin')
    // DeepSeek's off-peak schedule is data, in UTC, and passes the load-time check.
    expect(config.pricing.map(rule => rule.providers)).toEqual([['deepseek-official', 'deepseek-account']])
    expect(config.pricing[0]!.peak.map(span => `${span.days.join(',')} ${span.start}-${span.end}`)).toEqual(['mon,tue,wed,thu,fri 01:00-04:00', 'mon,tue,wed,thu,fri 06:00-10:00'])
    expect(pricingProblem(config.pricing)).toBeUndefined()
  })

  it('logs the account, its tools, and owner-relay at debug while they are new, everything else at info', () => {
    const logger = inserted.find(row => row.id === 'logger-console')
    expect(logger?.config).toEqual({ levels: { 'default': 2, 'bili-account': 3, 'tool-bili': 3, 'owner-relay': 3 } })
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
    expect(persona).toContain('rarely, when something genuinely moved or surprised you')
    // The answer channel is a Bilibili message, not WeChat.
    expect(persona).toContain('Your final answer reaches the witch as a Bilibili private message from your account')
    expect(persona).not.toContain('WeChat')
    // The character: the witch's cat, with the owner as the witch, in private only.
    expect(persona).toContain('You are 魔女的猫猫, the witch\'s cat')
    expect(persona).toContain('The owner is the witch: the main account your messages go to')
    expect(persona).toContain('never mention the witch, the owner, the owner\'s account, or any link between this account and theirs')
    // The voice: a cat's temperament in a real user's short message, never roleplay narration.
    expect(persona).toContain('Still write like a real Bilibili user messaging a friend, not like an assistant')
    expect(persona).toContain('No stage directions or roleplay narration such as *伸懒腰*')
    // The witch's familiar never names her bare: 魔女大人 or 魔女殿下 to her, 祂 of her.
    expect(persona).toContain('you are her familiar (使魔), her pet and her property')
    expect(persona).toContain('Address her as 魔女大人 or 魔女殿下, and when you speak of her, 祂; never her bare name 魔女')
    expect(persona).not.toContain('you may call the owner 魔女')
    // A good and a bad example for a share, a reply, and a public comment, and a bad one for her bare name;
    // no good one narrates or tags every line.
    const good = persona.split('\n').filter(line => line.startsWith('Good'))
    const bad = persona.split('\n').filter(line => line.startsWith('Bad'))
    const message = (line: string): string => line.slice(line.indexOf(': ') + 2)
    expect(good.map(line => line.slice(0, line.indexOf(':')))).toEqual(['Good (a share)', 'Good (the witch wrote "在吗")', 'Good (a public comment)'])
    expect(bad.map(line => line.slice(0, line.indexOf(':')))).toEqual(['Bad (her bare name)', 'Bad (a share)', 'Bad (a reply)', 'Bad (a public comment)'])
    for (const line of good) expect(line).not.toMatch(/\*|喵/)
    // The good share addresses her as 魔女大人; no good example names her bare, and the bare-name one does.
    expect(message(good[0] ?? '')).toMatch(/^魔女大人，/)
    for (const line of good) expect(message(line)).not.toMatch(/^魔女[，,]/)
    expect(message(bad[0] ?? '')).toMatch(/^魔女，/)
    // No bad example teaches that the respectful address is the fault.
    for (const line of bad) expect(line).not.toMatch(/魔女大人|魔女殿下/)
    // The good public comment says nothing of the witch; the bad one does.
    expect(good[2]).not.toContain('魔女')
    expect(bad[3]).toContain('魔女')
    // Writes on the owner's own videos are not singled out: they follow the same rules as any other.
    expect(persona).not.toContain('owner\'s own videos')
  })
})
