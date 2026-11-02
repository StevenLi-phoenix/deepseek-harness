/** The small file helpers of the state directory. */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${String(process.pid)}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

/** The SHA the memory history last recorded for the memory file, if there is a history. */
export async function lastHistorySha(memoryFile: string): Promise<string | undefined> {
  try {
    const lines = (await readFile(join(dirname(memoryFile), 'memory.history.jsonl'), 'utf8')).split('\n').filter(line => line.trim() !== '')
    for (const line of lines.toReversed()) {
      try {
        const sha = (JSON.parse(line) as { sha?: unknown }).sha
        if (typeof sha === 'string') return sha
      } catch {
        // A torn line is skipped.
      }
    }
  } catch {
    // No history yet.
  }
  return undefined
}
