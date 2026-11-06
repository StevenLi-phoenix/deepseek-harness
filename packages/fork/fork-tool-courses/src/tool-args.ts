/** Small helpers the course tools share: model-supplied arguments, and the text of a failure. */

import { CoursesApiError } from '@deepseek-ai/dsh-fork-courses'

/** A tool problem the model should read, not a crash. */
export class ToolProblem extends Error {}

/**
 * Turn a failure into text the model can act on.
 * @param error - anything thrown.
 * @returns a fixed instruction for a missing or refused courses token, else the error's message, else its string form.
 */
export function errorText(error: unknown): string {
  if (error instanceof CoursesApiError && error.failure === 'not-configured') return 'The course records are not reachable: the courses token is not configured. Tell the owner; do not retry.'
  if (error instanceof CoursesApiError && error.failure === 'auth') return 'The courses service refused the token. Tell the owner; do not retry.'
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read a model-supplied argument as text.
 * @param value - the argument.
 * @returns the trimmed string; empty when the argument is not a string.
 */
export function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Clamp a model-supplied number into a range.
 * @param value - the argument.
 * @param fallback - used when the argument is not a finite number.
 * @param min - lowest result.
 * @param max - highest result.
 * @returns the value rounded to an integer and limited to `min`..`max`.
 */
export function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(max, Math.max(min, number))
}
