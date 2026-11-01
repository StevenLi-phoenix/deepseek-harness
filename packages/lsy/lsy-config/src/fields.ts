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
}

/** Marks a place under a `!!js` expression, whose value is not known without running it. */
const EXPRESSION = Symbol('expression')

/** @returns whether a stored node is an unevaluated `!!js` expression. */
function isExpression(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 1 && typeof Reflect.get(value, '__jsExpr') === 'string'
}

/**
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

/** @returns the object fields a schema node declares, or undefined when it is not an object. */
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

/** @returns whether a schema node, or anything below it, is a credential slot. */
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

/** @returns the leaf kind a schema node is edited as. */
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

function leafOf(node: z, path: readonly string[], fallback: unknown, state: FormState): LeafField {
  const kind = leafKind(node)
  const key = path.at(-1) as string
  const { meta } = node
  const base = { key, path: [...path], kind, required: meta.required === true, ...descriptionOf(node) }
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

function walk(fields: Record<string, z>, path: readonly string[], defaults: unknown, state: FormState): FieldNode[] {
  return Object.entries(fields).flatMap(([key, node]): FieldNode[] => {
    if (node.meta.hidden === true) return []
    const here = [...path, key]
    const fallback = typeof defaults === 'object' && defaults !== null ? Reflect.get(defaults, key) as unknown : undefined
    const children = objectFields(node)
    if (children === undefined) return [leafOf(node, here, fallback, state)]
    return [{
      kind: 'group', key, path: here, ...descriptionOf(node),
      children: walk(children, here, node.meta.default ?? fallback, state),
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
  return fields === undefined ? [] : walk(fields, [], schema.meta.default, state)
}

/**
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
