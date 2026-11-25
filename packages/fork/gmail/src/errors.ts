/**
 * The failures `ctx.gmail` reports beyond the Gmail API's own, and the error helpers the service's modules share.
 */

/** Why a Gmail operation failed, beyond the API's own failures. */
export type GmailFailure =
  | 'unknown-account' | 'not-configured' | 'needs-reconnect' | 'refused' | 'limit' | 'invalid' | 'expired' | 'denied' | 'not-found' | 'api'

/** A failed operation; the message is safe to log and to show to the model or the owner. */
export class GmailError extends Error {
  /**
   * @param failure - the failure class.
   * @param message - what went wrong.
   */
  constructor(readonly failure: GmailFailure, message: string) {
    super(message)
    this.name = 'GmailError'
  }
}

/** The refusal of a draft, a send, or a label change on a read-only account. */
export const READ_ONLY_REFUSAL = 'this account is read-only: the owner allows no drafts, sends, or changes from you'

/**
 * Human-readable error text.
 * @param error - the thrown value.
 * @returns its message, or its string form when it is not an Error.
 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A closed union ran out of cases.
 * @param value - the value no case matched.
 * @returns nothing; it always throws.
 */
/* v8 ignore next 3 -- closed-union backstop; its only call sites are the ignored defaults of closed-union switches. */
export function assertNever(value: never): never {
  throw new Error(`unhandled case ${String(value)}`)
}
