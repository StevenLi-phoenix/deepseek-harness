/**
 * The browser's own password store: a site account the agent signs up for gets
 * a password generated here, kept in one owner-only file, and written into the
 * page by the session; the value never enters a tool result, a log line, or the
 * model's context. A record is bound to the host it was created on, the way a
 * browser's password manager binds one, so a page on another host cannot get a
 * saved password typed into it. The owner reads the passwords from the owner-only
 * export route, in the CSV layout Chrome's password manager imports.
 *
 * @module @deepseek-ai/dsh-headless-browser/credentials
 */

import { randomBytes, randomInt } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** File format version; a file with another version is refused rather than overwritten. */
const FILE_VERSION = 1

/** Characters a generated password draws from. The symbols avoid quotes, spaces, and markup that forms reject. */
const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const DIGITS = '23456789'
const SYMBOLS = '!@#$%^*-_=+?'

/** Shortest generated password; a shorter request is raised to this length. */
export const MIN_PASSWORD_LENGTH = 12
/** Longest generated password; a longer request is cut to this length. */
export const MAX_PASSWORD_LENGTH = 64
/** Length of a generated password when the caller names none. */
export const DEFAULT_PASSWORD_LENGTH = 20

/** One saved account, password included; only this module and the session see the password. */
export interface SiteCredentialRecord {
  /** Stable id, `c<hex>`, the tools and the owner refer to. */
  readonly id: string
  /** Lower-case host the account belongs to, without a port. */
  readonly host: string
  /** Login name: usually the e-mail address the account was created with. */
  readonly username: string
  /** The secret. Never leaves through a tool result or a log line. */
  readonly password: string
  /** Short owner-facing label, such as the company name. */
  readonly label?: string
  /** ISO time the record was created. */
  readonly createdAt: string
  /** ISO time a password was last written into a page. */
  readonly lastUsedAt?: string
  /** ISO time the password was replaced, when it was. */
  readonly replacedAt?: string
  /** The password before the last replacement, kept for the owner when a sign-up half failed. */
  readonly previousPassword?: string
}

/** A record as a tool result and the status list carry it: everything but the secrets. */
export interface CredentialView {
  readonly id: string
  readonly host: string
  readonly username: string
  readonly label?: string
  readonly createdAt: string
  readonly lastUsedAt?: string
  readonly replacedAt?: string
}

/** What `create` needs. */
export interface CredentialCreateRequest {
  /** Page host the account is for. */
  readonly host: string
  /** Login name. */
  readonly username: string
  /** Owner-facing label. */
  readonly label?: string
  /** Password length, {@link MIN_PASSWORD_LENGTH} through {@link MAX_PASSWORD_LENGTH}. */
  readonly length?: number
  /** Whether the password includes symbols; a site that rejects them gets letters and digits only. */
  readonly symbols?: boolean
  /** Replace the saved password of an existing host and username instead of refusing. */
  readonly replace?: boolean
}

/** A refusal the model can act on: no account here, two accounts here, one already saved. */
export class CredentialError extends Error {
  override readonly name = 'CredentialError'
}

/** The file on disk. */
interface CredentialFile {
  readonly version: number
  readonly entries: SiteCredentialRecord[]
}

/**
 * Normalise a host: lower case, no port, no trailing dot.
 * @param host - a host name or a whole URL.
 * @returns the bare host.
 * @throws CredentialError - when the value names no host.
 */
export function credentialHost(host: string): string {
  let value = host.trim().toLowerCase()
  if (value.includes('://')) {
    try {
      value = new URL(value).hostname
    } catch {
      throw new CredentialError(`${host} is not a URL with a host`)
    }
  }
  value = value.replace(/:\d+$/u, '').replace(/\.$/u, '')
  if (value === '' || /[\s/]/u.test(value)) throw new CredentialError(`${host} names no host`)
  return value
}

/**
 * Generate a password with at least one lower-case letter, upper-case letter,
 * digit, and (unless turned off) symbol, from a CSPRNG; ambiguous characters
 * such as `l`, `O`, `0`, and `1` are left out so the owner can retype it.
 * @param length - characters, clamped to the supported bounds.
 * @param symbols - include symbols.
 * @returns the password.
 */
