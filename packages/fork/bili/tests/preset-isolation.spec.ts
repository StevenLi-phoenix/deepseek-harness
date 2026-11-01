import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

/**
 * Memory and PII stay per channel: what the agent knows from WeChat (the owner memory, the chat Session,
 * the owner's accounts, people) is not visible to the Bilibili and QQ personas. Only a personality and style
 * layer may be shared between channels. These tests read the event bundle's composition, so a new plugin in
 * one of the other presets fails here until someone decides it is safe.
 */

/** One loader patch row; a `cordis:group` carries its rows as an array in `config`. */
interface Row {
  id: string
  name?: string
  config?: Record<string, unknown> | Row[]
  insert?: Row[]
}

const ROOT = join(import.meta.dirname, '../../../..')
const bundle = parse(readFileSync(join(ROOT, 'fork/bundles/event/cordis.patch.yml'), 'utf8'), { logLevel: 'error' }) as Row[]
const rootRows = bundle.flatMap(row => row.insert ?? [])
const presets = new Map(rootRows.filter(row => row.id.startsWith('preset-')).map(row => [row.id.slice('preset-'.length), row]))

/** Every plugin row of a preset, groups flattened. */
function pluginsOf(preset: Row): Row[] {
  const config = preset.config as { plugins?: Row[] }
  const rows: Row[] = []
  const walk = (list: Row[]): void => {
    for (const row of list) {
      rows.push(row)
      if (Array.isArray(row.config)) walk(row.config)
    }
  }
  walk(config.plugins ?? [])
  return rows
}

const names = (preset: string): string[] => pluginsOf(presets.get(preset)!).map(row => row.name ?? '')
const fieldsOf = (row: Row): Record<string, unknown> => (Array.isArray(row.config) ? {} : row.config ?? {})

/** The only preset that faces the owner on WeChat: the chat Session, watches, reminders, and the owner memory. */
const WECHAT_PRESET = 'unattended'
/** Presets that face Bilibili or QQ: strangers' text goes in, the persona's answer comes out. */
const OUTSIDE_PRESETS = ['bili', 'up', 'qqbot', 'qq-digest'] as const

/** Plugins that carry the owner's memory or reach the WeChat side, and why none may run in an outside preset. */
const WECHAT_SIDE: Record<string, string> = {
  '@deepseek-ai/dsh-fork-memory': 'injects the owner memory block and registers memory_search/save/forget (feedbackScope mode is the one exception, below)',
  '@deepseek-ai/dsh-fork-tool-wechat': 'sends files to the owner on WeChat',
  '@deepseek-ai/dsh-fork-cc-bridge': 'talks to Claude Code sessions and the WeChat chat Session on the owner\'s behalf',
  '@deepseek-ai/dsh-fork-tool-watch': 'creates watches that report into the WeChat chat Session',
  '@deepseek-ai/dsh-fork-tool-monitor': 'monitors whose output returns to a Session with the owner\'s context',
  '@deepseek-ai/dsh-fork-tool-voice': 'speaks to the owner through the WeChat notifier',
  '@deepseek-ai/dsh-fork-tool-courses': 'reads and writes the owner\'s course records (deadlines, progress, memos)',
  '@deepseek-ai/dsh-fork-taint': 'only meaningful beside the memory and bridge tools',
  '@deepseek-ai/dsh-tool-schedule': 'reminders that start turns in the owner\'s Sessions',
  '@deepseek-ai/dsh-agent-instructions': 'reads the workspace instruction files, which hold what the owner told the main agent',
}

/** DSH's speaking style (persona card, memes, tone): the one layer every channel shares. */
const STYLE = '@deepseek-ai/dsh-fork-style'

