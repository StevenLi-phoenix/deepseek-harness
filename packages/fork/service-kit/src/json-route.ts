/** The answers and the request body of a Settings route that takes JSON actions. */

/** Headers of every answer: never cached. */
export const NO_STORE: Readonly<Record<string, string>> = { 'cache-control': 'no-store' }

/**
 * A JSON error answer.
 * @param status - the HTTP status.
 * @param error - the reason; it never repeats request data.
 * @returns `{ error }` with the status, never cached.
 */
export function jsonFailure(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: NO_STORE })
}

/**
 * Read a POST body that must be one JSON action the schema accepts.
 * @param request - the request.
 * @param parse - the action schema; it throws on a body it refuses.
 * @param refused - the reason given for a refused body; never the schema's message, which may quote the body.
 * @returns the action, or the answer to send: 415 or 400 as {@link readJsonBody} answers, and 400 with `refused`.
 */
export async function readJsonAction<Action>(
  request: Request,
  parse: (body: unknown) => Action,
  refused: string,
): Promise<{ readonly ok: true; readonly action: Action } | { readonly ok: false; readonly answer: Response }> {
  const read = await readJsonBody(request)
  if (!read.ok) return read
  try {
    return { ok: true, action: parse(read.body) }
  } catch {
    // The schema's message quotes the body, which may hold a verification number or a token.
    return { ok: false, answer: jsonFailure(400, refused) }
  }
}

/**
 * Read a POST body that must be JSON.
 * @param request - the request.
 * @returns the parsed body, or the answer to send: 415 without a JSON content type, 400 for a body that is not JSON.
 */
export async function readJsonBody(
  request: Request,
): Promise<{ readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly answer: Response }> {
  if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return { ok: false, answer: jsonFailure(415, 'expected application/json') }
  try {
    return { ok: true, body: await request.json() }
  } catch {
    // The parser's message may quote the body; the answer names the problem only.
    return { ok: false, answer: jsonFailure(400, 'body is not JSON') }
  }
}
