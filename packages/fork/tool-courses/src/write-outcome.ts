/** What a write sends and what it answers: the request id that makes a retry safe, and the outcome the model reads. */

import { createHash } from 'node:crypto'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/**
 * The request id of a write: the caller's, or one derived from the write's arguments, so retrying the identical
 * write reuses it and the service answers the first outcome again.
 * @param operation - the service operation.
 * @param args - the write's arguments without `request_id`.
 * @returns the id.
 */
export function requestId(operation: string, args: Record<string, unknown>): string {
  return `dsh-${operation}-${createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 24)}`
}

/** The conflicts where the write named a new id for a task the records already hold under another. */
const DUPLICATE_REASONS = new Set(['duplicate_title', 'duplicate_platform_identity'])

/**
 * The answer of a write: saved with the new version, a version conflict to reconcile, or a refused duplicate that
 * names the task to update instead (the service refuses a second id for an assignment the course already has).
 * @param result - the service's `result`.
 * @returns the model's answer.
 */
export function writeOutcome(result: unknown): JsonValue {
  const row = typeof result === 'object' && result !== null ? result as Record<string, unknown> : {}
  if (row['conflict'] === true) {
    const current = typeof row['current'] === 'object' && row['current'] !== null ? row['current'] as Record<string, unknown> : {}
    const reason = typeof row['reason'] === 'string' ? row['reason'] : 'version_or_evidence'
    const version = typeof current['version'] === 'number' ? current['version'] : null
    if (DUPLICATE_REASONS.has(reason)) {
      const id = typeof current['id'] === 'string' ? current['id'] : null
      const data = typeof current['data'] === 'object' && current['data'] !== null ? current['data'] as Record<string, unknown> : {}
      const title = typeof current['title'] === 'string' ? current['title'] : typeof data['title'] === 'string' ? data['title'] : null
      return {
        conflict: true,
        reason,
        existing_id: id,
        existing_title: title,
        current_version: version,
        next: `The records already hold this task as ${id ?? 'another record'}${version === null ? '' : ` (version ${version})`}: nothing was saved. Send the same observation again with id ${id ?? '<that id>'} and expected_version ${version ?? '<its version>'}, only the fields that differ; do not make a new task for it.`,
      }
    }
    return {
      conflict: true,
      reason,
      current_version: version,
      changed_fields: Array.isArray(row['changed_fields']) ? row['changed_fields'].filter((field): field is string => typeof field === 'string') : [],
      next: 'Someone changed the record since you read it: read it again with courses_get, reconcile with the owner if the change matters, and retry with the current version.',
    }
  }
  return { saved: true, id: typeof row['id'] === 'string' ? row['id'] : null, version: typeof row['version'] === 'number' ? row['version'] : null }
}
