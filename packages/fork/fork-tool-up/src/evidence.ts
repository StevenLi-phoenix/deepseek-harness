/**
 * Bilibili evidence for `style_propose` (fork-style) in the `up` preset: the comments a proposal cites, verified by code.
 *
 * bili-svc has no endpoint that returns one comment by id, so the verifier answers from the comments this plugin
 * already returned to the Session through `up_comments` and `up_comment_thread` (a cache keyed by rpid), and for a
 * miss reads the existing `GET /v1/comments/{rpid}/thread` (the root thread, first page) and looks for the rpid
 * there. The creator's own accounts (`/v1/status` → `accounts[].mid`) are never evidence. A sender is identified only
 * by a salted HMAC of its mid; the raw UID never leaves this file.
 */

import { createHmac, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** One verified comment. */
export interface BiliEvidenceItem {
  /** The comment's rpid, decimal. */
  readonly id: string
  /** HMAC-SHA256 of `bili:<mid>` under this deployment's salt, 32 hex characters; never the UID. */
  readonly senderKey: string
  /** When the comment was posted, Unix epoch milliseconds. */
  readonly at: number
  /** The comment text; viewers' words, untrusted. */
  readonly text: string
}

/** Who asks: the Session whose tool call cites the evidence. */
export interface BiliEvidenceCaller {
  readonly sessionId: string
}

/**
 * `ctx.biliEvidence`: the Bilibili evidence verifier, provided by `@deepseek-ai/dsh-fork-tool-up` inside the `up`
 * preset's isolated group, so only rows in that group see it.
 */
export interface BiliEvidence {
  /**
   * Look up the comments a proposal cites.
   * @param ids - comment rpids as decimal strings; duplicates and malformed ids are ignored.
   * @param caller - the calling Session.
   * @returns the comments found, in the order asked; an id that cannot be verified is left out, never invented.
   * @throws {BiliEvidenceRefusedError} when the caller is not the persistent `bili-digest` Session, or its turn
   * already used its calls.
   */
  evidenceOf(ids: readonly string[], caller: BiliEvidenceCaller): Promise<BiliEvidenceItem[]>
}

/** Why the verifier refused a call. */
export type BiliEvidenceRefusal = 'not_persistent_session' | 'turn_cap'

/** A refused evidence call. */
export class BiliEvidenceRefusedError extends Error {
  override readonly name = 'BiliEvidenceRefusedError'

  /**
   * @param code - `not_persistent_session` or `turn_cap`.
   * @param message - human-readable reason.
   */
  constructor(readonly code: BiliEvidenceRefusal, message: string) {
    super(message)
  }
}

/** A comment as this plugin keeps it; `mid` stays inside the plugin. */
export interface CachedComment {
  readonly rpid: number
  readonly mid: number
  readonly ctime: number
  readonly text: string
}

const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? value as Record<string, unknown> : {})
const int = (value: unknown): number | undefined => (typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined)

/**
 * One comment of a bili-svc answer (`comments[]`, `root`, `replies[]`): rpid, mid, ctime, and `untrusted.text`.
 * @param value - one element.
 * @returns the comment, or undefined when a field is missing.
 */
export function parseComment(value: unknown): CachedComment | undefined {
  const fields = record(value)
  const rpid = int(fields['rpid'])
  const mid = int(fields['mid'])
  const ctime = int(fields['ctime'])
  const text = record(fields['untrusted'])['text']
  if (rpid === undefined || rpid <= 0 || mid === undefined || ctime === undefined || typeof text !== 'string') return undefined
  return { rpid, mid, ctime, text }
}

/**
 * Every comment in an `up_comments` (`comments`) or `up_comment_thread` (`root`, `replies`) answer.
 * @param body - the answer bili-svc returned.
 * @returns the comments that parse.
 */
export function commentsOf(body: unknown): CachedComment[] {
  const fields = record(body)
  const items = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : [])
  const root = fields['root']
  const list: unknown[] = [...items(fields['comments']), ...root === undefined || root === null ? [] : [root], ...items(fields['replies'])]
  return list.map(parseComment).filter(comment => comment !== undefined)
}

/**
 * The creator's own account ids in a `/v1/status` answer.
 * @param body - the answer.
 * @returns `accounts[].mid` values.
 */
export function ownMidsOf(body: unknown): number[] {
  const accounts = record(body)['accounts']
  return Array.isArray(accounts) ? accounts.map(account => int(record(account)['mid'])).filter((mid): mid is number => mid !== undefined && mid > 0) : []
}

/** Comments by rpid, oldest insertion dropped first beyond `size`. */
export class CommentCache {
  private readonly entries = new Map<number, CachedComment>()

  /** @param size - most comments kept. */
  constructor(private readonly size: number) {}

  /**
   * Remember comments; a known rpid moves to the newest place.
   * @param comments - parsed comments.
   */
  put(comments: readonly CachedComment[]): void {
    for (const comment of comments) {
      this.entries.delete(comment.rpid)
      this.entries.set(comment.rpid, comment)
    }
    for (const rpid of this.entries.keys()) {
      if (this.entries.size <= this.size) break
      this.entries.delete(rpid)
    }
  }

  /**
   * Look up a cached comment.
   * @param rpid - comment id.
   * @returns the cached comment; undefined when it was never read or has been evicted.
   */
  get(rpid: number): CachedComment | undefined {
    return this.entries.get(rpid)
  }
}

/**
 * The stable sender key of a Bilibili account.
 * @param salt - this deployment's secret salt.
 * @param mid - the account id.
 * @returns 32 hex characters of HMAC-SHA256(salt, `bili:<mid>`).
 */
export function senderKey(salt: string, mid: number): string {
  return createHmac('sha256', salt).update(`bili:${mid}`).digest('hex').slice(0, 32)
}

/**
 * Default salt file.
 * @param env - environment holding `DSH_HOME`.
 * @returns `<DSH_HOME>/fork-tool-up/evidence-salt`.
 */
export function defaultSaltFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(undefined, env), 'fork-tool-up', 'evidence-salt')
}

/**
 * Read the salt, creating it (32 random bytes, hex, mode 0600) on first use.
 * @param file - absolute path.
 * @returns the salt.
 */
export async function loadSalt(file: string): Promise<string> {
  try {
    const salt = (await readFile(file, 'utf8')).trim()
    if (salt.length >= 32) return salt
    throw new Error(`${file} holds a salt shorter than 32 characters`)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const salt = randomBytes(32).toString('hex')
  // `wx`: a concurrent first use that lost the race reads the winner's salt.
  try {
    await writeFile(file, `${salt}\n`, { mode: 0o600, flag: 'wx' })
    return salt
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return (await readFile(file, 'utf8')).trim()
  }
}
