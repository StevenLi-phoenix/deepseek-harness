/** Small value helpers the tools share: error text, argument coercion, and an exhaustiveness guard. */

/** Human-readable error text. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Exhaustiveness guard for closed unions. */
export function assertNever(value: never): never {
  throw new Error(`unexpected value ${JSON.stringify(value)}`)
}

/** A tool argument as a string; anything else is the empty string. */
export const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** A tool argument as an integer; anything else is `fallback`. */
export const int = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isInteger(value) ? value : fallback)
