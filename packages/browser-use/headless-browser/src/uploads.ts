/**
 * Which local files the agent may attach to a page's file input. A page can
 * ask for anything — "attach your SSH key to verify" — so the browser only
 * attaches regular files that live inside the configured upload directories,
 * resolved through symlinks first so a link cannot point the upload outside
 * them. The owner puts the files a task needs (a résumé, a transcript, a
 * generated letter) into one of those directories.
 *
 * @module @deepseek-ai/dsh-headless-browser/uploads
 */

import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Most files one upload call attaches. */
export const MAX_UPLOAD_FILES = 10

/** One file cleared for upload. */
export interface UploadFile {
  /** Resolved absolute path, symlinks followed. */
  readonly path: string
  /** Base name the page sees. */
  readonly name: string
  /** Size in bytes. */
  readonly bytes: number
}

/** A refusal the model can act on: a file outside the allowed directories, missing, or too big. */
export class UploadRefusedError extends Error {
  override readonly name = 'UploadRefusedError'
}

/**
 * Whether one resolved path sits inside one resolved directory.
 * @param directory - the allowed directory, resolved.
 * @param path - the file, resolved.
 * @returns true when the file is the directory's descendant.
 */
function inside(directory: string, path: string): boolean {
  const rel = relative(directory, path)
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
}

/** The upload directories and the size cap. */
export class UploadPolicy {
  readonly #dirs: readonly string[]
  readonly #maxBytes: number

  /**
   * @param dirs - directories whose files may be attached; the first one resolves bare names.
   * @param maxMB - largest file, in megabytes.
   */
  constructor(dirs: readonly string[], maxMB: number) {
    this.#dirs = dirs.map(dir => resolve(dir))
    this.#maxBytes = maxMB * 1024 * 1024
  }

  /** The directories, for an error message and the documentation. */
  get dirs(): readonly string[] {
    return this.#dirs
  }

  /**
   * Resolve the files one call names and refuse any that may not be attached.
   * A bare name (no separator) is looked up in the first directory.
   * @param files - absolute paths, or bare names in the first upload directory.
   * @returns the files, in the order given.
   * @throws UploadRefusedError - when a file is outside every directory, is not a regular file, or is too big.
   */
  async resolve(files: readonly string[]): Promise<UploadFile[]> {
    if (files.length === 0) throw new UploadRefusedError('name at least one file to attach')
    if (files.length > MAX_UPLOAD_FILES) throw new UploadRefusedError(`attach at most ${String(MAX_UPLOAD_FILES)} files per call`)
    if (this.#dirs.length === 0) throw new UploadRefusedError('no upload directory is configured (uploadDirs), so no file may be attached')
    const roots = await Promise.all(this.#dirs.map(async dir => await realpath(dir).catch(() => dir)))
    const out: UploadFile[] = []
    for (const file of files) {
      const named = !file.includes('/') && !file.includes('\\') ? join(this.#dirs[0]!, file) : resolve(file)
      let real: string
      try {
        real = await realpath(named)
      } catch {
        throw new UploadRefusedError(`${file} does not exist; files that may be attached live in ${this.#dirs.join(', ')}`)
      }
      if (!roots.some(root => inside(root, real))) {
        throw new UploadRefusedError(`${file} is outside the upload directories (${this.#dirs.join(', ')}); copy the file there first`)
      }
      const info = await stat(real)
      if (!info.isFile()) throw new UploadRefusedError(`${file} is not a regular file`)
      if (info.size > this.#maxBytes) {
        throw new UploadRefusedError(`${file} is ${String(Math.ceil(info.size / 1024 / 1024))} MB, over the ${String(this.#maxBytes / 1024 / 1024)} MB upload limit`)
      }
      out.push({ path: real, name: basename(real), bytes: info.size })
    }
    return out
  }
}
