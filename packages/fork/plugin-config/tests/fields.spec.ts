import { describe, expect, it } from 'vitest'
import z from '@deepseek-ai/schemastery'
import { ConfigEditError, applyOps, revisionOf } from '../src/edit.ts'
import {
  EXPRESSION, buildFields, containsSecret, isExcluded, isVolatileAt, leafKind, leafSchemaAt, objectFields, readAt, withoutPaths,
  type FormState,
} from '../src/fields.ts'
import { leavesOf, type LeafField } from '../src/view.ts'

const expr = (source: string) => ({ __jsExpr: source })
const state = (over: Partial<FormState> = {}): FormState => ({ effective: {}, inherited: {}, locked: false, ...over })
const leafAt = (fields: ReturnType<typeof buildFields>, path: string): LeafField => leavesOf(fields).find(item => item.path.join('.') === path)!

describe('stored config helpers', () => {
  it('excludes a path that is, or lies below, an excluded entry, and excludes nothing without a list', () => {
    expect(isExcluded(undefined, ['a'])).toBe(false)
    expect(isExcluded(['a.b'], ['a', 'b'])).toBe(true)
    expect(isExcluded(['a.b'], ['a', 'b', 'c'])).toBe(true)
    expect(isExcluded(['a.b'], ['a', 'bc'])).toBe(false)
  })

  it('copies a config without the excluded fields and keeps an expression node whole', () => {
    const config = { keep: 1, drop: 2, group: { drop: 3, keep: [1], expression: expr('1 + 1') } }
    expect(withoutPaths(config, ['drop', 'group.drop'])).toEqual({ keep: 1, group: { keep: [1], expression: expr('1 + 1') } })
    expect(withoutPaths(config, undefined)).toEqual(config)
    expect(withoutPaths(undefined, ['a'])).toBeUndefined()
  })

  it('reads a value at a path, and marks a path that runs through an expression', () => {
    const config = { a: { b: 1 }, e: expr('x'), list: [1] }
    expect(readAt(config, ['a', 'b'])).toBe(1)
    expect(readAt(config, ['a', 'missing'])).toBeUndefined()
    expect(readAt(config, ['list', '0'])).toBeUndefined()
    expect(readAt(config, ['e'])).toBe(EXPRESSION)
    expect(readAt(config, ['e', 'deeper'])).toBe(EXPRESSION)
  })

  it('fingerprints the config in force and the bundle layer, ignoring excluded fields, with an absent layer as null', () => {
    const base = revisionOf({ a: 1, groups: ['x'] }, { a: 0 }, ['groups'])
    expect(base).toMatch(/^[0-9a-f]{12}$/)
    expect(revisionOf({ a: 1, groups: ['y'] }, { a: 0 }, ['groups'])).toBe(base)
    expect(revisionOf({ a: 1, groups: ['y'] }, { a: 0 })).not.toBe(base)
    expect(revisionOf(undefined, undefined)).toBe(revisionOf(null, null))
    expect(revisionOf(undefined, undefined)).not.toBe(revisionOf({}, {}))
  })
})

