/** Opt-in interception of `open` and `readlink` from node:fs/promises, for specs that inject races and I/O failures. */
import type { FileHandle } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'

type Fs = typeof FsPromises

/** Hooks owned by one spec; each receives the real operation and decides whether and when to run it. */
export interface FsHooks {
  open?: ((path: string, flags: string | number | undefined, open: () => Promise<FileHandle>) => Promise<FileHandle>) | undefined
  readlink?: ((path: string, readlink: () => Promise<string>) => Promise<string>) | undefined
}

/**
 * Build the module a spec's `vi.mock('node:fs/promises')` factory returns: every export is real, and `open` and
 * `readlink` consult the spec's hooks first.
 * @param actual - the real node:fs/promises module.
 * @param hooks - the calling spec's hooks; unset hooks pass through.
 * @returns the hooked module.
 */
export function hookedFs(actual: Fs, hooks: FsHooks): Fs {
  const open: Fs['open'] = async (path, flags, mode) => {
    const real = () => actual.open(path, flags, mode)
    return hooks.open === undefined ? real() : hooks.open(String(path), flags, real)
  }
  const readlink = (async (path: string) => {
    const real = () => actual.readlink(path)
    return hooks.readlink === undefined ? real() : hooks.readlink(path, real)
  }) as Fs['readlink']
  return { ...actual, open, readlink }
}
