/**
 * The doorway to bili-svc: its address, the `up` bearer token, and the one HTTP call every tool and the evidence check make.
 * What comes back from Bilibili is wrapped as untrusted data before a model reads it.
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
// Type-only: ctx.credentials.
import type {} from '@deepseek-ai/dsh-credentials'

/** Default bili-svc address; `BILI_SVC_URL` in the service environment overrides it. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8097'
/** Credential holding the `up` bearer token. */
export const TOKEN_ENV = 'BILI_SVC_TOKEN_UP'
/** Characters of one untrusted block. */
export const MAX_BLOCK_CHARS = 12_000
/** A read gives up after this long. */
export const READ_TIMEOUT_MS = 30_000
/** A reply may wait for its random gap (up to three minutes) before it goes out. */
export const REPLY_TIMEOUT_MS = 330_000

/** The fetch the tools use; tests replace it. */
export interface Env {
  fetch: typeof fetch
  baseUrl: string
}

/**
 * Wrap Bilibili content as untrusted data. `<` is escaped inside the JSON, so no text can close the tag.
 * @param label - what the block is.
 * @param value - the JSON value.
 * @param max - the longest the block may be.
 * @returns the block as the model reads it.
 */
export function untrusted(label: string, value: unknown, max = MAX_BLOCK_CHARS): string {
  const json = JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
  const body = json.length > max ? `${json.slice(0, max)}…[truncated]` : json
  return `<bilibili_data trust="untrusted" source="${label}">\n${body}\n</bilibili_data>`
}

/** ` (error code)` of a bili-svc error body, for log lines. */
export function errorCode(body: unknown): string {
  const error = (body as { error?: unknown } | null)?.error
  return typeof error === 'string' ? ` (${error.slice(0, 60)})` : ''
}

/** What a bili-svc call answered. */
export interface Answer {
  status: number
  /** The parsed JSON body, or null when there was none. */
  body: unknown
}

/** A client of bili-svc that signs every call with the `up` token. */
export class BiliSvc {
  private readonly env: Env
  private readonly token: () => Promise<string>

  /**
   * @param env - fetch and base URL.
   * @param token - resolves the bearer token; throws when it is not set.
   */
  constructor(env: Env, token: () => Promise<string>) {
    this.env = env
    this.token = token
  }

  /**
   * Read from bili-svc.
   * @param path - path with query.
   * @param signal - the tool call's abort signal.
   * @returns the answer.
   */
  get(path: string, signal?: AbortSignal): Promise<Answer> {
    return this.call('GET', path, undefined, READ_TIMEOUT_MS, signal)
  }

  /**
   * Post a reply for the Reply Gate to decide on.
   * @param path - path.
   * @param body - JSON body.
   * @param signal - the tool call's abort signal.
   * @returns the answer.
   */
  post(path: string, body: unknown, signal?: AbortSignal): Promise<Answer> {
    return this.call('POST', path, body, REPLY_TIMEOUT_MS, signal)
  }

  private async call(method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<Answer> {
    const token = await this.token()
    const timeout = AbortSignal.timeout(timeoutMs)
    const response = await this.env.fetch(`${this.env.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    })
    let parsed: unknown = null
    try {
      parsed = await response.json()
    } catch {
      parsed = null
    }
    return { status: response.status, body: parsed }
  }
}

/**
 * Read the `up` bearer token from the credential store, afresh on every call.
 * @param ctx - the context that holds `ctx.credentials`.
 * @returns the reader.
 */
export function tokenReader(ctx: Context): () => Promise<string> {
  return async () => {
    const resolved = await ctx.credentials.resolve(credentialRef(TOKEN_ENV))
    if (resolved?.value === undefined || resolved.value === '') throw new Error(`${TOKEN_ENV} is not set`)
    return resolved.value
  }
}
