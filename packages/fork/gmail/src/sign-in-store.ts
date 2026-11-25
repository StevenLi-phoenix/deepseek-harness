/** Owner-private, single-use Google OAuth transactions. */
import { mkdir, readFile, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshPath } from '@deepseek-ai/dsh-home-paths'
import { z } from 'zod'
import { SEND_POLICIES } from './gate.ts'

/** The only registered Google redirect path. */
export const OAUTH_PATH = '/gmail.oauth'
/** Account ids can also be used as credential key segments. */
export const ACCOUNT_ID = /^[a-z][a-z0-9-]{0,23}$/u
const TTL_MS = 10 * 60_000
const MAX_SIGN_INS = 20
const statePattern = /^[A-Za-z0-9_-]{32}$/u

/**
 * Parse only a plain HTTPS (or loopback HTTP) URL to the registered callback path.
 * @param uri - configured or derived OAuth redirect URI.
 * @returns validated redirect URL, or undefined if it cannot address the callback.
 */
export function oauthRedirect(uri: string): URL | undefined {
  if (!uri.endsWith(OAUTH_PATH) || !/^https?:\/\/[^\s/?#@\\]+$/u.test(uri.slice(0, -OAUTH_PATH.length))) return undefined
  const url = URL.parse(uri)
  if (url === null) return undefined
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))) return undefined
  return url
}

const signInSchema = z.object({
  state: z.string().regex(statePattern),
  verifier: z.string().regex(/^[A-Za-z0-9_-]{64}$/u),
  account: z.string().regex(ACCOUNT_ID),
  policy: z.enum(SEND_POLICIES),
  redirectUri: z.string().refine(uri => oauthRedirect(uri) !== undefined),
  createdAt: z.number().int().nonnegative(),
}).strict()
const storeSchema = z.array(signInSchema).max(MAX_SIGN_INS)
type SignIn = z.infer<typeof signInSchema>

/** Read, expire and claim transactions under the same lock, including across Host instances. */
export class SignInStore {
  private readonly file = dshPath('data', 'gmail', 'sign-ins.json')

  /** Remove expired transactions at service startup. */
  async prune(): Promise<void> {
    await this.mutate(() => undefined)
  }

  /**
   * Persist a transaction before its URL is returned.
   * @param signIn - the transaction's OAuth binding and account details.
   * @returns false if the open-sign-in cap is reached or the state already exists.
   */
  insert(signIn: Omit<SignIn, 'createdAt'>): Promise<boolean> {
    return this.mutate((entries, now) => {
      if (entries.length >= MAX_SIGN_INS || entries.some(entry => entry.state === signIn.state)) return false
      entries.push({ ...signIn, createdAt: now })
      return true
    })
  }

  /** Remove and return the matching transaction before any remote call. */
  consume(state: string, check: (open: SignIn) => void): Promise<SignIn | undefined> {
    if (!statePattern.test(state)) return Promise.resolve(undefined)
    return this.mutate((entries) => {
      const index = entries.findIndex(entry => entry.state === state)
      const open = entries[index]
      if (open === undefined) return undefined
      check(open)
      entries.splice(index, 1)
      return open
    })
  }

  private async mutate<T>(change: (entries: SignIn[], now: number) => T): Promise<T> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    return withFileLock(this.file, async () => {
      const saved = await this.read()
      const now = Date.now()
      const open = saved.filter(entry => entry.createdAt <= now && now - entry.createdAt < TTL_MS)
      const result = change(open, now)
      if (saved.length !== open.length || saved.some((entry, index) => entry !== open[index])) {
        if (open.length === 0) await unlink(this.file)
        else await writeFileAtomic(this.file, `${JSON.stringify(open)}\n`, { mode: 0o600, dirMode: 0o700 })
      }
      return result
    })
  }

  private async read(): Promise<SignIn[]> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    try {
      const result = storeSchema.safeParse(JSON.parse(text))
      if (result.success) return result.data
    } catch {
      // SyntaxError can include input text, so do not forward it.
      throw new Error('gmail: malformed open sign-in store')
    }
    throw new Error('gmail: malformed open sign-in store')
  }
}
