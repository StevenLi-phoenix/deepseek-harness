import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachmentProblem, INBOX_DIR, mediaTypeOf, readAttachments, safeFileName, saveAttachment } from '../src/attachments.ts'

/** The temporary directory the module under test sees; empty means the real one. */
const roots = vi.hoisted(() => ({ tmp: '' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, tmpdir: () => (roots.tmp === '' ? actual.tmpdir() : roots.tmp) }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: vi.fn(actual.writeFile) }
})

const posix = process.platform !== 'win32'

let base = ''
let cwd = ''
let tmp = ''
let outside = ''

beforeEach(async () => {
  roots.tmp = ''
  base = await mkdtemp(join(tmpdir(), 'gmail-attachments-'))
  cwd = join(base, 'work')
  tmp = join(base, 'tmp')
  outside = join(base, 'outside')
  await Promise.all([mkdir(cwd), mkdir(tmp), mkdir(outside)])
  roots.tmp = tmp
})

afterEach(async () => {
  roots.tmp = ''
  await rm(base, { recursive: true, force: true })
})

async function file(path: string, content: string | Uint8Array = 'content'): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
  return path
}

async function refusal(paths: readonly string[], maxBytes = 1_000_000, from = cwd): Promise<string> {
  const error: unknown = await readAttachments(paths, from, maxBytes).then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(AttachmentProblem)
  return error instanceof Error ? error.message : ''
}

