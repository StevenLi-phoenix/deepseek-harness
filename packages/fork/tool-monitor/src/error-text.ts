/**
 * Turn a failure into text for a log line or a tool answer.
 * @param error - anything thrown.
 * @returns the error's message, else its string form.
 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
