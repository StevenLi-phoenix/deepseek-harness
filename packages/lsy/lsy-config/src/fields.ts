/**
 * The form of one plugin entry: its Config schema walked together with the config in force, the config the bundle
 * layer alone gives, and whether the home patch sets the entry. Pure functions over plain data and live schema nodes.
 */

import { isDeepStrictEqual } from 'node:util'
import type z from '@deepseek-ai/schemastery'
import type { ConfigLayer, DescriptionText, FieldNode, ConfigValue, LeafKind, LeafField, LockReason } from './view.ts'

/** What the walk reads besides the schema. */
export interface FormState {
  /** The config in force, as stored (expressions are `{ __jsExpr }` nodes). */
  readonly effective: unknown
  /** The config the bundle layer alone gives. */
  readonly inherited: unknown
  /** The home patch sets this entry's config. */
  readonly locked: boolean
  /** Dotted paths of fields and groups left out of the form. */
  readonly exclude?: readonly string[]
}

/**
 * Test a field path against the excluded dotted paths.
 * @param exclude - dotted paths of fields and groups left out; undefined excludes nothing.
 * @param path - field path.
 * @returns whether the path is, or lies below, one of them.
 */
export function isExcluded(exclude: readonly string[] | undefined, path: readonly string[]): boolean {
  const dotted = path.join('.')
  return (exclude ?? []).some(entry => dotted === entry || dotted.startsWith(`${entry}.`))
}

/**
 * Remove the excluded fields from a stored config.
 * @param config - a stored config.
 * @param exclude - dotted paths to leave out.
 * @returns a detached copy without those fields.
 */
export function withoutPaths(config: unknown, exclude: readonly string[] | undefined): unknown {
  const walkValue = (value: unknown, path: readonly string[]): unknown => {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || isExpression(value)) return value
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !isExcluded(exclude, [...path, key]))
      .map(([key, child]) => [key, walkValue(child, [...path, key])]))
  }
  return walkValue(config, [])
}

/** Marks a place under a `!!js` expression, whose value is not known without running it. */
const EXPRESSION = Symbol('expression')

/** @returns whether a stored node is an unevaluated `!!js` expression. */
function isExpression(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 1 && typeof Reflect.get(value, '__jsExpr') === 'string'
}

/**
 * Read one field out of a stored config.
 * @param root - a stored config.
 * @param path - field path.
 * @returns the value there, `undefined` when nothing is stored, or the expression marker when a node on the way is an expression.
 */
export function readAt(root: unknown, path: readonly string[]): unknown {
  let node = root
  for (const key of path) {
    if (isExpression(node)) return EXPRESSION
    if (typeof node !== 'object' || node === null || Array.isArray(node) || !Object.hasOwn(node, key)) return undefined
    node = Reflect.get(node, key)
  }
  return isExpression(node) ? EXPRESSION : node
}

/**
 * List the object fields of a schema node.
 * @param node - a schema node; an intersection merges its members.
 * @returns the fields by key, or undefined when the node is not an object.
 */
export function objectFields(node: z): Record<string, z> | undefined {
  if (node.type === 'object') return node.dict ?? {}
  if (node.type !== 'intersect') return undefined
  const merged: Record<string, z> = {}
  for (const member of node.list ?? []) {
    const fields = objectFields(member)
    if (fields === undefined) return undefined
    Object.assign(merged, fields)
  }
  return merged
}

/**
 * Find a credential slot in a schema.
 * @param node - a schema node.
 * @returns whether the node, or anything below it, is a credential slot.
 */
export function containsSecret(node: z): boolean {
  if (node.meta.role === 'secret') return true
  return [...Object.values(node.dict ?? {}), ...node.inner === undefined ? [] : [node.inner], ...node.list ?? []]
    .some(child => containsSecret(child))
}

/** @returns a schema value as JSON, or undefined when it has none (functions, symbols, cycles). */
function jsonOf(value: unknown): ConfigValue | undefined {
  try {
    const text = JSON.stringify(value) as string | undefined
    return text === undefined ? undefined : JSON.parse(text) as ConfigValue
  } catch (_unserializable) {
    // A default that cannot be serialized is shown as having none.
    return undefined
  }
}

function descriptionOf(node: z): { description: DescriptionText } | Record<string, never> {
  const { description } = node.meta
  if (typeof description === 'string' && description !== '') return { description }
  if (typeof description === 'object' && Object.keys(description).length > 0) return { description: { ...description } }
  return {}
}

/**
 * Choose how a schema node is edited.
 * @param node - a schema node.
 * @returns the leaf kind; `json` for nodes without a dedicated control.
 */
export function leafKind(node: z): LeafKind {
  if (node.meta.role === 'secret') return 'secret'
  switch (node.type) {
    case 'string': return node.meta.role === 'credential-ref' ? 'credential-ref' : 'string'
    case 'number': return 'number'
    case 'boolean': return 'boolean'
    case 'array': return node.inner?.type === 'string' && !containsSecret(node.inner) ? 'string-list' : 'json'
    case 'union':
      return (node.list ?? []).length > 0 && (node.list ?? []).every(member => member.type === 'const') ? 'select' : 'json'
    default: return 'json'
  }
}

