/**
 * Files in and out of mail. A file to attach must resolve (symbolic links followed) to a regular file inside the
 * Session's working directory or the system temporary directory, outside every hidden directory but the download
 * directory, and its name must not look like a key or a credential; so a message cannot carry `~/.dsh/.env`, an SSH
 * key, or a token file away. A received attachment is saved under `<cwd>/.gmail-inbox/` (directory 0700, files 0600,
 * ignored by git) with a name of its own.
 */

import { constants } from 'node:fs'
import { mkdir, open, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Attachment } from './mime.ts'

/** Directory under the working directory that received attachments go to. */
export const INBOX_DIR = '.gmail-inbox'

/** A refused attachment path, worded for the model. */
export class AttachmentProblem extends Error {}

/** File names that look like a secret: keys, certificates, credential stores, tokens, and SSH identities. */
const SECRET_NAMES: readonly RegExp[] = [
  /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc|ovpn)$/iu,
  /credential|secret|token|passw(?:or)?d|\.netrc|\.npmrc/iu,
  /^id_(?:rsa|dsa|ecdsa|ed25519)/iu,
]

/** Media types by extension, for the attachment's `Content-Type`; anything else is `application/octet-stream`. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.html': 'text/html', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic', '.svg': 'image/svg+xml',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.ics': 'text/calendar', '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/**
 * The media type of a file name.
 * @param name - file name.
 * @returns the type by extension.
 */
export function mediaTypeOf(name: string): string {
  return MEDIA_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

/** The root a real path lies in, and the path below it; undefined when it lies in none. */
function within(path: string, roots: readonly string[]): string | undefined {
  for (const root of roots) {
    const rest = relative(root, path)
    if (rest !== '' && !rest.startsWith(`..${sep}`) && rest !== '..' && !isAbsolute(rest)) return rest
  }
  return undefined
}

/** The real path of a directory, or undefined when it does not exist. */
async function realDirectory(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch {
    // ENOENT and the like: a root that does not exist admits nothing.
    return undefined
  }
}

/**
 * Read the files to attach.
 * @param paths - the model's paths, absolute or relative to `cwd`.
 * @param cwd - the Session's working directory.
 * @param maxBytes - most bytes all files together may hold.
 * @returns one attachment per path.
 * @throws AttachmentProblem when a path is outside the allowed directories, hidden, secret-looking, not a regular file, or over the limit.
 */
export async function readAttachments(paths: readonly string[], cwd: string, maxBytes: number): Promise<Attachment[]> {
  const roots = (await Promise.all([realDirectory(cwd), realDirectory(tmpdir())])).filter((root): root is string => root !== undefined)
  const files: Attachment[] = []
  let total = 0
  for (const given of paths) {
    let real: string
    try {
      real = await realpath(resolve(cwd, given))
    } catch {
      // ENOENT, EACCES, ELOOP: the path names nothing that can be read.
      throw new AttachmentProblem(`${given}: no such file`)
    }
    const rest = within(real, roots)
    if (rest === undefined) throw new AttachmentProblem(`${given}: only files inside the working directory or the temporary directory can be attached`)
    const segments = rest.split(sep)
    if (segments.some(segment => segment.startsWith('.') && segment !== INBOX_DIR)) throw new AttachmentProblem(`${given}: files in hidden directories, and hidden files, cannot be attached`)
    const name = basename(real)
    if (SECRET_NAMES.some(pattern => pattern.test(name))) throw new AttachmentProblem(`${given}: the name looks like a key or a credential, which is never attached`)
    const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw new AttachmentProblem(`${given}: not a regular file`)
      total += stat.size
      if (total > maxBytes) throw new AttachmentProblem(`attachments over ${Math.floor(maxBytes / 1_048_576)} MiB together cannot be sent; share a link instead`)
      files.push({ filename: name, contentType: mediaTypeOf(name), data: await handle.readFile() })
    } finally {
      await handle.close()
    }
  }
  return files
}

/**
 * A safe local name for a received file: no directory parts, no control or reserved characters, at most 120 characters.
 * @param name - the name the sender gave.
 * @returns the cleaned name; `attachment` when nothing is left.
 */
export function safeFileName(name: string): string {
  const cleaned = basename(name.replace(/\\/gu, '/')).replace(/[\u0000-\u001F\u007F/:*?"<>|]/gu, '_').replace(/^\.+/u, '').trim()
  const chars = Array.from(cleaned)
  if (chars.length <= 120) return cleaned === '' ? 'attachment' : cleaned
  const extension = extname(cleaned).slice(0, 16)
  return `${chars.slice(0, 120 - extension.length).join('')}${extension}`
}

/**
 * Save a received attachment under `<cwd>/.gmail-inbox/`.
 * @param cwd - the Session's working directory.
 * @param prefix - a short prefix naming the message, so files of different messages never collide.
 * @param name - the sender's file name.
 * @param data - the bytes.
 * @returns the absolute path written.
 */
export async function saveAttachment(cwd: string, prefix: string, name: string, data: Uint8Array): Promise<string> {
  const directory = join(cwd, INBOX_DIR)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(directory, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  })
  const file = safeFileName(name)
  const extension = extname(file)
  const stem = file.slice(0, file.length - extension.length)
  for (let copy = 0; ; copy++) {
    const path = join(directory, `${prefix}-${stem}${copy === 0 ? '' : `-${copy}`}${extension}`)
    let handle
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    try {
      await handle.writeFile(data)
    } finally {
      await handle.close()
    }
    return path
  }
}
