/** The lead-only, deployment-configured batch runbook. No caller-supplied path. */
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, normalize } from 'node:path'

const limit = 128 * 1024

async function checked(path: string, writable: boolean) {
  if (!isAbsolute(path) || normalize(path) !== path || basename(path) !== 'job-apply-batch.md'
    || await realpath(dirname(path)) !== dirname(path)) throw new Error('The configured batch runbook is not canonical.')
  const handle = await open(path, (writable ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const [opened, named] = await Promise.all([handle.stat(), lstat(path)])
    if (!opened.isFile() || !named.isFile() || opened.nlink !== 1 || named.nlink !== 1 || opened.size > limit
      || opened.dev !== named.dev || opened.ino !== named.ino || await realpath(path) !== path) {
      throw new Error('The batch runbook must be a regular, unlinked UTF-8 file within the size limit.')
    }
    return handle
  } catch (error: unknown) {
    await handle.close()
    throw error
  }
}

/**
 * Read the batch runbook after confirming it is a canonical, single-link regular file within the 128 KiB limit.
 * @param path - trusted existing runbook path.
 * @returns the runbook text decoded as strict UTF-8.
 * @throws Error - when the file is not canonical or too large, or does not decode as UTF-8.
 */
export async function readBatchRunbook(path: string): Promise<string> {
  const handle = await checked(path, false)
  try {
    const buffer = Buffer.alloc(limit + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > limit) throw new Error('The batch runbook exceeds the size limit.')
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
  } finally { await handle.close() }
}

/**
 * Replace the whole content of the batch runbook in place, after confirming it is a canonical regular file.
 * @param path - trusted existing runbook path.
 * @param text - replacement Markdown: non-empty, at most 128 KiB, without control characters other than tab and line breaks.
 * @returns a status message for the model.
 * @throws Error - when the text is out of bounds or the file is not canonical.
 */
export async function writeBatchRunbook(path: string, text: string): Promise<string> {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length === 0 || bytes.length > limit || /[^\P{Cc}\t\r\n]/u.test(text)) throw new Error('Supply bounded plain Markdown for the batch runbook.')
  const handle = await checked(path, true)
  try {
    let offset = 0
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset)
      if (bytesWritten === 0) throw new Error('The batch runbook write did not advance.')
      offset += bytesWritten
    }
    await handle.truncate(bytes.length)
    await handle.sync()
    return 'Updated the batch runbook.'
  } finally { await handle.close() }
}
