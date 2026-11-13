/** Small value helpers the tools share: error text, argument coercion, and an exhaustiveness guard. */

/**
 * Turn a failure into text for a log line or a tool answer.
 * @param error - anything thrown.
 * @returns the error's message, else its string form.
 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Exhaustiveness guard for closed unions.
 * @param value - the value left over after every case; `never` at compile time.
 * @returns never; always throws.
 */
export function assertNever(value: never): never {
  throw new Error(`unexpected value ${JSON.stringify(value)}`)
}

/**
 * A tool argument as a string; anything else is the empty string.
 * @param value - the argument.
 * @returns the string unchanged (not trimmed), or an empty string.
 */
export const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * A tool argument as an integer; anything else is `fallback`.
 * @param value - the argument.
 * @param fallback - used when the argument is not an integer number.
 * @returns the integer, or `fallback`.
 */
export const int = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isInteger(value) ? value : fallback)