describe('schema walks', () => {
  it('lists the fields of an object, merges an intersection, and refuses a node that is not an object', () => {
    const left = z.object({ a: z.string() })
    const right = z.object({ b: z.number() })
    expect(Object.keys(objectFields(z.intersect([left, right])) ?? {})).toEqual(['a', 'b'])
    expect(objectFields(z.intersect([left, z.string()]))).toBeUndefined()
    expect(objectFields(z.string())).toBeUndefined()
    expect(Object.keys(objectFields(left) ?? {})).toEqual(['a'])
  })

  it('finds a credential slot at any depth', () => {
    expect(containsSecret(z.string().role('secret'))).toBe(true)
    expect(containsSecret(z.object({ a: z.dict(z.string().role('secret')) }))).toBe(true)
    expect(containsSecret(z.array(z.string().role('secret')))).toBe(true)
    expect(containsSecret(z.tuple([z.number(), z.string().role('secret')]))).toBe(true)
    expect(containsSecret(z.object({ a: z.string() }))).toBe(false)
  })

  it('chooses the control for each node type', () => {
    expect(leafKind(z.string())).toBe('string')
    expect(leafKind(z.string().role('credential-ref'))).toBe('credential-ref')
    expect(leafKind(z.string().role('secret'))).toBe('secret')
    expect(leafKind(z.number())).toBe('number')
    expect(leafKind(z.boolean())).toBe('boolean')
    expect(leafKind(z.array(z.string()))).toBe('string-list')
    expect(leafKind(z.array(z.number()))).toBe('json')
    expect(leafKind(z.array(z.string().role('secret')))).toBe('json')
    expect(leafKind(z.union([z.const('a'), z.const('b')]))).toBe('select')
    expect(leafKind(z.union([z.const('a'), z.string()]))).toBe('json')
    expect(leafKind(z.union([]))).toBe('json')
    expect(leafKind(z.dict(z.number()))).toBe('json')
  })

  it('tells where a change applies without a reload: the root, a group, or the field itself', () => {
    const schema = z.object({ live: z.string().volatile(), fixed: z.string(), group: z.object({ inner: z.string() }).volatile() })
    expect(isVolatileAt(schema, ['live'])).toBe(true)
    expect(isVolatileAt(schema, ['fixed'])).toBe(false)
    expect(isVolatileAt(schema, ['group', 'inner'])).toBe(true)
    expect(isVolatileAt(schema, ['missing'])).toBe(false)
    expect(isVolatileAt(schema, ['fixed', 'deeper'])).toBe(false)
    expect(isVolatileAt(z.object({ a: z.string() }).volatile(), ['a'])).toBe(true)
  })

  it('finds the leaf schema at a path, and nothing for a group, a hidden field, a missing path, or a path through a leaf', () => {
    const schema = z.object({ a: z.string(), hidden: z.string().hidden(), group: z.object({ b: z.number() }) })
    expect(leafSchemaAt(schema, ['a'])?.type).toBe('string')
    expect(leafSchemaAt(schema, ['group', 'b'])?.type).toBe('number')
    expect(leafSchemaAt(schema, ['group'])).toBeUndefined()
    expect(leafSchemaAt(schema, ['hidden'])).toBeUndefined()
    expect(leafSchemaAt(schema, ['nope'])).toBeUndefined()
    expect(leafSchemaAt(schema, ['a', 'deeper'])).toBeUndefined()
    expect(leafSchemaAt(schema, [])).toBeUndefined()
  })
})

describe('buildFields', () => {
  it('builds no form for a schema that is not an object', () => {
    expect(buildFields(z.string(), state())).toEqual([])
  })

  it('describes limits, descriptions per locale, and the options of a select, and leaves out what cannot be shown', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    const schema = z.object({
      size: z.natural().min(2).max(10).description('How big'),
      ratio: z.number().step(0.5),
      localized: z.string().i18n({ en: 'English text', zh: '中文' }),
      blank: z.string().extra('description', {}),
      mode: z.union([z.const('fast'), z.const(Symbol('hidden option')), z.const('slow')]).default('fast'),
      unserializable: z.any().default(cyclic),
      hidden: z.string().hidden(),
      shown: z.string(),
    })
    const fields = buildFields(schema, state({ exclude: ['shown'] }))
    expect(leavesOf(fields).map(item => item.key)).toEqual(['size', 'ratio', 'localized', 'blank', 'mode', 'unserializable'])
    expect(leafAt(fields, 'size')).toMatchObject({ kind: 'number', min: 2, max: 10, step: 1, description: 'How big' })
    expect(leafAt(fields, 'ratio')).toMatchObject({ step: 0.5 })
    expect(leafAt(fields, 'localized').description).toEqual({ '': undefined, en: 'English text', zh: '中文' })
    expect(leafAt(fields, 'blank')).not.toHaveProperty('description')
    expect(leafAt(fields, 'mode')).toMatchObject({ kind: 'select', options: ['fast', 'slow'], default: 'fast' })
    expect(leafAt(fields, 'unserializable')).not.toHaveProperty('default')
  })

  it('walks an intersection as a group and as the root, taking defaults only from objects', () => {
    const schema = z.intersect([
      z.object({ top: z.string().default('t') }),
      z.object({ nested: z.intersect([z.object({ deep: z.string() }), z.object({ more: z.number() })]) }),
    ])
    const fields = buildFields(schema, state())
    expect(fields.map(node => [node.kind, node.key])).toEqual([['string', 'top'], ['group', 'nested']])
    expect(leavesOf(fields).map(item => item.path.join('.'))).toEqual(['top', 'nested.deep', 'nested.more'])
  })

  it('shows a container that holds a credential as read-only without its value, and an array of credentials as json', () => {
    const schema = z.object({
      tokens: z.dict(z.string().role('secret')),
      keys: z.array(z.string().role('secret')),
      plain: z.string(),
    })
    const fields = buildFields(schema, state({ effective: { tokens: { a: 'private-value' }, keys: ['private-value'] }, inherited: {} }))
    expect(leafAt(fields, 'tokens')).toMatchObject({ kind: 'json', layer: 'owner', readOnly: 'secret' })
    expect(leafAt(fields, 'keys')).toMatchObject({ kind: 'json', readOnly: 'secret' })
    expect(JSON.stringify(fields)).not.toContain('private-value')
    expect(leafAt(fields, 'tokens')).not.toHaveProperty('value')
  })

  it('marks everything below a volatile group as volatile, and reports a field under an expression as read-only', () => {
    const schema = z.object({ live: z.object({ a: z.string(), b: z.string() }).volatile(), url: z.string() })
    const fields = buildFields(schema, state({ effective: { live: { a: 'x' }, url: expr('"x"') } }))
    expect(leafAt(fields, 'live.a')).toMatchObject({ volatile: true })
    expect(leafAt(fields, 'url')).toMatchObject({ readOnly: 'expression', layer: 'owner' })
    expect(leafAt(fields, 'url')).not.toHaveProperty('value')
  })
})