/** @returns the layer that decides the value at a path. */
function layerOf(state: FormState, path: readonly string[], stored: unknown): ConfigLayer {
  if (state.locked) return 'home'
  if (!isDeepStrictEqual(stored, readAt(state.inherited, path))) return 'owner'
  return stored === undefined ? 'default' : 'bundle'
}

function leafOf(node: z, path: readonly string[], fallback: unknown, state: FormState, volatile: boolean): LeafField {
  const kind = leafKind(node)
  const key = path.at(-1) as string
  const { meta } = node
  const base = {
    key, path: [...path], kind, required: meta.required === true, ...volatile ? { volatile: true as const } : {}, ...descriptionOf(node),
  }
  if (kind === 'secret') {
    const stored = readAt(state.effective, path)
    return { ...base, layer: state.locked ? 'home' : 'default', set: stored !== undefined, readOnly: 'secret' }
  }
  const stored = readAt(state.effective, path)
  const layer = layerOf(state, path, stored)
  const expression = stored === EXPRESSION
  const hasSecret = containsSecret(node)
  const defaultValue = jsonOf(meta.default ?? fallback)
  let readOnly: LockReason | undefined
  if (state.locked) readOnly = 'home'
  else if (expression) readOnly = 'expression'
  else if (hasSecret) readOnly = 'secret'
  const lower = layer === 'owner' && !expression && !hasSecret ? jsonOf(readAt(state.inherited, path)) : undefined
  const options = kind === 'select' ? (node.list ?? []).flatMap(member => jsonOf(member.value) ?? []) : undefined
  return {
    ...base,
    layer,
    ...stored === undefined || expression || hasSecret ? {} : { value: jsonOf(stored) as ConfigValue },
    ...defaultValue === undefined || hasSecret ? {} : { default: defaultValue },
    ...lower === undefined ? {} : { base: lower },
    ...meta.min === undefined ? {} : { min: meta.min },
    ...meta.max === undefined ? {} : { max: meta.max },
    ...meta.step === undefined ? {} : { step: meta.step },
    ...options === undefined ? {} : { options },
    ...readOnly === undefined ? {} : { readOnly },
  }
}

function walk(fields: Record<string, z>, path: readonly string[], defaults: unknown, state: FormState, volatile: boolean): FieldNode[] {
  return Object.entries(fields).flatMap(([key, node]): FieldNode[] => {
    const here = [...path, key]
    if (node.meta.hidden === true || isExcluded(state.exclude, here)) return []
    const below = volatile || node.meta.volatile === true
    const inherited: unknown = typeof defaults === 'object' && defaults !== null ? Reflect.get(defaults, key) : undefined
    const children = objectFields(node)
    if (children === undefined) return [leafOf(node, here, inherited, state, below)]
    return [{
      kind: 'group', key, path: here, ...descriptionOf(node),
      children: walk(children, here, node.meta.default ?? inherited, state, below),
    }]
  })
}

/**
 * Build the form of one entry.
 * @param schema - the plugin's Config schema.
 * @param state - the stored layers and the home lock.
 * @returns the top-level nodes; empty when the schema is not an object.
 */
export function buildFields(schema: z, state: FormState): FieldNode[] {
  const fields = objectFields(schema)
  return fields === undefined ? [] : walk(fields, [], schema.meta.default, state, schema.meta.volatile === true)
}

/**
 * Tell whether a change at a path applies without reloading the plugin.
 * @param schema - the plugin's Config schema.
 * @param path - field path.
 * @returns whether the field, or an object above it, is `volatile`, so a change applies without reloading the plugin.
 */
export function isVolatileAt(schema: z, path: readonly string[]): boolean {
  let node: z | undefined = schema
  if (node.meta.volatile === true) return true
  let fields = objectFields(schema)
  for (const key of path) {
    node = fields !== undefined && Object.hasOwn(fields, key) ? fields[key] : undefined
    if (node === undefined) return false
    if (node.meta.volatile === true) return true
    fields = objectFields(node)
  }
  return false
}

/**
 * Look up the leaf schema node at a path.
 * @param schema - the plugin's Config schema.
 * @param path - field path.
 * @returns the leaf schema node at a path, or undefined when the path is not a leaf of the form.
 */
export function leafSchemaAt(schema: z, path: readonly string[]): z | undefined {
  let fields = objectFields(schema)
  for (const [index, key] of path.entries()) {
    const node = fields !== undefined && Object.hasOwn(fields, key) ? fields[key] : undefined
    if (node === undefined || node.meta.hidden === true) return undefined
    const below = objectFields(node)
    if (index === path.length - 1) return below === undefined ? node : undefined
    if (below === undefined) return undefined
    fields = below
  }
  return undefined
}

export { EXPRESSION }
