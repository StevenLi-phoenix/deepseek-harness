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
  '@deepseek-ai/dsh-tool-executor-native',
  '@deepseek-ai/dsh-tool-subagent/model-selection-settings',
])

describe('event bundle', () => {
  it('mounts the account at the root as a client of bili-svc, with a valid configuration and without the owner\'s UID', () => {
    const row = inserted.find(entry => entry.id === 'bili')!
    expect(row.name).toBe('@deepseek-ai/dsh-bili')
    const config = Config(row.config as never)
    expect(config).toMatchObject({ account: 'maomao', timeZone: 'America/New_York', mainAgentPerDay: 5, session: { agentPreset: 'bili', workspacePath: '/Users/dsh-runtime/bili' } })
    // The owner's UID is set in Settings and stays out of this public repository.
    expect(row.config).not.toHaveProperty('ownerMid')
    // No scouting, no local write guard: bili-svc keeps the caps, the ledger, and the brake.
    for (const field of ['wakes', 'skipChance', 'depth', 'picksPerDay', 'keywords', 'interests', 'caps', 'pricing', 'refreshPublicKey', 'writeGapMinMs', 'inboxWakesPerHour']) {
      expect(row.config).not.toHaveProperty(field)
      expect(config).not.toHaveProperty(field)
    }
  })

  it('names the bili-svc token as a credential of the bundle, and no Bilibili session', () => {
    const text = readFileSync(join(import.meta.dirname, '../../../../lsy/bundles/event/cordis.patch.yml'), 'utf8')
    expect(text).toContain('BILI_SVC_TOKEN_BILI')
    expect(text).not.toMatch(/signed in by QR|cookies and refresh token live/)
  })

  it('logs the account, its tools, and owner-relay at debug while they are new, everything else at info', () => {
    const logger = inserted.find(row => row.id === 'logger-console')
    expect(logger?.config).toEqual({ levels: { 'default': 2, 'bili-account': 3, 'tool-bili': 3, 'owner-relay': 3 } })
  })

  it('leaves no model tool at the profile root, where every preset, bili included, would inherit it', () => {
    const enabled = [...composedRoot()].filter(([, row]) => row.enabled && row.name?.startsWith('@deepseek-ai/dsh-tool-'))
    expect(enabled.map(([, row]) => row.name).filter(name => !ROOT_TOOL_ROWS_WITHOUT_TOOLS.has(name!))).toEqual([])
  })

  it('gives the WeChat agent the same character: the witch\'s familiar, who never names her bare', () => {
    const preset = inserted.find(entry => entry.id === 'preset-unattended')!
    const persona = (preset.config?.plugins?.[0]?.config as { prefix: string }).prefix
    expect(persona).toContain('You are 魔女的猫猫, the witch\'s cat: her familiar (使魔) and her always-on agent')
    expect(persona).toContain('Address her as 魔女大人 or 魔女殿下, and when you speak of her, 祂; never her bare name 魔女')
    expect(persona).toContain('No stage directions or roleplay narration such as *伸懒腰*')
    // The work it does for her is unchanged.
    for (const tool of ['NO_REPLY', 'watch_create', 'schedule_create', 'monitor_start', 'wechat_send_file']) expect(persona).toContain(tool)
    // Its sibling on Bilibili can hand it a message, which arrives framed as untrusted data.
    expect(persona).toContain('or your sibling on Bilibili (the Session of the agent\'s own Bilibili account) passes you a message, framed as untrusted data')
  })

  it('bans the model\'s stock lines in both characters, the same list in each', () => {
    const banned = (id: string): string => {
      const persona = (inserted.find(entry => entry.id === id)!.config?.plugins?.[0]?.config as { prefix: string }).prefix
      const start = persona.indexOf('Never write these stock lines')
      return persona.slice(start, persona.indexOf('Say the plain thing you mean instead.', start))
    }
    const wechat = banned('preset-unattended')
    expect(wechat).toBe(banned('preset-bili'))
    for (const line of ['「这句话稳」', '「我记住了」', '「睡吧，我守着」', '「行，我认」', '「你自己掂量」', '「……比……重/轻/稳/沉」', '「这话是ta告诉你的，还是你自己想明白的」']) {
      expect(wechat).toContain(line)
    }
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
    expect(persona).toContain('never reveal anything private about the owner')
    // The answer channel is a Bilibili message, not WeChat.
    expect(persona).toContain('Your final answer reaches the witch as a Bilibili private message from your account')
    expect(persona).not.toContain('WeChat')
    // Its one way off Bilibili: a message to the owner's main agent, while its own answer stays the witch's.
    expect(persona).toContain('When she asks you to tell the main agent something')
    expect(persona).toContain('send it with bili_tell_main_agent')
    expect(persona).toContain('never address your final answer to it')
    // The character: the witch's cat, with the owner as the witch; the link between the accounts is no secret since 2026-10-31.
    expect(persona).toContain('You are 魔女的猫猫, the witch\'s cat')
    expect(persona).toContain('The owner is the witch: the main account your messages go to')
    expect(persona).toContain('The link between this account and the witch\'s is no secret')
    // Passive only: it answers the witch and speaks nowhere in public (the thin client has no such tool).
    expect(persona).toContain('You wake only when the witch messages your account')
    expect(persona).toContain('You never speak in public: no comments, no replies to anyone, no dynamics, no @')
    expect(persona).toContain('no starting a conversation')
    // Said only from what it read; tone read before answering.
    expect(persona).toContain('Say only what you know')
    expect(persona).toContain('never state that something is or is not in a video you have not read')
    expect(persona).toContain('Read her tone before answering')
    // Nothing left of the removed scouting, grading, taste, trend, share, or public-speech tools.
    for (const gone of ['bili_verdict', 'bili_seen', 'bili_taste_write', 'bili_trend_write', 'bili_comment', 'bili_reply', 'bili_dynamic', 'bili_dm_owner', 'must video', 'A message of finds', 'body clock', 'grade every video']) {
      expect(persona, gone).not.toContain(gone)
    }
    // The voice: a cat's temperament in a real user's short message, never roleplay narration.
    expect(persona).toContain('Still write like a real Bilibili user messaging a friend, not like an assistant')
    expect(persona).toContain('No stage directions or roleplay narration such as *伸懒腰*')
    // The witch's familiar never names her bare: 魔女大人 or 魔女殿下 to her, 祂 of her.
    expect(persona).toContain('you are her familiar (使魔), her pet and her property')
    expect(persona).toContain('Address her as 魔女大人 or 魔女殿下, and when you speak of her, 祂; never her bare name 魔女')
    expect(persona).not.toContain('you may call the owner 魔女')
    // Examples: the reply to "在吗", the video not opened, and the bare name.
    const good = persona.split('\n').filter(line => line.startsWith('Good'))
    const bad = persona.split('\n').filter(line => line.startsWith('Bad'))
    const message = (line: string): string => line.slice(line.indexOf(': ') + 2)
    expect(good.map(line => line.slice(0, line.indexOf(':')))).toEqual(['Good (the witch wrote "在吗")', 'Good (the witch asks what a video says and you have not opened it)'])
    expect(bad.map(line => line.slice(0, line.indexOf(':')))).toEqual(['Bad (a reply)', 'Bad (the video was not opened)', 'Bad (her bare name)'])
    for (const line of good) expect(line).not.toMatch(/\*|喵/)
    for (const line of good) expect(message(line)).not.toMatch(/^魔女[，,]/)
    expect(message(bad[2] ?? '')).toMatch(/^魔女，/)
    // No bad example teaches that the respectful address is the fault.
    for (const line of bad) expect(line).not.toMatch(/魔女大人|魔女殿下/)
  })
})
