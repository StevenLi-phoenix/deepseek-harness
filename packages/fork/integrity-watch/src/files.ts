/** The small file helpers of the state directory. */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Hash text.
 * @param text - the text, hashed as UTF-8.
 * @returns the SHA-256 digest as lowercase hex.
 */
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/**
 * Read a JSON file.
 * @param path - the file.
 * @returns the parsed content, taken as `T` without validation; undefined when the file is missing or not JSON.
 */
export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

/**
 * Write a JSON file through a temporary file and a rename, creating the directory (mode 0700); the file is mode 0600.
 * @param path - the file.
 * @param value - a JSON-serializable value.
 */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${String(process.pid)}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

/**
 * The SHA the memory history last recorded for the memory file, if there is a history.
 * @param memoryFile - the memory file; its history is `memory.history.jsonl` in the same directory.
 * @returns the `sha` of the last line that has one; undefined when there is no history or no line has a `sha`.
 */
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
