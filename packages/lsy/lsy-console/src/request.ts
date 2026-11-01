/** Request bodies: parsed with schemastery, refused with a code that never echoes what the request held. */

import type z from '@deepseek-ai/schemastery'
import Schema from '@deepseek-ai/schemastery'
import type { ActionErrorCode } from './views.ts'

/** A request the route refused. */
export class Refusal extends Error {
  override readonly name = 'Refusal'

  /**
   * @param code - stable refusal code.
   * @param detail - short reason for the screen.
   */
  constructor(readonly code: ActionErrorCode, readonly detail?: string) {
    super(code)
  }
}

/**
 * Validate a parsed JSON body.
 * @param schema - the expected shape.
 * @param body - parsed JSON.
 * @returns the validated value with defaults applied.
 * @throws {Refusal} `invalid_request` naming the field path, never the value.
 */
export function parseBody<T>(schema: z<T>, body: unknown): T {
  try {
    return schema(body as never)
  } catch (error: unknown) {
    if (Schema.ValidationError.is(error)) {
      const path = (error.options.path ?? []).filter(segment => typeof segment === 'string' || typeof segment === 'number').join('.')
      throw new Refusal('invalid_request', path === '' ? undefined : path)
    }
    throw error
  }
}

/** Largest body a POST route reads, in bytes. */
export const MAX_BODY_BYTES = 64 * 1024

/**
 * Read a POST body as JSON. Only `application/json` is read, which a cross-site form cannot send.
 * @param request - the request.
 * @returns the parsed body.
 * @throws {Refusal} `invalid_request` for another content type, an oversized body, or invalid JSON.
 */
export async function readJson(request: Request): Promise<unknown> {
  const type = request.headers.get('content-type') ?? ''
  if (!/^application\/json\b/iu.test(type)) throw new Refusal('invalid_request', 'content-type')
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) throw new Refusal('invalid_request', 'size')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Refusal('invalid_request', 'json')
  }
}
