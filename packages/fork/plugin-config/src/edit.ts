/**
 * Turning a save's edits into the next stored config of an entry. The owner's patch row replaces the bundle's whole
 * config, so the next config is the config in force with the edited fields changed, never the edits alone.
 */

import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type z from '@deepseek-ai/schemastery'
import { EXPRESSION, containsSecret, isExcluded, isVolatileAt, leafKind, leafSchemaAt, readAt, withoutPaths } from './fields.ts'
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
 * Fingerprint of what a save is staged against: the config in force and the bundle layer's, without the excluded
 * fields, so a dedicated editor changing those does not make a form that never showed them stale.
 * @param effective - the config in force.
 * @param inherited - the config the bundle layer alone gives.
 * @param exclude - dotted paths of fields the form leaves out.
 * @returns twelve hex digits.
 */
export function revisionOf(effective: unknown, inherited: unknown, exclude?: readonly string[]): string {
  const view = [withoutPaths(effective, exclude) ?? null, withoutPaths(inherited, exclude) ?? null]
  return createHash('sha1').update(JSON.stringify(view)).digest('hex').slice(0, 12)
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

function check(schema: z, current: unknown, op: ConfigOp, exclude: readonly string[] | undefined): void {
  const label = pathLabel(op.path)
  if (isExcluded(exclude, op.path)) throw new ConfigEditError('bad-request', `"${label}" is edited elsewhere, not in this form`)
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
 * @param exclude - dotted paths of fields this form does not edit; an edit of one is refused.
 * @returns the next stored config, the dotted paths whose stored value changed, and whether the plugin reloads.
 * @throws ConfigEditError - for a path that is not a plain field, holds a credential, or sits under an expression.
 */
export function applyOps(
  schema: z, current: Record<string, unknown>, inherited: Record<string, unknown>, ops: readonly ConfigOp[],
  exclude?: readonly string[],
): { next: Record<string, unknown>; changed: string[]; reload: boolean } {
  let next = current
  const touched = new Map<string, readonly string[]>()
  for (const op of ops) {
    check(schema, next, op, exclude)
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
  const moved = [...touched].filter(([, path]) => !isDeepStrictEqual(readAt(current, path), readAt(next, path)))
  return { next, changed: moved.map(([label]) => label), reload: moved.some(([, path]) => !isVolatileAt(schema, path)) }
}
