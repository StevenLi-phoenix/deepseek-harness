/** The log sink the bus collaborators write to, and the text they log for a thrown value. */

/** The `ctx.logger` methods the bus collaborators call. */
export interface BusLogger {
  info(message: string): void
  warn(message: string): void
  debug(message: string): void
}

/**
 * Human-readable text of a thrown value.
 * @param error - the thrown value.
 * @returns the message of an `Error`, otherwise the value as a string.
 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