describe('applyOps', () => {
  const schema = z.object({
    url: z.string(),
    password: z.string().role('secret'),
    media: z.object({ images: z.boolean(), maxBytes: z.number() }),
    groups: z.array(z.string()).volatile(),
    hidden: z.string().hidden(),
  })
  const apply = (
    current: Record<string, unknown>, inherited: Record<string, unknown>, ops: Parameters<typeof applyOps>[3], exclude?: string[],
  ) =>
    applyOps(schema, current, inherited, ops, exclude)
  const reasonOf = (work: () => unknown): string | undefined => {
    try {
      work()
    } catch (error) {
      return error instanceof ConfigEditError ? `${error.reason}: ${error.message}` : 'other'
    }
    return undefined
  }

  it('keeps the parent group when a field is cleared and another field still lives in it', () => {
    const result = apply({ media: { images: false, maxBytes: 5 } }, {}, [{ op: 'clear', path: ['media', 'images'] }])
    expect(result.next).toEqual({ media: { maxBytes: 5 } })
    expect(result.changed).toEqual(['media.images'])
  })

  it('removes the group a reset empties, unless the bundle layer has one', () => {
    expect(apply({ media: { images: false } }, {}, [{ op: 'unset', path: ['media', 'images'] }]).next).toEqual({})
    expect(apply({ media: { images: false } }, { media: { maxBytes: 1 } }, [{ op: 'unset', path: ['media', 'images'] }]).next).toEqual({ media: {} })
  })

  it('removes the field when the bundle layer sets it by expression, so the default applies', () => {
    const result = apply({ url: 'ws://owner' }, { url: expr('"ws://bundle"') }, [{ op: 'unset', path: ['url'] }])
    expect(result.next).toEqual({})
    expect(result.changed).toEqual(['url'])
  })

  it('reloads for a plain field and not for a volatile one, and reports only the fields that moved', () => {
    expect(apply({}, {}, [{ op: 'set', path: ['groups'], value: ['1'] }])).toMatchObject({ changed: ['groups'], reload: false })
    expect(apply({}, {}, [{ op: 'set', path: ['url'], value: 'x' }])).toMatchObject({ changed: ['url'], reload: true })
    expect(apply({ url: 'x' }, {}, [{ op: 'set', path: ['url'], value: 'x' }])).toMatchObject({ changed: [], reload: false })
  })

  it('refuses an excluded field, an unknown field, a group, a hidden field, a credential, and a field under an expression', () => {
    const set = (path: string[]) => [{ op: 'set' as const, path, value: 'v' }]
    expect(reasonOf(() => apply({}, {}, set(['url']), ['url']))).toBe('bad-request: "url" is edited elsewhere, not in this form')
    expect(reasonOf(() => apply({}, {}, set(['nope'])))).toBe('bad-request: "nope" is not a field of this plugin')
    expect(reasonOf(() => apply({}, {}, set(['media'])))).toBe('bad-request: "media" is not a field of this plugin')
    expect(reasonOf(() => apply({}, {}, set(['hidden'])))).toBe('bad-request: "hidden" is not a field of this plugin')
    expect(reasonOf(() => apply({}, {}, set(['password'])))).toBe('bad-request: "password" holds a credential, which is not edited here')
    expect(reasonOf(() => apply({ url: expr('"x"') }, {}, set(['url']))))
      .toBe('bad-request: "url" is set by a !!js expression, which is edited in the patch file')
  })
})