/** Everything an outside preset may mount today. A new row must be added here on purpose. */
const ALLOWED: Record<(typeof OUTSIDE_PRESETS)[number], string[]> = {
  'bili': [
    '@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-time-context', '@deepseek-ai/dsh-tool-bili', STYLE,
    'cordis:group', '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-compaction-tool-result-pruner',
  ],
  // `fork-feedback` below is the one memory-package row an outside preset may have: see the dedicated test.
  // The group rows and compaction plugins are the persistent Session's compaction mount, as in `qqbot`.
  'up': [
    '@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-time-context', '@deepseek-ai/dsh-fork-tool-up', '@deepseek-ai/dsh-fork-memory', STYLE,
    'cordis:group', '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-compaction-tool-result-pruner',
  ],
  'qqbot': [
    '@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-time-context', STYLE,
    'cordis:group', '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-compaction-tool-result-pruner',
  ],
  // fork-tool-qq reads only what the QQ observer recorded; it carries no owner memory and reaches no WeChat side.
  'qq-digest': ['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-fork-tool-qq', STYLE, 'cordis:group', '@deepseek-ai/dsh-compaction-basic'],
}

describe('channel isolation of the event bundle\'s presets', () => {
  it('composes the presets this test knows, so a new one is looked at', () => {
    expect([...presets.keys()].toSorted()).toEqual([WECHAT_PRESET, ...OUTSIDE_PRESETS].toSorted())
  })

  it.each(OUTSIDE_PRESETS)('the %s preset mounts nothing that carries the owner memory or reaches the WeChat side', (preset) => {
    const mounted = pluginsOf(presets.get(preset)!).filter(row => row.name !== undefined && row.name in WECHAT_SIDE)
    // `up` mounts the memory package once, in feedback mode; every other row here is a failure with its reason.
    const offenders = mounted
      .filter(row => !(preset === 'up' && row.id === 'fork-feedback'))
      .map(row => `${row.name!}: ${WECHAT_SIDE[row.name!]!}`)
    expect(offenders).toEqual([])
  })

  it.each(OUTSIDE_PRESETS)('the %s preset mounts only the plugins reviewed for it', (preset) => {
    const unreviewed = names(preset).filter(name => !ALLOWED[preset].includes(name))
    // No shell, file, web, job, or subagent tool means no way to call the Host's own HTTP routes from the model.
    expect(unreviewed).toEqual([])
  })

  it('mounts the owner memory in the WeChat preset only, with its tools and taint rules beside it', () => {
    const wechat = pluginsOf(presets.get(WECHAT_PRESET)!)
    const memory = wechat.filter(row => row.name === '@deepseek-ai/dsh-fork-memory')
    expect(memory.map(row => row.id)).toEqual(['fork-memory'])
    expect(fieldsOf(memory[0]!)).not.toHaveProperty('feedbackScope')
    for (const name of ['@deepseek-ai/dsh-fork-taint', '@deepseek-ai/dsh-fork-tool-wechat']) {
      expect(wechat.map(row => row.name)).toContain(name)
    }
  })

  it('lets the up preset read only the owner\'s keep/delete verdicts on its own replies, and nothing of the memory', () => {
    // Why this exception exists: the verdicts are a style layer (tone to match or avoid), written by the owner's own
    // service through `memory-admin feedback add`, scoped to `up`. `feedbackScope` mode registers no memory tool and
    // does not read memory.jsonl (fork-memory's feedback spec asserts both), so no WeChat-side fact reaches the persona.
    const memory = pluginsOf(presets.get('up')!).filter(row => row.name === '@deepseek-ai/dsh-fork-memory')
    expect(memory.map(row => row.id)).toEqual(['fork-feedback'])
    expect(fieldsOf(memory[0]!)).toEqual({ feedbackScope: 'up' })
    // No other outside preset reads even the verdicts.
    for (const preset of ['bili', 'qqbot', 'qq-digest'] as const) expect(names(preset)).not.toContain('@deepseek-ai/dsh-fork-memory')
  })

  it('lets the time check reach every preset from the root because it carries only times and fixed wording', () => {
    expect(rootRows.map(row => row.name)).toContain('@deepseek-ai/dsh-fork-time-gap')
    for (const preset of [WECHAT_PRESET, ...OUTSIDE_PRESETS]) expect(names(preset)).not.toContain('@deepseek-ai/dsh-fork-time-gap')
    // It reads Session times and message sources, never the owner memory or the WeChat side. fork-taint is a dependency
    // only for its request-id prefix (a message another Session passed on); the taint plugin itself is not mounted.
    const manifest = JSON.parse(readFileSync(join(ROOT, 'packages/fork/fork-time-gap/package.json'), 'utf8')) as { peerDependencies: Record<string, string>; dependencies: Record<string, string> }
    const dependencies = [...Object.keys(manifest.peerDependencies), ...Object.keys(manifest.dependencies)]
    expect(dependencies.filter(name => name !== '@deepseek-ai/dsh-fork-taint' && (name in WECHAT_SIDE || name === '@deepseek-ai/dsh-fork-wechat'))).toEqual([])
  })

  it('mounts the course tools in the WeChat preset only; the root course service registers no tool', () => {
    expect(names(WECHAT_PRESET).filter(name => name === '@deepseek-ai/dsh-fork-tool-courses')).toHaveLength(1)
    expect(rootRows.map(row => row.name)).not.toContain('@deepseek-ai/dsh-fork-tool-courses')
    expect(rootRows.map(row => row.name)).toEqual(expect.arrayContaining(['@deepseek-ai/dsh-fork-courses', '@deepseek-ai/dsh-fork-courses-settings']))
    const source = readFileSync(join(ROOT, 'packages/fork/fork-courses/src/index.ts'), 'utf8')
    expect(source).not.toContain('tools.register')
  })

  it('keeps the owner memory out of every root row, since root rows reach every preset', () => {
    expect(rootRows.filter(row => !row.id.startsWith('preset-')).map(row => row.name)).not.toContain('@deepseek-ai/dsh-fork-memory')
    expect(rootRows.filter(row => !row.id.startsWith('preset-')).map(row => row.name)).not.toContain('@deepseek-ai/dsh-fork-tool-wechat')
  })
})

