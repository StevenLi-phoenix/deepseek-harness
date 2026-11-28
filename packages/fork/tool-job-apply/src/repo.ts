/** Filesystem and Git operations for one deployment-owned, ordinary job-tracking clone. */
import { constants, lstatSync, renameSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, rmdir, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { TextDecoder } from 'node:util'

const ORIGIN = 'https://github.com/StevenLi-phoenix/jobapplication.git'
const MAIN = 'refs/heads/main'
const MAX_LINES = 400
const MAX_SCAN = 1024 * 1024
const MAX_RESULT = 64 * 1024
const MAX_COMMIT_PATHS = 100
const MAX_PATH_LENGTH = 240
const MAX_LOG_BYTES = 2048
const MAX_WRITE_BYTES = 64 * 1024
const NON_TEXT = /[^\P{Cc}\t\n\r]/u
const EDIT_FILE_LIMIT = 'Targeted edits limit both the original and resulting file to 1 MiB.'
type TargetedEdit = { kind: 'append'; text: string } | { kind: 'replace'; oldText: string; text: string }
type DocumentEdit = { kind: 'write'; text: string } | TargetedEdit
const CLONE_KEYS = new Set([
  'core.repositoryformatversion', 'core.filemode', 'core.bare', 'core.logallrefupdates',
  'core.ignorecase', 'core.precomposeunicode', 'core.symlinks', 'core.autocrlf',
  'core.eol', 'core.safecrlf', 'core.hookspath', 'core.fsmonitor',
  'remote.origin.url', 'remote.origin.pushurl', 'remote.origin.fetch',
  'branch.main.remote', 'branch.main.merge', 'user.name', 'user.email',
])
const BRANCH_TRACKING = /^branch\.[^\s]+\.(?:remote|merge)$/u
const GIT_OPTIONS = [
  '--no-pager', '--literal-pathspecs',
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
  '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'commit.gpgsign=false',
  '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
  '-c', `http.${ORIGIN}.followRedirects=false`, '-c', `http.${ORIGIN}.sslVerify=true`,
] as const

/** Runs fixed argv directly (without a shell), with trusted Git environment, bounded output and cancellation. */
export type CommandRunner = (file: 'git' | 'gh', args: readonly string[], signal: AbortSignal) => Promise<string>

/**
 * Accepts ordinary one-line prose, not obvious shell syntax or local-path instructions.
 * This is input hygiene, not a substitute for fixed argv or an independent content policy.
 * @param value Proposed text.
 * @param field Trusted name for validation errors.
 * @param max Maximum UTF-8 byte length.
 * @returns Trimmed plain text, or throws if invalid.
 */
export function validateText(value: string, field: string, max: number): string {
  const text = value.trim()
  const localPath = /(?:^|[\s('"\[=])(?:file:\/\/|~[\\/]|\.\.?[\\/]|\/[\p{L}\p{N}_.~/-]|[a-z]:[\\/]|\\\\)/iu
  const shellSyntax = /[|<>`\\]|&&|\$[({a-z_]|(?:^|\s)#!/iu
  const shellCommand = 'sudo|sh|bash|zsh|fish|csh|ksh|cmd(?:\\.exe)?|powershell|pwsh|curl|wget|chmod|chown|rm|npx|python[23]?|perl|osascript|eval|exec'
  const instruction = 'following\\s+commands?|(?:shell|terminal)(?:\\s+(?:command|script))?'
  const executable = new RegExp(`(?:^|[;&]\\s*)(?:(?:please|then|now)\\s+)*(?:${[
    `(?:${shellCommand})(?=\\s|$)`,
    `(?:run|execute|invoke|launch)\\s+(?:the\\s+|a\\s+)?(?:${shellCommand}|${instruction})\\b`,
    'git\\s+(?:push|pull|reset|checkout|clean|rebase|config)\\b',
  ].join('|')})`, 'iu')
  const commandTail = /[;&]\s*(?:echo|printf|cat|mv|cp|touch|source|cd)(?=\s|$)/iu
  if (!text || Buffer.byteLength(value) > max || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
    || shellSyntax.test(text) || localPath.test(text) || executable.test(text) || commandTail.test(text)) {
    throw new Error(`${field} must be one line of plain text (maximum ${max} UTF-8 bytes, no commands or local paths).`)
  }
  return text
}

function pathParts(path: string): string[] | undefined {
  if (path.length > MAX_PATH_LENGTH) return undefined
  const parts = path.split('/')
  if (parts.some((part, i) => (i !== 0 || part !== '.agents') && (
    !/^[A-Za-z0-9_]/.test(part) || /[^A-Za-z0-9_ .()-]/.test(part) || /[ .]$/.test(part)
  ))) return undefined
  return parts
}

function canWrite(parts: readonly string[]): boolean {
  return parts.length === 1 && (parts[0] === 'TODO.md' || parts[0] === 'answers.md')
    || parts.length > 1 && (parts[0] === 'logs' || parts[0] === 'cover_letters')
}

function canRead(parts: readonly string[]): boolean {
  return canWrite(parts) || parts.length === 1 && (parts[0] === 'SKILL.md' || parts[0]?.startsWith('jobtracker') === true)
    || parts.length === 2 && ((parts[0] === 'references' && parts[1]?.endsWith('.md') === true)
      || (parts[0] === 'private' && parts[1] === 'resume.txt'))
    || parts.length >= 4 && parts[0] === '.agents' && parts[1] === 'skills' && parts[2] === 'job-apply'
}

function sameFile(expected: Stats, actual: Stats): boolean {
  return expected.dev === actual.dev && expected.ino === actual.ino
}

function regularFile(stat: Stats | undefined): stat is Stats {
  return stat?.isFile() === true && stat.nlink === 1
}

function sameVersion(expected: Stats, actual: Stats | undefined): boolean {
  return regularFile(actual) && sameFile(expected, actual) && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs && expected.ctimeMs === actual.ctimeMs
}

function validateWriteText(text: string): void {
  if (Buffer.byteLength(text) > MAX_WRITE_BYTES || NON_TEXT.test(text) || /\p{Cs}/u.test(text)) {
    throw new Error('Repository writes accept UTF-8 text up to 64 KiB, without binary control bytes.')
  }
}

function editText(edit: TargetedEdit, current: string): string {
  if (edit.kind === 'append') {
    const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n'
    const terminator = edit.text.endsWith('\n') ? '' : '\n'
    return current + separator + edit.text + terminator
  }
  const start = current.indexOf(edit.oldText)
  if (start === -1) throw new Error('Replace requires exactly one literal match; found none.')
  if (current.indexOf(edit.oldText, start + 1) !== -1) throw new Error('Replace requires exactly one literal match; found more than one.')
  return current.slice(0, start) + edit.text + current.slice(start + edit.oldText.length)
}

async function inspect(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

function nulRecords(output: string): string[] {
  if (output === '') return []
  if (!output.endsWith('\0')) throw new Error('Git returned an incomplete record.')
  return output.slice(0, -1).split('\0')
}

async function readAtMost(handle: FileHandle): Promise<Buffer> {
  const buffer = Buffer.alloc(MAX_SCAN + 1)
  let end = 0
  while (end < buffer.length) {
    const { bytesRead } = await handle.read(buffer, end, buffer.length - end, end)
    if (bytesRead === 0) break
    end += bytesRead
  }
  return buffer.subarray(0, end)
}

function sliceLines(buffer: Buffer, start: number, limit: number): string {
  const capped = buffer.length > MAX_SCAN
  const scanned = buffer.subarray(0, MAX_SCAN)
  let offset = 0
  for (let row = 1; row < start; row += 1) {
    const newline = scanned.indexOf(10, offset)
    if (newline === -1) {
      if (capped) throw new Error(`Requested line is beyond the ${MAX_SCAN}-byte read window.`)
      return ''
    }
    offset = newline + 1
  }
  if (offset === scanned.length && capped) throw new Error(`Requested line is beyond the ${MAX_SCAN}-byte read window.`)
  let end = offset
  let truncatedByScan = false
  for (let row = 0; row < limit && end < scanned.length; row += 1) {
    const newline = scanned.indexOf(10, end)
    end = newline === -1 ? scanned.length : newline + 1
    if (capped && end === scanned.length && (newline === -1 || row + 1 < limit)) truncatedByScan = true
  }
  const truncated = end - offset > MAX_RESULT || truncatedByScan
  const note = truncated ? '\n[Read truncated by the byte limit.]' : ''
  const text = new TextDecoder('utf-8', { fatal: true }).decode(
    scanned.subarray(offset, Math.min(end, offset + MAX_RESULT - Buffer.byteLength(note))),
    { stream: truncated },
  )
  if (NON_TEXT.test(text)) throw new Error('Repository file contains non-text bytes.')
  return text + note
}

/**
 * Operates inside a canonical, deployment-controlled clone. Callers serialize operations;
 * other processes must not replace its root, path parents, or Git metadata during an operation.
 */
export class JobRepository {
  readonly #root: string
  readonly #run: CommandRunner

  constructor(root: string, run: CommandRunner) {
    if (!isAbsolute(root) || resolve(root) !== root) throw new Error('The job repository root must be an absolute normalized path.')
    this.#root = root
    this.#run = run
  }

  async #rootStat(): Promise<Stats> {
    const root = await lstat(this.#root)
    if (!root.isDirectory() || await realpath(this.#root) !== this.#root) {
      throw new Error('The job repository root must be a canonical directory, not a symlink.')
    }
    return root
  }

  async #parents(parts: readonly string[], expectedRoot: Stats, create = false): Promise<string> {
    if (!sameFile(expectedRoot, await this.#rootStat())) throw new Error('The job repository root changed during the operation.')
    let parent = this.#root
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part)
      if (create && await inspect(parent) === undefined) await mkdir(parent, { mode: 0o700 })
      if (!(await inspect(parent))?.isDirectory() || await realpath(parent) !== parent) {
        throw new Error('Repository path parents must be real directories within the clone.')
      }
    }
    return parent
  }

  async #verifyOpen(handle: FileHandle, path: string, parts: readonly string[], root: Stats): Promise<Stats> {
    await this.#parents(parts, root)
    const opened = await handle.stat()
    const current = await inspect(path)
    if (!regularFile(opened) || !regularFile(current) || !sameFile(opened, current) || await realpath(path) !== path) {
      throw new Error('Repository file must be a regular file with no links.')
    }
    return opened
  }

  /**
   * Reads one allowlisted regular UTF-8 file without following symlinks.
   * @param path Slash-separated path relative to the repository root.
   * @param start First line number (one-based).
   * @param limit Maximum lines to return, up to 400.
   * @returns File text in the requested window, bounded to 64 KiB.
   */
  async read(path: string, start = 1, limit = MAX_LINES): Promise<string> {
    const parts = pathParts(path)
    if (!parts || !canRead(parts)) throw new Error('This repository path is not readable by the job tool.')
    if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LINES) {
      throw new Error('Start must be a positive line number and limit must be from 1 through 400.')
    }
    const root = await this.#rootStat()
    await this.#parents(parts, root)
    const file = join(this.#root, path)
    if (!regularFile(await inspect(file))) throw new Error('Repository file must be a regular file with no links.')
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      await this.#verifyOpen(handle, file, parts, root)
      return sliceLines(await readAtMost(handle), start, limit)
    } finally {
      await handle.close()
    }
  }

  /**
   * Replace one bounded UTF-8 text document atomically inside allowlisted repository directories.
   * @param path Relative destination path, never a symlink or hardlink.
   * @param text Complete file content, including any requested final newline.
   * @returns The written relative path.
   */
  async write(path: string, text: string): Promise<string> {
    return this.#edit(path, { kind: 'write', text })
  }

  /**
   * Append complete lines atomically, creating the file if needed and adding missing LF separators.
   * @param path Allowlisted relative text path.
   * @param text Nonempty text up to 64 KiB; preserves supplied line breaks.
   * @returns The written relative path. The original and resulting files are limited to 1 MiB.
   */
  async append(path: string, text: string): Promise<string> {
    return this.#edit(path, { kind: 'append', text })
  }

  /**
   * Replace exactly one literal occurrence in an existing file, or leave the file unchanged.
   * @param path Allowlisted relative text path.
   * @param oldText Nonempty literal text up to 64 KiB that must occur exactly once.
   * @param text Literal replacement up to 64 KiB; empty text removes the match.
   * @returns The written relative path. The original and resulting files are limited to 1 MiB.
   */
  async replace(path: string, oldText: string, text: string): Promise<string> {
    return this.#edit(path, { kind: 'replace', oldText, text })
  }

  async #readForEdit(file: string, parts: readonly string[], root: Stats, existing: Stats): Promise<string> {
    if (existing.size > MAX_SCAN) throw new Error(EDIT_FILE_LIMIT)
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const opened = await this.#verifyOpen(handle, file, parts, root)
      if (!sameVersion(existing, opened)) throw new Error('Repository output changed while writing. Read it again before retrying.')
      const bytes = await readAtMost(handle)
      if (bytes.length > MAX_SCAN) throw new Error(EDIT_FILE_LIMIT)
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      } catch (error) {
        throw new Error('Targeted edits require valid UTF-8 text.', { cause: error })
      }
      if (NON_TEXT.test(text)) throw new Error('Targeted edits require UTF-8 text without binary control bytes.')
      return text
    } finally {
      await handle.close()
    }
  }

  async #edit(path: string, edit: DocumentEdit): Promise<string> {
    const parts = pathParts(path)
    if (!parts || !canWrite(parts)) throw new Error('This repository path is not writable by the job tool.')
    if (parts[0] === 'cover_letters' && !/\.md$/u.test(path)) throw new Error('Write a Markdown cover letter, then use the scoped converter for a document.')
    validateWriteText(edit.text)
    if (edit.kind === 'append' && edit.text === '') throw new Error('Append requires nonempty text.')
    if (edit.kind === 'replace') {
      if (edit.oldText === '') throw new Error('Replace requires nonempty oldText.')
      validateWriteText(edit.oldText)
    }
    const root = await this.#rootStat()
    const parent = await this.#parents(parts, root, edit.kind !== 'replace')
    const file = join(this.#root, path)
    const existing = await inspect(file)
    if (existing !== undefined && (!regularFile(existing) || await realpath(file) !== file)) {
      throw new Error('Repository output must be a regular file with no links.')
    }
    let text = edit.text
    if (edit.kind !== 'write') {
      if (edit.kind === 'replace' && existing === undefined) throw new Error('Replace requires an existing file.')
      text = editText(edit, existing === undefined ? '' : await this.#readForEdit(file, parts, root, existing))
      if (Buffer.byteLength(text) > MAX_SCAN) throw new Error(EDIT_FILE_LIMIT)
    }
    const tmp = await mkdtemp(join(parent, '.dsh-write-'))
    const data = join(tmp, 'text')
    let staged = false
    try {
      const handle = await open(data, 'wx', 0o600)
      staged = true
      try {
        await handle.writeFile(text, 'utf8')
        if (edit.kind !== 'write' && existing !== undefined) await handle.chmod(existing.mode & 0o777)
      } finally {
        await handle.close()
      }
      await this.#parents(parts, root)
      // Keep the final check and rename in one JS turn across preset mounts in this Host.
      const current = lstatSync(file, { throwIfNoEntry: false })
      if (existing === undefined ? current !== undefined : !sameVersion(existing, current)) {
        throw new Error('Repository output changed while writing. Read it again before retrying.')
      }
      renameSync(data, file)
      staged = false
    } finally {
      try { if (staged) await unlink(data) } finally { await rmdir(tmp) }
    }
    return path
  }

  /**
   * Appends one validated line to today's log in the server's local timezone.
   * @param text Plain log message.
   * @returns The repository-relative path of the log.
   */
  async log(text: string): Promise<string> {
    const line = validateText(text, 'Log message', MAX_LOG_BYTES)
    const root = await this.#rootStat()
    const now = new Date()
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const name = `${day}.log`
    const parts = ['logs', name]
    const logs = join(this.#root, 'logs')
    if (await inspect(logs) === undefined) await mkdir(logs, { mode: 0o700 })
    await this.#parents(parts, root)
    const path = join(logs, name)
    const existing = await inspect(path)
    if (existing && !regularFile(existing)) throw new Error('Daily log must be a regular file with no links.')
    const create = existing ? 0 : constants.O_CREAT | constants.O_EXCL
    const handle = await open(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK | create, 0o600)
    try {
      const stat = await this.#verifyOpen(handle, path, parts, root)
      if (stat.size > 0) {
        const last = Buffer.alloc(1)
        const { bytesRead } = await handle.read(last, 0, 1, stat.size - 1)
        if (bytesRead !== 1 || last[0] !== 10) throw new Error('The daily log does not end in a complete line.')
      }
      await handle.writeFile(`${line}\n`, 'utf-8')
    } finally {
      await handle.close()
    }
    return parts.join('/')
  }

  #git(args: readonly string[], signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    return this.#run('git', [...GIT_OPTIONS, `--git-dir=${join(this.#root, '.git')}`, `--work-tree=${this.#root}`, '-C', this.#root, ...args], signal)
  }

  async #checkClone(root: Stats, signal: AbortSignal): Promise<void> {
    const configParts = ['.git', 'config']
    const dotGit = await this.#parents(configParts, root)
    if (!regularFile(await inspect(join(dotGit, 'config'))) || await inspect(join(dotGit, 'commondir'))) {
      throw new Error('Git operations require an ordinary clone with its own regular local config.')
    }
    const list = ['config', '--null', '--name-only', '--list']
    const local = nulRecords(await this.#git([...list, '--local', '--no-includes'], signal))
    // Upstream tracking of other local branches (follow-up PR branches) runs nothing, so it is not a reason to refuse.
    if (local.some(key => !CLONE_KEYS.has(key) && !BRANCH_TRACKING.test(key))) throw new Error('The clone has unsupported local Git configuration.')
    const effective = nulRecords(await this.#git(list, signal))
    const executableConfig = [
      /^filter\./i, /^merge\..+\.driver$/i, /^url\..+\.(?:insteadof|pushinsteadof)$/i, /^remote\..+\.(?:vcs|receivepack|uploadpack)$/i,
    ]
    if (effective.some(key => executableConfig.some(pattern => pattern.test(key)))) {
      throw new Error('Git filters, custom merge drivers, remote helpers, and URL rewrites are not supported.')
    }
  }

  async #status(signal: AbortSignal): Promise<Array<{ path: string; state: string }>> {
    const output = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=all'], signal)
    return nulRecords(output).flatMap((record) => {
      const state = record.slice(0, 2)
      const path = record.slice(3)
      if (!/^[ MADCTU?!]{2}$/.test(state) || record[2] !== ' ') throw new Error('Git returned an unexpected status record.')
      const parts = pathParts(path)
      return parts && canWrite(parts) ? [{ path, state }] : []
    })
  }

  async #commit(root: Stats, message: string, paths: readonly string[] | undefined, signal: AbortSignal): Promise<string> {
    const changes = await this.#status(signal)
    const stateOf = new Map(changes.map(({ path, state }) => [path, state]))
    const selected = [...new Set(paths ?? changes.map(({ path }) => path))]
    if (selected.length === 0 || selected.length > MAX_COMMIT_PATHS) {
      throw new Error(`A job commit needs 1 through ${MAX_COMMIT_PATHS} changed repository paths.`)
    }
    const commitPaths: string[] = []
    const untracked: string[] = []
    for (const path of selected) {
      const parts = pathParts(path)
      const state = stateOf.get(path)
      if (!parts || !canWrite(parts) || !state) throw new Error('Commit paths must be changed, allowlisted files in the clone.')
      await this.#parents(parts, root)
      const file = join(this.#root, path)
      if (!regularFile(await inspect(file)) || await realpath(file) !== file) {
        if (!paths) continue
        throw new Error('Commit paths must be existing regular files with no links.')
      }
      commitPaths.push(path)
      if (state === '??') untracked.push(path)
    }
    if (commitPaths.length === 0) throw new Error('No changed, allowlisted regular files to commit.')
    // Intent-to-add admits explicitly selected new files without staging their contents.
    if (untracked.length > 0) await this.#git(['add', '--intent-to-add', '--', ...untracked], signal)
    // --only builds the commit from these working-tree paths, never the rest of the index.
    return this.#git(['commit', '--only', '--no-verify', '--no-gpg-sign', '--cleanup=verbatim', `--message=${message}`, '--', ...commitPaths], signal)
  }

  /**
   * Runs a fixed job repository operation. Network operations require the exact pinned origin.
   * @param operation Git operation to perform.
   * @param message Commit message; omit for other operations.
   * @param paths Exact allowlisted paths for commits; omit to use eligible changed files.
   * @param signal Cancellation signal for child processes.
   * @returns Git output, or a status listing limited to job-tracking paths.
   */
  async git(operation: 'pull' | 'commit' | 'push' | 'status', message: string | undefined, paths: string[] | undefined, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    if (operation !== 'commit' && (message !== undefined || paths !== undefined)) throw new Error('Only commit accepts a message or paths.')
    if (operation === 'commit' && message === undefined) throw new Error('A commit message is required.')
    const cleanMessage = message === undefined ? undefined : validateText(message, 'Commit message', 300)
    if (paths && (paths.length === 0 || paths.length > MAX_COMMIT_PATHS || paths.some((path) => {
      const parts = pathParts(path)
      return !parts || !canWrite(parts)
    }))) throw new Error('Commit paths must contain 1 through 100 allowlisted relative file paths.')
    const root = await this.#rootStat()
    await this.#checkClone(root, signal)
    if (operation === 'status') {
      const changes = await this.#status(signal)
      return changes.map(({ path, state }) => `${state} ${path}`).join('\n') || 'No job-tracking changes.'
    }
    if (await this.#git(['symbolic-ref', '--quiet', 'HEAD'], signal) !== `${MAIN}\n`) {
      throw new Error('The job repository must be on the local main branch.')
    }
    if (operation === 'commit' && cleanMessage !== undefined) return this.#commit(root, cleanMessage, paths, signal)
    if (await this.#git(['remote', 'get-url', '--all', 'origin'], signal) !== `${ORIGIN}\n`
      || await this.#git(['remote', 'get-url', '--push', '--all', 'origin'], signal) !== `${ORIGIN}\n`) {
      throw new Error('Git origin does not match the one configured job repository over HTTPS.')
    }
    switch (operation) {
      case 'pull':
        // Other devices push to main while a run holds local commits, so a fast-forward-only pull would strand the
        // run's pushes. Rebase the local commits (autostash keeps parallel workers' uncommitted edits) and abort a
        // conflicting rebase so the clone never stays mid-rebase.
        try {
          return await this.#git(['pull', '--rebase', '--autostash', '--no-tags', '--no-recurse-submodules', '--', ORIGIN, MAIN], signal)
        } catch (error) {
          await this.#git(['rebase', '--abort'], signal).catch(() => undefined)
          throw error
        }
      case 'push':
        return this.#git(['push', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', '--', ORIGIN, `${MAIN}:${MAIN}`], signal)
      default:
        throw new Error('Unsupported job repository operation.')
    }
  }
}