export function generatePassword(length = DEFAULT_PASSWORD_LENGTH, symbols = true): string {
  const size = Math.min(Math.max(Math.trunc(length), MIN_PASSWORD_LENGTH), MAX_PASSWORD_LENGTH)
  const classes = symbols ? [LOWER, UPPER, DIGITS, SYMBOLS] : [LOWER, UPPER, DIGITS]
  const all = classes.join('')
  const pick = (set: string): string => set.charAt(randomInt(set.length))
  const chars = classes.map(pick)
  while (chars.length < size) chars.push(pick(all))
  // Fisher–Yates with the same CSPRNG, so the required characters sit anywhere.
  for (let index = chars.length - 1; index > 0; index -= 1) swapEntries(chars, index, randomInt(index + 1))
  return chars.join('')
}

/**
 * Exchange two entries of a list in place, without reading an index the types call optional.
 * @param list - the list to change.
 * @param first - one index inside the list.
 * @param second - the other index inside the list; it may equal `first`.
 */
function swapEntries(list: string[], first: number, second: number): void {
  list.splice(first, 1, ...list.splice(second, 1, ...list.slice(first, first + 1)))
}

/**
 * Strip the secrets from a record.
 * @param record - the saved account.
 * @returns the view a tool result may carry.
 */
export function credentialView(record: SiteCredentialRecord): CredentialView {
  return {
    id: record.id,
    host: record.host,
    username: record.username,
    ...record.label === undefined ? {} : { label: record.label },
    createdAt: record.createdAt,
    ...record.lastUsedAt === undefined ? {} : { lastUsedAt: record.lastUsedAt },
    ...record.replacedAt === undefined ? {} : { replacedAt: record.replacedAt },
  }
}

/**
 * Quote one CSV field the way Chrome's importer reads it.
 * @param value - the raw field.
 * @returns the field, quoted when it holds a comma, quote, or line break.
 */
