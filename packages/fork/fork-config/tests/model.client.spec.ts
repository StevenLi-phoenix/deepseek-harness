import { describe, expect, it } from 'vitest'
import { brief, parseText, pathKey, pickDescription, planEdits, type Drafts } from '../src/client/model.ts'
import type { ConfigEntryView, FieldNode, LeafField } from '../src/view.ts'

const leaf = (over: Partial<LeafField> & Pick<LeafField, 'kind' | 'key'>): LeafField => ({
  path: [over.key], layer: 'bundle', required: false, ...over,
})
const entryOf = (fields: FieldNode[]): ConfigEntryView => ({ id: 'e', found: true, active: true, locked: false, revision: 'r', overrides: 0, fields })
const drafts = (...rows: Array<[string[], Drafts extends ReadonlyMap<string, infer D> ? D : never]>): Drafts =>
  new Map(rows.map(([path, draft]) => [pathKey(path), draft]))

describe('parseText', () => {
  it('trims strings and clears an empty optional one, but not a required one', () => {
    expect(parseText(leaf({ kind: 'string', key: 'a' }), '  x ')).toEqual({ ok: true, op: 'set', value: 'x' })
    expect(parseText(leaf({ kind: 'string', key: 'a' }), ' ')).toEqual({ ok: true, op: 'clear' })
    expect(parseText(leaf({ kind: 'string', key: 'a', required: true }), '')).toEqual({ ok: false })
  })

  it('accepts a number inside its range and step, and refuses the rest', () => {
    const number = leaf({ kind: 'number', key: 'n', min: 1024, max: 4096, step: 1 })
    expect(parseText(number, '2048')).toEqual({ ok: true, op: 'set', value: 2048 })
    for (const bad of ['10', '5000', '2048.5', 'many', 'NaN']) expect(parseText(number, bad)).toEqual({ ok: false })
    expect(parseText(number, '')).toEqual({ ok: true, op: 'clear' })
  })

  it('reads one string per line, a chosen option, and JSON', () => {
    expect(parseText(leaf({ kind: 'string-list', key: 'l' }), 'a\n\n b \n')).toEqual({ ok: true, op: 'set', value: ['a', 'b'] })
    expect(parseText(leaf({ kind: 'string-list', key: 'l' }), '')).toEqual({ ok: true, op: 'set', value: [] })
    const select = leaf({ kind: 'select', key: 's', options: ['fast', 'slow'] })
    expect(parseText(select, '"slow"')).toEqual({ ok: true, op: 'set', value: 'slow' })
    expect(parseText(select, '"other"')).toEqual({ ok: false })
    expect(parseText(leaf({ kind: 'json', key: 'j' }), '{"a":1}')).toEqual({ ok: true, op: 'set', value: { a: 1 } })
    expect(parseText(leaf({ kind: 'json', key: 'j' }), '{')).toEqual({ ok: false })
  })
})

describe('planEdits', () => {
  const fields: FieldNode[] = [
    leaf({ kind: 'string', key: 'url', value: 'ws://a', default: 'ws://d' }),
    leaf({ kind: 'boolean', key: 'on', default: true }),
    leaf({ kind: 'number', key: 'n', value: 5, min: 1, layer: 'owner', base: 3, default: 2 }),
    leaf({ kind: 'secret', key: 'token', set: true, readOnly: 'secret' }),
    { kind: 'group', key: 'g', path: ['g'], children: [leaf({ kind: 'string', key: 'x', path: ['g', 'x'], value: 'v' })] },
  ]
  const entry = entryOf(fields)

  it('plans nothing for no drafts, for text equal to what is shown, and for a read-only field', () => {
    expect(planEdits(entry, new Map()).ops).toEqual([])
    expect(planEdits(entry, drafts([['url'], { kind: 'text', text: 'ws://a' }], [['on'], { kind: 'bool', value: true }])).ops).toEqual([])
    expect(planEdits(entry, drafts([['token'], { kind: 'text', text: 'x' }])).ops).toEqual([])
  })

  it('plans set, clear and reset with their review lines, in field order', () => {
    const plan = planEdits(entry, drafts(
      [['g', 'x'], { kind: 'text', text: 'w' }],
      [['url'], { kind: 'text', text: '' }],
      [['on'], { kind: 'bool', value: false }],
      [['n'], { kind: 'reset' }],
    ))
    expect(plan.ops).toEqual([
      { op: 'clear', path: ['url'] },
      { op: 'set', path: ['on'], value: false },
      { op: 'unset', path: ['n'] },
      { op: 'set', path: ['g', 'x'], value: 'w' },
    ])
    expect(plan.changes.map(change => [change.path.join('.'), change.action, change.before, change.after])).toEqual([
      ['url', 'clear', 'ws://a', 'ws://d'],
      ['on', 'set', 'true', 'false'],
      ['n', 'reset', '5', '3'],
      ['g.x', 'set', 'v', 'w'],
    ])
    expect(plan.invalid).toEqual([])
  })

  it('reports a draft the field does not accept, and sends nothing for it', () => {
    const plan = planEdits(entry, drafts([['n'], { kind: 'text', text: '0' }]))
    expect(plan).toMatchObject({ ops: [], invalid: [pathKey(['n'])] })
  })

  it('resets only a field the owner patch sets', () => {
    expect(planEdits(entry, drafts([['url'], { kind: 'reset' }])).ops).toEqual([])
  })
})

describe('text helpers', () => {
  it('cuts a long value for the review and joins a string list', () => {
    expect(brief('x'.repeat(200))).toHaveLength(80)
    expect(brief(['a', 'b'])).toBe('a, b')
    expect(brief(undefined)).toBe('')
  })

  it('picks a schema description by locale, then language, English, and the fallback', () => {
    const text = { '': 'fallback', en: 'English', zh: '中文' }
    expect(pickDescription(text, 'zh-CN')).toBe('中文')
    expect(pickDescription(text, 'de')).toBe('English')
    expect(pickDescription({ '': 'only' }, 'fr')).toBe('only')
    expect(pickDescription('plain', 'ja')).toBe('plain')
    expect(pickDescription(undefined, 'ja')).toBe('')
  })
})
