/** Which build of the event service is running, from where its entry file lives. */

import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Version and build sha of the running service; null for what cannot be told (a source checkout has no sha). */
export interface BuildInfo {
  readonly version: string | null
  readonly sha: string | null
}

const BUILD_DIR = /\/builds\.noindex\/([0-9a-f]{7,40})(?:\/|$)/
const MAX_LEVELS = 8

/**
 * Read the build identity of the process.
 * `upgrade.sh` installs each build under `builds.noindex/<sha>`, so the resolved entry path names the sha; the version is the
 * `@deepseek-ai/dsh` package above the entry file.
 * @param entry - the entry file of the process; defaults to `process.argv[1]`.
 * @returns the version and sha, each null when not found.
 */
export function readBuildInfo(entry: string | undefined = process.argv[1]): BuildInfo {
  if (entry === undefined) return { version: null, sha: null }
  let resolved: string
  try {
    resolved = realpathSync(entry)
  } catch {
    return { version: null, sha: null }
  }
  const sha = BUILD_DIR.exec(resolved)?.[1] ?? null
  let dir = dirname(resolved)
  for (let level = 0; level < MAX_LEVELS; level++) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
      if (manifest.name === '@deepseek-ai/dsh' && typeof manifest.version === 'string') return { version: manifest.version, sha }
    } catch {
      // No manifest at this level: keep climbing.
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { version: null, sha }
}