function csvField(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/**
 * The owner-only file of saved site accounts. Writes are serialised and atomic
 * (temporary file, then rename), the file is mode `0600` in a `0700`
 * directory, and a file this version does not understand is refused instead of
 * replaced, so a downgrade cannot erase passwords.
 */
export class CredentialVault {
  readonly #path: string
  readonly #now: () => Date
  #queue: Promise<unknown> = Promise.resolve()

  /**
   * @param path - JSON file that keeps the records.
   * @param now - clock, replaceable in tests.
   */
  constructor(path: string, now: () => Date = () => new Date()) {
    this.#path = path
    this.#now = now
  }

  /** Path of the file, for the owner's documentation and the log. */
  get path(): string {
    return this.#path
  }

  /**
   * Every saved account without its secrets, newest first.
   * @returns the views.
   */
  async list(): Promise<CredentialView[]> {
    const file = await this.#read()
    return file.entries.map(credentialView).reverse()
  }

  /**
   * Generate and save a password for a new account on a host.
   * @param request - host, login name, and generation options.
   * @returns the saved record, password included, for the session to write into the page.
   * @throws CredentialError - when the host already has this login name and `replace` is not set.
   */
  async create(request: CredentialCreateRequest): Promise<SiteCredentialRecord> {
    const host = credentialHost(request.host)
    const username = request.username.trim()
    if (username === '') throw new CredentialError('give the login name (usually the e-mail address) the account is created with')
    return await this.#update((entries) => {
      const index = entries.findIndex(entry => entry.host === host && entry.username.toLowerCase() === username.toLowerCase())
      const now = this.#now().toISOString()
      const password = generatePassword(request.length, request.symbols ?? true)
      // An index of -1 reads nothing, so `existing` is set exactly when the login is saved.
      const existing = entries[index]
      if (existing !== undefined) {
        if (request.replace !== true) {
          throw new CredentialError(`${host} already has a saved password for ${username} (${existing.id}); write the saved one with action fill (a sign-up form takes it too, with confirmSelector), or pass replace: true only on the site's own new-password or reset form`)
        }
        const replaced: SiteCredentialRecord = {
          ...existing,
          password,
          previousPassword: existing.password,
          replacedAt: now,
          ...request.label === undefined ? {} : { label: request.label },
        }
        entries[index] = replaced
        return replaced
      }
      const record: SiteCredentialRecord = {
        id: `c${randomBytes(6).toString('hex')}`,
        host,
        username,
        password,
        ...request.label === undefined || request.label.trim() === '' ? {} : { label: request.label.trim() },
        createdAt: now,
      }
      entries.push(record)
      return record
    })
  }

  /**
   * The one saved account for a host, password included.
   * @param host - the page host.
   * @param username - login name, needed only when the host has more than one account.
   * @returns the record.
   * @throws CredentialError - when the host has no account, or several and no login name chose one.
   */
  async find(host: string, username?: string): Promise<SiteCredentialRecord> {
    const bare = credentialHost(host)
    const file = await this.#read()
    const onHost = file.entries.filter(entry => entry.host === bare)
    const matches = username === undefined
      ? onHost
      : onHost.filter(entry => entry.username.toLowerCase() === username.trim().toLowerCase())
    const [only, ...others] = matches
    if (only !== undefined && others.length === 0) return only
    if (onHost.length === 0) {
      throw new CredentialError(`no saved password for ${bare}; on the site's sign-up form use action create, or hand over if the account was made outside this browser`)
    }
    // Without a login name every account on the host matches, so only a named login can match none.
    if (username !== undefined && matches.length === 0) throw new CredentialError(`${bare} has no saved password for ${username}; saved login names: ${onHost.map(entry => entry.username).join(', ')}`)
    throw new CredentialError(`${bare} has ${String(matches.length)} saved accounts; pass username: ${onHost.map(entry => entry.username).join(' | ')}`)
  }

  /**
   * Record that a password was written into a page.
   * @param id - the record.
   */
  async touch(id: string): Promise<void> {
    await this.#update((entries) => {
      const index = entries.findIndex(entry => entry.id === id)
      const entry = entries[index]
      if (entry !== undefined) entries[index] = { ...entry, lastUsedAt: this.#now().toISOString() }
    })
  }

  /**
   * Delete one record; the owner's operation, not the model's.
   * @param id - the record.
   * @returns whether a record was removed.
   */
  async remove(id: string): Promise<boolean> {
    return await this.#update((entries) => {
      const index = entries.findIndex(entry => entry.id === id)
      if (index < 0) return false
      entries.splice(index, 1)
      return true
    })
  }

  /**
   * Every account as the CSV Chrome's password manager imports
   * (`name,url,username,password,note`), for the owner-only export route.
   * @returns the CSV text.
   */
  async exportCsv(): Promise<string> {
    const file = await this.#read()
    const rows = [['name', 'url', 'username', 'password', 'note']]
    for (const entry of file.entries) {
      const note = [entry.label, `saved by DSH ${entry.createdAt}`, entry.previousPassword === undefined ? undefined : `previous password ${entry.previousPassword}`]
        .filter(part => part !== undefined)
        .join('; ')
      rows.push([entry.label ?? entry.host, `https://${entry.host}/`, entry.username, entry.password, note])
    }
    return `${rows.map(row => row.map(csvField).join(',')).join('\r\n')}\r\n`
  }

  async #read(): Promise<CredentialFile> {
    let text: string
    try {
      text = await readFile(this.#path, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: FILE_VERSION, entries: [] }
      throw error
    }
    const parsed = JSON.parse(text) as Partial<CredentialFile>
    if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.entries)) {
      throw new Error(`${this.#path} is not a version ${String(FILE_VERSION)} credential file; refusing to read or overwrite it`)
    }
    return { version: FILE_VERSION, entries: parsed.entries }
  }

  async #update<T>(change: (entries: SiteCredentialRecord[]) => T): Promise<T> {
    const run = this.#queue.then(async () => {
      const file = await this.#read()
      const entries = [...file.entries]
      const result = change(entries)
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 })
      const temporary = `${this.#path}.${randomBytes(4).toString('hex')}.tmp`
      await writeFile(temporary, `${JSON.stringify({ version: FILE_VERSION, entries }, null, 2)}\n`, { mode: 0o600 })
      // writeFile's mode only applies to a new file; a stale temporary name never exists, but keep the file 0600 regardless.
      await chmod(temporary, 0o600)
      await rename(temporary, this.#path)
      return result
    })
    this.#queue = run.catch(() => undefined)
    return await run
  }
}