describe('the qq-digest preset\'s tools', () => {
  const toolQq = readFileSync(join(ROOT, 'packages/fork/fork-tool-qq/src/index.ts'), 'utf8')
  const digestRows = (): Row[] => pluginsOf(presets.get('qq-digest')!)

  it('runs fork-tool-qq in digest mode, whose only tools are qq_digest_write and qq_group_note', () => {
    const rows = digestRows().filter(row => row.name === '@deepseek-ai/dsh-fork-tool-qq')
    expect(rows.map(row => fieldsOf(row))).toEqual([{ mode: 'digest' }])
    // The digest-mode registration function names exactly the two write tools (no read, search, or forget tool).
    const digestBody = toolQq.slice(toolQq.indexOf('function registerDigestTools'), toolQq.indexOf('/** Folder in the Session\'s workspace'))
    expect([...digestBody.matchAll(/name: '(\w+)'/gu)].map(match => match[1])).toEqual(['qq_digest_write', 'qq_group_note'])
  })

  it('mounts the read tools, qq_image among them, only in the unattended preset, and registers qq_image only in read mode', () => {
    const readers = [...presets].filter(([, preset]) => pluginsOf(preset).some(row => row.name === '@deepseek-ai/dsh-fork-tool-qq' && fieldsOf(row)['mode'] !== 'digest'))
    expect(readers.map(([id]) => id)).toEqual(['unattended'])
    // The picture tool is registered after the digest branch has returned, so a digest-mode mount never gets it.
    const apply = toolQq.slice(toolQq.indexOf('export function apply'), toolQq.indexOf('/** A model-supplied argument as text'))
    expect(apply.indexOf("config.mode === 'digest'")).toBeGreaterThan(-1)
    expect(apply.indexOf('registerImageTool(scoped, observer)')).toBeGreaterThan(apply.indexOf('registerDigestTools(scoped, observer)'))
    expect(toolQq).toContain("name: 'qq_image'")
    expect(toolQq.match(/name: 'qq_image'/g)).toHaveLength(1)
  })

  it('may add style_note only through fork-style, and only that row', () => {
    // The row's exact tools are pinned in "the speaking-style tools by preset" below.
    expect(digestRows().filter(row => row.name === '@deepseek-ai/dsh-fork-style').map(row => row.id)).toEqual(['fork-style-prompt'])
  })

  it('puts the long-lived Session\'s compaction in an isolated group of compaction rows only', () => {
    const group = digestRows().find(row => row.name === 'cordis:group')
    expect(group).toBeDefined()
    expect(Array.isArray(group!.config)).toBe(true)
    const inner = (group!.config as Row[]).map(row => row.name)
    expect(inner.every(name => name?.startsWith('@deepseek-ai/dsh-compaction'))).toBe(true)
    expect((group as unknown as { isolate?: { compaction?: boolean } }).isolate).toEqual({ compaction: true })
  })

  it.each(['qqbot', 'qq-digest'] as const)('never gives the %s preset the owner memory or its tools, in any row or group', (preset) => {
    const mounted = names(preset)
    for (const forbidden of ['@deepseek-ai/dsh-fork-memory', '@deepseek-ai/dsh-fork-taint', '@deepseek-ai/dsh-fork-tool-wechat']) {
      expect(mounted).not.toContain(forbidden)
    }
  })
})

