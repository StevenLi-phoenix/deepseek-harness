/** Failure text for logs, the owner, and the Settings page. */

import type { WechatAccount } from './login.ts'

/**
 * Human-readable error text.
 * @param error - the thrown value.
 * @returns its message, or its string form when it is not an `Error`.
 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Text with the account's bot token replaced, for logs and the Settings page.
 * @param text - the text to clean.
 * @param account - the account whose token is removed.
 * @returns the text with every copy of the token replaced by `***`.
 */
export function redact(text: string, account: WechatAccount): string {
  return text.replaceAll(account.botToken, '***')
}
