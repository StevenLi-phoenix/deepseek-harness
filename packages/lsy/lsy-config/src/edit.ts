/**
 * Turning a save's edits into the next stored config of an entry. The owner's patch row replaces the bundle's whole
 * config, so the next config is the config in force with the edited fields changed, never the edits alone.
 */

import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type z from '@deepseek-ai/schemastery'
import { EXPRESSION, containsSecret, leafKind, leafSchemaAt, readAt } from './fields.ts'
import { pathLabel, type ConfigOp, type ConfigSaveFailure } from './view.ts'

/** A save the Host refuses before writing anything. */
export class ConfigEditError extends Error {
  /**
   * @param reason - the refusal's class.
   * @param message - what to tell the owner; never contains a value.
   */
  constructor(readonly reason: ConfigSaveFailure, message: string) {
    super(message)
    this.name = 'ConfigEditError'
  }
}

/** @returns whether a value is a plain data object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Fingerprint of what a save is staged against: the config in force and the bundle layer's.
 * @param effective - the config in force.
 * @param inherited - the config the bundle layer alone gives.
 * @returns twelve hex digits.
 */
export function revisionOf(effective: unknown, inherited: unknown): string {
  return createHash('sha1').update(JSON.stringify([effective ?? null, inherited ?? null])).digest('hex').slice(0, 12)
}

function withValue(root: Record<string, unknown>, path: readonly string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = path as [string, ...string[]]
  const next = { ...root }
  if (rest.length === 0) {
    if (value === undefined) Reflect.deleteProperty(next, head)
    else next[head] = value
    return next
  }
  const child = isRecord(root[head]) ? root[head] : {}
  next[head] = withValue(child, rest, value)
  return next
}

/** Remove objects the edit left empty where the bundle layer has nothing either, so a reset leaves no residue. */
function pruned(root: Record<string, unknown>, inherited: unknown, path: readonly string[]): Record<string, unknown> {
  for (let depth = path.length - 1; depth > 0; depth--) {
    const parent = path.slice(0, depth)
    const value = readAt(root, parent)
    if (!isRecord(value) || Object.keys(value).length > 0 || readAt(inherited, parent) !== undefined) break
    root = withValue(root, parent, undefined)
  }
  return root
}

function check(schema: z, current: unknown, op: ConfigOp): void {
  const label = pathLabel(op.path)
  const node = leafSchemaAt(schema, op.path)
  if (node === undefined) throw new ConfigEditError('bad-request', `"${label}" is not a field of this plugin`)
  if (leafKind(node) === 'secret' || containsSecret(node)) {
    throw new ConfigEditError('bad-request', `"${label}" holds a credential, which is not edited here`)
  }
  if (readAt(current, op.path) === EXPRESSION) {
    throw new ConfigEditError('bad-request', `"${label}" is set by a !!js expression, which is edited in the patch file`)
  }
}

/**
 * Apply a save's edits to the config in force.
 * @param schema - the plugin's Config schema.
 * @param current - the config in force, as stored.
 * @param inherited - the config the bundle layer alone gives.
 * @param ops - the edits, in order; a later edit of a path wins.
 * @returns the next stored config and the dotted paths whose stored value changed.
 * @throws ConfigEditError - for a path that is not a plain field, holds a credential, or sits under an expression.
 */
export function applyOps(
  schema: z, current: Record<string, unknown>, inherited: Record<string, unknown>, ops: readonly ConfigOp[],
): { next: Record<string, unknown>; changed: string[] } {
  let next = current
  const touched = new Map<string, readonly string[]>()
  for (const op of ops) {
    check(schema, next, op)
    if (op.op === 'set') {
      next = withValue(next, op.path, op.value)
    } else {
      // `unset` goes back to what the bundle sets. Where it sets nothing, and for `clear`, the field is removed and
      // the schema default applies.
      const lower = op.op === 'unset' ? readAt(inherited, op.path) : undefined
      next = withValue(next, op.path, lower === EXPRESSION ? undefined : lower)
      next = pruned(next, inherited, op.path)
    }
    touched.set(pathLabel(op.path), op.path)
  }
  const changed = [...touched].filter(([, path]) => !isDeepStrictEqual(readAt(current, path), readAt(next, path))).map(([label]) => label)
  return { next, changed }
}
