/**
 * bili-svc's read API over HTTP (`GET /v1/status`, `/v1/comments`, `/v1/comments/{rpid}/thread`), with a token that
 * has the `read` scope. Only reads: this file names no write or reply endpoint. Answers are third-party text and
 * are validated field by field; a comment missing a field is dropped.
 */

import type { BiliComment, BiliReader } from './collect.ts'

/** How the reader reaches bili-svc. */
export interface BiliHttp {
  readonly baseUrl: string
  readonly token: string
  readonly timeoutMs: number
  readonly fetch: typeof fetch
}

const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? value as Record<string, unknown> : {})
const int = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined)

/**
 * One comment from an answer: bili-svc wraps the text under `untrusted`.
 * @param value - one element of `comments`, `replies`, or `root`.
 * @returns the comment, or undefined when a field is missing.
 */
export function parseComment(value: unknown): BiliComment | undefined {
  const fields = record(value)
  const rpid = int(fields['rpid'])
  const mid = int(fields['mid'])
  const ctime = int(fields['ctime'])
  const text = record(fields['untrusted'])['text']
  if (rpid === undefined || mid === undefined || ctime === undefined || typeof text !== 'string') return undefined
  const gate = fields['gate']
  return {
    rpid, mid, ctime, text,
    root: int(fields['root']) ?? 0,
    parent: int(fields['parent']) ?? 0,
    ...typeof gate === 'boolean' ? { gate } : {},
  }
}

/**
 * The reader.
 * @param http - address, token, deadline, and fetch.
 * @returns the reader.
 */
export function createBiliReader(http: BiliHttp): BiliReader {
  const get = async (path: string, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    const timeout = AbortSignal.timeout(http.timeoutMs)
    const response = await http.fetch(`${http.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${http.token}` },
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    })
    if (!response.ok) throw new Error(`bili-svc answered HTTP ${String(response.status)} for ${path.split('?')[0] ?? path}`)
    return record(await response.json())
  }
  const comments = (value: unknown): BiliComment[] => (Array.isArray(value) ? value.flatMap(item => parseComment(item) ?? []) : [])
  return {
    async accounts(signal) {
      const body = await get('/v1/status', signal)
      const list = Array.isArray(body['accounts']) ? body['accounts'] : []
      return list.flatMap((item: unknown) => {
        const fields = record(item)
        return typeof fields['id'] === 'string' ? [{ id: fields['id'], mid: int(fields['mid']) ?? null }] : []
      })
    },
    async comments(limit, signal) {
      return comments((await get(`/v1/comments?unreplied=0&limit=${String(limit)}`, signal))['comments'])
    },
    async thread(rpid, signal) {
      const body = await get(`/v1/comments/${String(rpid)}/thread`, signal)
      return { root: parseComment(body['root']) ?? null, replies: comments(body['replies']) }
    },
  }
}
