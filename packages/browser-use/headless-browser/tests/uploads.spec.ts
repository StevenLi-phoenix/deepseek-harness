/**
 * The upload directories: a file inside one is attached, anything outside —
 * by path, by `..`, or through a symlink — is refused, and so is a directory or
 * a file over the size cap.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_UPLOAD_FILES, UploadPolicy, UploadRefusedError } from '../src/uploads.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function layout(): { root: string; uploads: string; letters: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-uploads-'))
  roots.push(root)
  const uploads = join(root, 'uploads')
  const letters = join(root, 'letters')
  const outside = join(root, 'outside')
  for (const dir of [uploads, letters, outside]) mkdirSync(dir)
  writeFileSync(join(uploads, 'resume.pdf'), 'pdf')
  writeFileSync(join(letters, 'acme.docx'), 'docx')
  writeFileSync(join(outside, 'secret.env'), 'KEY=1')
  mkdirSync(join(uploads, 'folder'))
  symlinkSync(join(outside, 'secret.env'), join(uploads, 'innocent.pdf'))
  writeFileSync(join(uploads, 'big.pdf'), Buffer.alloc(2 * 1024 * 1024 + 1))
  return { root, uploads, letters, outside }
}

describe('UploadPolicy', () => {
  it('attaches a bare name from the first directory and an absolute path from any directory', async () => {
    const dirs = layout()
    const policy = new UploadPolicy([dirs.uploads, dirs.letters], 2)
    const files = await policy.resolve(['resume.pdf', join(dirs.letters, 'acme.docx')])
    expect(files.map(file => [file.name, file.bytes])).toEqual([['resume.pdf', 3], ['acme.docx', 4]])
    expect(files[0]!.path.endsWith(join('uploads', 'resume.pdf'))).toBe(true)
  })

  it('refuses a file outside the directories, by path, by dot-dot, and through a symlink', async () => {
    const dirs = layout()
    const policy = new UploadPolicy([dirs.uploads], 25)
    await expect(policy.resolve([join(dirs.outside, 'secret.env')])).rejects.toThrow(/outside the upload directories/u)
    await expect(policy.resolve([join(dirs.uploads, '..', 'outside', 'secret.env')])).rejects.toThrow(UploadRefusedError)
    await expect(policy.resolve(['innocent.pdf'])).rejects.toThrow(/outside the upload directories/u)
  })

  it('refuses a missing file, a directory, an oversized file, and too many files', async () => {
    const dirs = layout()
    const policy = new UploadPolicy([dirs.uploads], 2)
    await expect(policy.resolve(['missing.pdf'])).rejects.toThrow(/does not exist/u)
    await expect(policy.resolve(['folder'])).rejects.toThrow(/not a regular file/u)
    await expect(policy.resolve(['big.pdf'])).rejects.toThrow(/over the 2 MB upload limit/u)
    await expect(policy.resolve([])).rejects.toThrow(/at least one file/u)
    await expect(policy.resolve(Array.from({ length: MAX_UPLOAD_FILES + 1 }, () => 'resume.pdf'))).rejects.toThrow(/at most/u)
  })

  it('refuses everything when no directory is configured', async () => {
    await expect(new UploadPolicy([], 25).resolve(['/etc/hosts'])).rejects.toThrow(/no upload directory/u)
  })
})