describe('the speaking-style tools by preset', () => {
  /** The tools a preset's `fork-style-prompt` row mounts (the plugin's default is `meme_lookup` alone). */
  const styleTools = (preset: string): string[] => {
    const rows = pluginsOf(presets.get(preset)!).filter(row => row.name === STYLE)
    expect(rows.map(row => row.id)).toEqual(['fork-style-prompt'])
    expect(fieldsOf(rows[0]!)['mode']).toBe('prompt')
    return (fieldsOf(rows[0]!)['tools'] as string[] | undefined) ?? ['meme_lookup']
  }
  const MEMORY_TOOLS = ['memory_search', 'memory_save', 'memory_forget']

  it('gives the unattended preset meme_lookup, style_note, and persona_update, beside the owner memory', () => {
    expect(styleTools(WECHAT_PRESET)).toEqual(['meme_lookup', 'style_note', 'persona_update'])
  })

  it('gives the outside presets the style tools they need and never an owner-memory tool', () => {
    expect(Object.fromEntries(OUTSIDE_PRESETS.map(preset => [preset, styleTools(preset)]))).toEqual({
      'bili': ['meme_lookup'],
      'up': ['meme_lookup', 'style_note', 'persona_update'],
      'qqbot': ['meme_lookup'],
      'qq-digest': ['style_note', 'persona_update'],
    })
    for (const preset of OUTSIDE_PRESETS) expect(styleTools(preset).filter(tool => MEMORY_TOOLS.includes(tool))).toEqual([])
  })

  it('mounts persona_update in qq-digest, up, and unattended only', () => {
    const withCard = [WECHAT_PRESET, ...OUTSIDE_PRESETS].filter(preset => styleTools(preset).includes('persona_update'))
    expect(withCard.toSorted()).toEqual(['qq-digest', 'unattended', 'up'])
  })

  it('collects at the root once, so the stores and the guard check have one owner', () => {
    const roots = rootRows.filter(row => row.name === STYLE)
    expect(roots.map(row => row.id)).toEqual(['fork-style'])
    expect(fieldsOf(roots[0]!)['mode']).toBeUndefined()
  })
})

describe('/api/fork.memory is not reachable from any preset\'s tools', () => {
  const settings = readFileSync(join(ROOT, 'packages/fork/fork-memory/src/settings.ts'), 'utf8')

  it('is a root row beside the page, not part of any preset', () => {
    const row = rootRows.find(entry => entry.name === '@deepseek-ai/dsh-fork-memory/settings')
    expect(row?.id).toBe('fork-memory-settings')
    for (const preset of presets.keys()) expect(names(preset)).not.toContain('@deepseek-ai/dsh-fork-memory/settings')
  })

  it('needs only the connection service and registers no tool, so no model can call it', () => {
    expect(settings).toMatch(/export const inject = \['connection'\]/u)
    expect(settings).not.toMatch(/defineTool|\.tools\b|tools\.register/u)
  })

  it('is answered only to the owner\'s signed-in Web UI (the connection refuses every other principal)', () => {
    // The contract is the connection's: "Only owner Peers reach an exact route; the shared handler answers 403 for
    // every other principal" (ConnectionFetchRoute in packages/client/connection/src/rpc.ts). The outside presets also
    // have no shell, file, web, or job tool to send a request with (see the reviewed lists above).
    const contract = readFileSync(join(ROOT, 'packages/client/connection/src/rpc.ts'), 'utf8')
    expect(contract).toContain('Only owner Peers reach an exact route')
  })
})
