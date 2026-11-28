import { appendFile, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readBatchRunbook, writeBatchRunbook } from '../src/batch-runbook.ts'
import type { FsHooks } from './fs-hooks.ts'

const hooks = vi.hoisted((): FsHooks => ({}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const { hookedFs } = await import('./fs-hooks.ts')
  return hookedFs(await importOriginal(), hooks)
})

const limit = 128 * 1024
let fixture: string
let runbook: string

beforeEach(async () => {
  fixture = await mkdtemp(join(await realpath(tmpdir()), 'job-runbook-test-'))
  runbook = join(fixture, 'job-apply-batch.md')
  await writeFile(runbook, '# Batch\n\nOriginal steps that run longer than the replacement.\n')
})

afterEach(async () => {
  hooks.open = undefined
  await rm(fixture, { force: true, recursive: true })
})

describe('readBatchRunbook', () => {
  it('reads the configured runbook as UTF-8 text', async () => {
    await writeFile(runbook, '# Batch\n\n- 申请 five postings\n')
    await expect(readBatchRunbook(runbook)).resolves.toBe('# Batch\n\n- 申请 five postings\n')
  })

  it('refuses a relative, unnormalized, renamed or symlinked runbook path', async () => {
    const linkedParent = join(fixture, 'linked')
    await symlink(fixture, linkedParent)
    await symlink(runbook, join(fixture, 'alias.md'))
    for (const path of ['job-apply-batch.md', `${fixture}/./job-apply-batch.md`, join(fixture, 'alias.md'), join(linkedParent, 'job-apply-batch.md')]) {
      await expect(readBatchRunbook(path)).rejects.toThrow('not canonical')
    }
  })

  it('refuses a directory, a hardlinked file and an oversized file before reading', async () => {
    await link(runbook, join(fixture, 'second-name.md'))
    await expect(readBatchRunbook(runbook)).rejects.toThrow('regular, unlinked UTF-8 file')
    await rm(join(fixture, 'second-name.md'))
    await writeFile(runbook, 'x'.repeat(limit + 1))
    await expect(readBatchRunbook(runbook)).rejects.toThrow('within the size limit')
    const directory = join(fixture, 'nested')
    await mkdir(join(directory, 'job-apply-batch.md'), { recursive: true })
    await expect(readBatchRunbook(join(directory, 'job-apply-batch.md'))).rejects.toThrow('regular, unlinked UTF-8 file')
  })

  it('refuses a runbook that grows past the size limit after its size check', async () => {
    hooks.open = async (path, _flags, open) => {
      const handle = await open()
      if (path !== runbook) return handle
      const read = handle.read.bind(handle)
      vi.spyOn(handle, 'read').mockImplementationOnce(async (...args) => {
        await appendFile(runbook, 'x'.repeat(limit))
        return read(...args)
      })
      return handle
    }
    await expect(readBatchRunbook(runbook)).rejects.toThrow('exceeds the size limit')
  })
})

describe('writeBatchRunbook', () => {
  it('replaces the whole runbook in place and truncates the previous text', async () => {
    const before = await stat(runbook)
    await expect(writeBatchRunbook(runbook, '# Batch\n\tShort.\r\n')).resolves.toBe('Updated the batch runbook.')
    await expect(readFile(runbook, 'utf8')).resolves.toBe('# Batch\n\tShort.\r\n')
    expect((await stat(runbook)).ino).toBe(before.ino)
  })

  it.each(['', 'x'.repeat(limit + 1), 'bell \u0007 character'])('refuses empty, oversized or control-character text %#', async (text) => {
    await expect(writeBatchRunbook(runbook, text)).rejects.toThrow('bounded plain Markdown')
    await expect(readFile(runbook, 'utf8')).resolves.toMatch(/^# Batch\n\nOriginal steps/u)
  })

  it('refuses a linked runbook without writing through the link', async () => {
    const target = join(fixture, 'target.md')
    await writeFile(target, 'untouched\n')
    await rm(runbook)
    await link(target, runbook)
    await expect(writeBatchRunbook(runbook, 'replacement\n')).rejects.toThrow('regular, unlinked UTF-8 file')
    await expect(readFile(target, 'utf8')).resolves.toBe('untouched\n')
  })

  it('stops when a write makes no progress instead of looping', async () => {
    hooks.open = async (path, _flags, open) => {
      const handle = await open()
      if (path === runbook) vi.spyOn(handle, 'write').mockResolvedValueOnce({ bytesWritten: 0, buffer: '' })
      return handle
    }
    await expect(writeBatchRunbook(runbook, 'replacement\n')).rejects.toThrow('did not advance')
    await expect(readFile(runbook, 'utf8')).resolves.toMatch(/^# Batch\n\nOriginal steps/u)
  })
})
