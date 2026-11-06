/** Small helpers the course tools share: model-supplied arguments, and the text of a failure. */

import { CoursesApiError } from '@deepseek-ai/dsh-lsy-courses'

/** A tool problem the model should read, not a crash. */
export class ToolProblem extends Error {}

/** Human-readable error text. */
export function errorText(error: unknown): string {
  if (error instanceof CoursesApiError && error.failure === 'not-configured') return 'The course records are not reachable: the courses token is not configured. Tell the owner; do not retry.'
  if (error instanceof CoursesApiError && error.failure === 'auth') return 'The courses service refused the token. Tell the owner; do not retry.'
  return error instanceof Error ? error.message : String(error)
}

/** A model-supplied argument as text; anything else is empty. */
export function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Clamp a model-supplied number into a range. */
export function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(max, Math.max(min, number))
}