describe('media types', () => {
  it('names the type by extension in any case, and octet-stream otherwise', () => {
    expect(mediaTypeOf('Report.PDF')).toBe('application/pdf')
    expect(mediaTypeOf('backup.tar.gz')).toBe('application/gzip')
    expect(mediaTypeOf('deck.pptx')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation')
    expect(mediaTypeOf('Makefile')).toBe('application/octet-stream')
  })
})

describe('files to attach', () => {
  it('reads files inside the working directory by relative or absolute path, with their names and media types', async () => {
    await file(join(cwd, 'docs', 'report.pdf'), 'pdf-bytes')
    const notes = await file(join(cwd, 'notes.TXT'), 'notes')
    const files = await readAttachments(['docs/report.pdf', notes], cwd, 1_000_000)
    expect(files.map(entry => ({ ...entry, data: Buffer.from(entry.data).toString() }))).toEqual([
      { filename: 'report.pdf', contentType: 'application/pdf', data: 'pdf-bytes' },
      { filename: 'notes.TXT', contentType: 'text/plain', data: 'notes' },
    ])
  })

  it('reads a file inside the temporary directory, even when the working directory does not exist', async () => {
    const scan = await file(join(tmp, 'scan.png'), 'png')
    const files = await readAttachments([scan], join(base, 'missing'), 1_000_000)
    expect(files.map(entry => entry.contentType)).toEqual(['image/png'])
  })

  it('refuses a file outside both directories, by absolute or relative path, and the directory itself', async () => {
    const away = await file(join(outside, 'notes.txt'))
    for (const given of [away, '../outside/notes.txt', '.']) {
      expect(await refusal([given])).toBe(`${given}: only files inside the working directory or the temporary directory can be attached`)
    }
  })

  it.skipIf(!posix)('follows symbolic links: one to a file inside is read, one that points outside or into a hidden directory is refused', async () => {
    await file(join(cwd, 'real.txt'), 'real')
    await symlink(join(cwd, 'real.txt'), join(cwd, 'alias.txt'))
    expect((await readAttachments(['alias.txt'], cwd, 1_000_000)).map(entry => entry.filename)).toEqual(['real.txt'])
    await file(join(outside, 'secret-notes.txt'))
    await symlink(join(outside, 'secret-notes.txt'), join(cwd, 'innocent.txt'))
    expect(await refusal(['innocent.txt'])).toBe('innocent.txt: only files inside the working directory or the temporary directory can be attached')
    await file(join(cwd, '.ssh', 'config'))
    await symlink(join(cwd, '.ssh', 'config'), join(cwd, 'harmless.txt'))
    expect(await refusal(['harmless.txt'])).toBe('harmless.txt: files in hidden directories, and hidden files, cannot be attached')
  })

  it('refuses a file under any hidden directory and a hidden file, but reads the download directory', async () => {
    for (const given of ['.dsh/.env', '.ssh/x', '.env', 'project/.git/config']) {
      await file(join(cwd, given))
      expect(await refusal([given])).toBe(`${given}: files in hidden directories, and hidden files, cannot be attached`)
    }
    await file(join(tmp, '.cache', 'x.txt'))
    expect(await refusal([join(tmp, '.cache', 'x.txt')])).toContain('cannot be attached')
    await file(join(cwd, INBOX_DIR, 'invoice.pdf'))
    expect((await readAttachments([`${INBOX_DIR}/invoice.pdf`], cwd, 1_000_000)).map(entry => entry.filename)).toEqual(['invoice.pdf'])
  })

  it('refuses names that look like a key, a certificate, a credential store, or a token', async () => {
    for (const name of ['id_ed25519', 'id_rsa.pub', 'server.pem', 'tls.KEY', 'credentials.json', 'client_secret.json', 'my-token.txt', 'passwords.csv', 'vault.kdbx']) {
      await file(join(cwd, name))
      expect(await refusal([name])).toBe(`${name}: the name looks like a key or a credential, which is never attached`)
    }
  })

  it('refuses a directory and a missing file', async () => {
    await mkdir(join(cwd, 'folder'))
    expect(await refusal(['folder'])).toBe('folder: not a regular file')
    expect(await refusal(['nowhere.pdf'])).toBe('nowhere.pdf: no such file')
  })

  it('refuses files that together hold more than maxBytes, and reads them at exactly the limit', async () => {
    await file(join(cwd, 'a.txt'), '123456')
    await file(join(cwd, 'b.txt'), '7890ab')
    expect(await refusal(['a.txt', 'b.txt'], 11)).toBe('attachments over 0 MiB together cannot be sent; share a link instead')
    expect(await readAttachments(['a.txt', 'b.txt'], cwd, 12)).toHaveLength(2)
    await file(join(cwd, 'big.bin'), new Uint8Array(1_048_577))
    expect(await refusal(['big.bin'], 1_048_576)).toBe('attachments over 1 MiB together cannot be sent; share a link instead')
  })
})

describe('received file names', () => {
  it('keeps only the last path part, from either separator', () => {
    expect(safeFileName('../../x')).toBe('x')
    expect(safeFileName('..\\..\\Windows\\evil.exe')).toBe('evil.exe')
    expect(safeFileName('/etc/passwd')).toBe('passwd')
  })

  it('replaces control and reserved characters, and drops leading dots', () => {
    expect(safeFileName('a\u0000b\nc\u007F.txt')).toBe('a_b_c_.txt')
    expect(safeFileName('what?:*"<>|.txt')).toBe('what_______.txt')
    expect(safeFileName('.bashrc')).toBe('bashrc')
    expect(safeFileName('...hidden.txt')).toBe('hidden.txt')
  })

  it('names a file with nothing left "attachment"', () => {
    for (const name of ['', '   ', '..', '...']) expect(safeFileName(name)).toBe('attachment')
  })

  it('cuts a long name to 120 characters, keeping its extension up to 16 characters', () => {
    const pdf = safeFileName(`${'n'.repeat(200)}.pdf`)
    expect(pdf).toHaveLength(120)
    expect(pdf.endsWith('n.pdf')).toBe(true)
    const odd = safeFileName(`${'a'.repeat(130)}.${'b'.repeat(30)}`)
    expect(odd).toBe(`${'a'.repeat(104)}.${'b'.repeat(15)}`)
    const wide = safeFileName(`${'文'.repeat(150)}.txt`)
    expect(Array.from(wide)).toHaveLength(120)
    expect(wide.endsWith('文.txt')).toBe(true)
  })
})

describe('saving a received file', () => {
  it('writes under .gmail-inbox with the message prefix, ignored by git', async () => {
    const path = await saveAttachment(cwd, 'abc12345', '../../report.pdf', Buffer.from('pdf'))
    expect(path).toBe(join(cwd, INBOX_DIR, 'abc12345-report.pdf'))
    expect(await readFile(path, 'utf8')).toBe('pdf')
    expect(await readFile(join(cwd, INBOX_DIR, '.gitignore'), 'utf8')).toBe('*\n')
  })

  it.skipIf(!posix)('creates the directory 0700 and the files 0600', async () => {
    const path = await saveAttachment(cwd, 'p', 'a.txt', Buffer.from('a'))
    expect((await stat(join(cwd, INBOX_DIR))).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(cwd, INBOX_DIR, '.gitignore'))).mode & 0o777).toBe(0o600)
  })

  it('numbers a name that is taken instead of overwriting it, and keeps an existing .gitignore', async () => {
    await mkdir(join(cwd, INBOX_DIR))
    await writeFile(join(cwd, INBOX_DIR, '.gitignore'), 'custom\n')
    const paths = [
      await saveAttachment(cwd, 'p', 'notes.txt', Buffer.from('1')),
      await saveAttachment(cwd, 'p', 'notes.txt', Buffer.from('2')),
      await saveAttachment(cwd, 'p', 'notes.txt', Buffer.from('3')),
      await saveAttachment(cwd, 'p', 'README', Buffer.from('4')),
      await saveAttachment(cwd, 'p', 'README', Buffer.from('5')),
    ]
    expect(paths.map(path => path.slice(join(cwd, INBOX_DIR).length + 1))).toEqual(['p-notes.txt', 'p-notes-1.txt', 'p-notes-2.txt', 'p-README', 'p-README-1'])
    expect(await Promise.all(paths.map(path => readFile(path, 'utf8')))).toEqual(['1', '2', '3', '4', '5'])
    expect(await readFile(join(cwd, INBOX_DIR, '.gitignore'), 'utf8')).toBe('custom\n')
  })

  it('passes on a failure other than a taken name', async () => {
    await expect(saveAttachment(cwd, 'no/such/dir', 'a.txt', Buffer.from('a'))).rejects.toMatchObject({ code: 'ENOENT' })
    vi.mocked(writeFile).mockRejectedValueOnce(Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' }))
    await expect(saveAttachment(join(base, 'fresh'), 'p', 'a.txt', Buffer.from('a'))).rejects.toThrow('EROFS')
  })
})
