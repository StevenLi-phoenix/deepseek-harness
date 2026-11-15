/**
 * Failure text shared by the session and the live view: one line is what a tool
 * result or a log record can carry, while a Playwright error appends install or
 * protocol advice on later lines.
 *
 * @module @deepseek-ai/dsh-headless-browser/error
 */

/**
 * Keep the first line of an error message.
 * @param error - an `Error` or any thrown value.
 * @returns the first line of its text.
 */
export function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n', 1)[0] ?? message
}
