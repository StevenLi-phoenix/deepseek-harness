import { constants } from 'node:fs'
import { appendFile, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, inflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { convertCoverLetter } from '../src/cover-convert.ts'
import type { FsHooks } from './fs-hooks.ts'

const hooks = vi.hoisted((): FsHooks => ({}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const { hookedFs } = await import('./fs-hooks.ts')
  return hookedFs(await importOriginal(), hooks)
})

const signal = new AbortController().signal
let fixture: string
let root: string
let letters: string
let outside: string

beforeEach(async () => {
  fixture = await mkdtemp(join(await realpath(tmpdir()), 'job-cover-test-'))
  root = join(fixture, 'clone')
  letters = join(root, 'cover_letters')
  outside = join(fixture, 'outside')
  await Promise.all([mkdir(letters, { recursive: true }), mkdir(outside)])
})

afterEach(async () => {
  hooks.open = undefined
  hooks.readlink = undefined
  await rm(fixture, { force: true, recursive: true })
})

/** Run `action` on the handle of each matching open, after the real open; on Linux the path is a descriptor name. */
function afterOpen(matches: (path: string, flags: number) => boolean, action: (handle: FileHandle) => Promise<void> | void): void {
  hooks.open = async (path, flags, open) => {
    const handle = await open()
    if (typeof flags === 'number' && matches(path, flags)) await action(handle)
    return handle
  }
}

const isSource = (path: string, flags: number): boolean => path.endsWith('/Letter.md') && (flags & constants.O_DIRECTORY) === 0
const createsDocx = (path: string, flags: number): boolean => path.endsWith('/Letter.docx') && (flags & constants.O_CREAT) !== 0

function parts(archive: Buffer): Record<string, string> {
  const end = archive.length - 22
  expect(archive.readUInt32LE(end)).toBe(0x06054b50)
  const count = archive.readUInt16LE(end + 10)
  expect(count).toBe(3)
  let offset = archive.readUInt32LE(end + 16)
  const result: Record<string, string> = {}
  for (let item = 0; item < count; item++) {
    expect(archive.readUInt32LE(offset)).toBe(0x02014b50)
    const nameLength = archive.readUInt16LE(offset + 28)
    const name = archive.toString('ascii', offset + 46, offset + 46 + nameLength)
    const local = archive.readUInt32LE(offset + 42)
    expect(archive.readUInt32LE(local)).toBe(0x04034b50)
    expect(archive.toString('ascii', local + 30, local + 30 + nameLength)).toBe(name)
    const start = local + 30 + nameLength
    const packed = archive.subarray(start, start + archive.readUInt32LE(offset + 20))
    const payload = inflateRawSync(packed)
    expect(payload.length).toBe(archive.readUInt32LE(offset + 24))
    expect(crc32(payload)).toBe(archive.readUInt32LE(offset + 16))
    result[name] = payload.toString('utf8')
    offset += 46 + nameLength
  }
  expect(offset).toBe(end)
  return result
}

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('convertCoverLetter', () => {
  it('creates a private sibling DOCX with UTF-8 text and no active content', async () => {
    const relative = 'cover_letters/co/Letter (v2).md'
    await mkdir(join(letters, 'co'))
    const markdown = '\uFEFF# Cover letter\r\n\r\nDear team,\r\nI build R&D tools.\r\n\r\n- 您好 — Zoë 👋\r\n- <w:fldSimple> ![img](file:///not-a-file)\r\n\r\nRegards,  \r\nZoë\r\n'
    await writeFile(join(root, relative), markdown)
    const output = await convertCoverLetter(root, relative, signal)
    expect(output).toBe('cover_letters/co/Letter (v2).docx')
    expect((await stat(join(root, output))).mode & 0o777).toBe(0o600)
    await expect(readFile(join(root, relative), 'utf8')).resolves.toBe(markdown)
    const zip = parts(await readFile(join(root, output)))
    expect(Object.keys(zip)).toEqual(['[Content_Types].xml', '_rels/.rels', 'word/document.xml'])
    expect(zip['[Content_Types].xml']).toContain('wordprocessingml.document.main+xml')
    expect(zip['_rels/.rels']).toContain('Target="word/document.xml"')
    expect(zip['_rels/.rels']).not.toContain('TargetMode')
    const document = zip['word/document.xml']
    expect(document).toContain('<w:outlineLvl w:val="0"/>')
    expect(document).toContain('>Cover letter</w:t>')
    expect(document).toContain('>Dear team, I build R&amp;D tools.</w:t>')
    expect(document).toContain('>• 您好 — Zoë 👋</w:t>')
    expect(document).toContain('&lt;w:fldSimple&gt; ![img](file:///not-a-file)')
    expect(document).not.toContain('<w:fldSimple>')
    expect(document).toContain('>Regards,</w:t><w:br/><w:t xml:space="preserve">Zoë</w:t>')
  })

  it.each(['Letter.md', 'other/Letter.md', '/cover_letters/Letter.md', 'cover_letters/../Letter.md', 'cover_letters/./Letter.md',
    'cover_letters//Letter.md', 'cover_letters/.git/config.md', 'cover_letters/nested\\Letter.md', 'cover_letters/Letter.pdf',
    'cover_letters/.md', 'cover_letters/Letter.md\n', 'cover_letters/L\x00etter.md', 'cover_letters/one\n/two.md',
    `cover_letters/${'a'.repeat(240)}.md`])('refuses paths outside the admitted Markdown grammar: %j', async (path) => {
    await expect(convertCoverLetter(root, path, signal)).rejects.toThrow('relative Markdown path')
    await expect(readdir(letters)).resolves.toEqual([])
  })

  it('refuses a symlink in the configured root or any parent directory', async () => {
    const alternativeRoot = join(fixture, 'clone-link')
    await symlink(root, alternativeRoot)
    await symlink(fixture, join(fixture, 'ancestor-link'))
    await symlink(outside, join(letters, 'nested'))
    await writeFile(join(letters, 'Letter.md'), 'inside')
    await writeFile(join(outside, 'Letter.md'), 'outside')
    await expect(convertCoverLetter(alternativeRoot, 'cover_letters/Letter.md', signal)).rejects.toThrow('real directories')
    await expect(convertCoverLetter(join(fixture, 'ancestor-link', 'clone'), 'cover_letters/Letter.md', signal)).rejects.toThrow('real directories')
    await expect(convertCoverLetter(root, 'cover_letters/nested/Letter.md', signal)).rejects.toThrow('real directories')
    const secondRoot = join(fixture, 'second-clone')
    await mkdir(secondRoot)
    await symlink(outside, join(secondRoot, 'cover_letters'))
    await expect(convertCoverLetter(secondRoot, 'cover_letters/Letter.md', signal)).rejects.toThrow('real directories')
    await expect(readdir(outside)).resolves.toEqual(['Letter.md'])
  })

  it('refuses source symlinks, hardlinks and nonregular files', async () => {
    const secret = join(outside, 'Letter.md')
    await writeFile(secret, 'outside')
    await symlink(secret, join(letters, 'Symbolic.md'))
    await link(secret, join(letters, 'Hard.md'))
    await mkdir(join(letters, 'Directory.md'))
    for (const name of ['Symbolic.md', 'Hard.md', 'Directory.md']) {
      await expect(convertCoverLetter(root, `cover_letters/${name}`, signal)).rejects.toThrow('regular file with no links')
    }
    expect((await readdir(letters)).some(name => name.endsWith('.docx'))).toBe(false)
  })

  it('never replaces a file, hardlink, or symlink at the derived destination', async () => {
    const secret = join(outside, 'target')
    const nonexistent = join(outside, 'missing')
    await writeFile(secret, 'outside')
    await writeFile(join(letters, 'Existing.docx'), 'existing')
    await link(secret, join(letters, 'Hard.docx'))
    await symlink(nonexistent, join(letters, 'Symbolic.docx'))
    for (const name of ['Existing', 'Hard', 'Symbolic']) {
      await writeFile(join(letters, `${name}.md`), 'letter')
      await expect(convertCoverLetter(root, `cover_letters/${name}.md`, signal)).rejects.toThrow('already exists')
    }
    await expect(readFile(secret, 'utf8')).resolves.toBe('outside')
    await expect(readFile(join(letters, 'Existing.docx'), 'utf8')).resolves.toBe('existing')
    await expect(stat(nonexistent)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    [Buffer.from([0xc3, 0x28]), 'valid UTF-8'],
    [Buffer.from('Contains \x00 control'), 'plain text'],
    [Buffer.from('Contains \uFFFF'), 'plain text'],
    [Buffer.alloc(64 * 1024 + 1, 0x61), '64 KiB'],
    [Buffer.from('  \n\t'), 'empty'],
  ])('rejects invalid source input %# before creating output', async (input, message) => {
    await writeFile(join(letters, 'Letter.md'), input)
    await expect(convertCoverLetter(root, 'cover_letters/Letter.md', signal)).rejects.toThrow(message)
    await expect(readdir(letters)).resolves.toEqual(['Letter.md'])
  })

  it('allows only one concurrent creation of the same sibling', async () => {
    await writeFile(join(letters, 'Letter.md'), '# Apply ##\n\nLetter.')
    const convert = (): Promise<string> => convertCoverLetter(root, 'cover_letters/Letter.md', signal)
    const outcomes = await Promise.allSettled([convert(), convert()])
    expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(parts(await readFile(join(letters, 'Letter.docx')))['word/document.xml']).toContain('>Apply</w:t>')
  })

  it('does not expose an absolute filesystem path when a source is missing', async () => {
    await expect(convertCoverLetter(root, 'cover_letters/Letter.md', signal)).rejects.toThrow(/^The Markdown source could not be opened/u)
  })

  it('honors cancellation before making an output', async () => {
    await writeFile(join(letters, 'Letter.md'), 'letter')
    await expect(convertCoverLetter(root, 'cover_letters/Letter.md', AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
    await expect(readdir(letters)).resolves.toEqual(['Letter.md'])
  })

  it('reads a trailing backslash as a hard line break', async () => {
    await writeFile(join(letters, 'Letter.md'), 'Line one\\\nLine two\n')
    const output = await convertCoverLetter(root, 'cover_letters/Letter.md', signal)
    expect(parts(await readFile(join(root, output)))['word/document.xml'])
      .toContain('>Line one</w:t><w:br/><w:t xml:space="preserve">Line two</w:t>')
  })

  it('refuses a clone path that is not absolute and normalized', async () => {
    await writeFile(join(letters, 'Letter.md'), 'letter')
    for (const clone of ['clone', '/', `${root}/`, `${root}/../clone`]) {
      await expect(convertCoverLetter(clone, 'cover_letters/Letter.md', signal)).rejects.toThrow('not configured correctly')
    }
    await expect(readdir(letters)).resolves.toEqual(['Letter.md'])
  })

  it('requires a platform with descriptor-based path checks', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    await writeFile(join(letters, 'Letter.md'), 'letter')
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    try {
      await expect(convertCoverLetter(root, 'cover_letters/Letter.md', signal)).rejects.toThrow('requires macOS or Linux')
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
    await expect(readdir(letters)).resolves.toEqual(['Letter.md'])
  })

  it('stops before reading when the cover letter directory is replaced', async () => {
    await writeFile(join(letters, 'Letter.md'), 'letter')
    afterOpen(isSource, async () => {
      await rename(letters, join(root, 'moved'))
      await mkdir(letters)
      await writeFile(join(letters, 'Letter.md'), 'replacement')
    })
    await expect(convertCoverLetter(root, 'cover_letters/Letter.md', signal)).rejects.toThrow('moved during conversion')
    await expect(readdir(letters)).resolves.toEqual(['Letter.md'])
    await expect(readdir(join(root, 'moved'))).resolves.toEqual(['Letter.md'])
  })

  it('stops when the cover letter directory cannot be verified', async () => {
    await writeFile(join(letters, 'Letter.md'), 'letter')
    let verifying = false
    hooks.open = async (path, flags, open) => {
      const directory = typeof flags === 'number' && (flags & constants.O_DIRECTORY) !== 0
      if (verifying && directory) throw new Error('injected directory failure')
      const handle = await open()
      if (typeof flags === 'number' && isSource(path, flags)) verifying = true
      return handle
    }
    hooks.readlink = async (_path, readlink) => {
      if (verifying) throw new Error('injected descriptor failure')
      return readlink()
    }
    await expect(convertCoverLetter(root, 'cover_letters/Letter.md', signal)).rejects.toThrow('cannot be verified')
    await expect(readdir(letters)).resolves.toEqual(['Letter.md'])
  })

  it('refuses a source that grows past 64 KiB while it is read', async () => {
    const source = join(letters, 'Letter.md')
    await writeFile(source, 'letter')
    afterOpen(isSource, (handle) => {
      const read = handle.read.bind(handle)
      vi.spyOn(handle, 'read').mockImplementationOnce(async (...args) => {
        await appendFile(source, 'x'.repeat(64 * 1024))
        return read(...args)
      })
    })
    await expect(convertCoverLetter(root, 'cover_letters/Letter.md', signal)).rejects.toThrow('exceeds 64 KiB')
    await expect(readdir(letters)).resolves.toEqual(['Letter.md'])
  })

  it('refuses a source that changes while it is read', async () => {
    const source = join(letters, 'Letter.md')
    await writeFile(source, 'letter')
    afterOpen(isSource, (handle) => {
      const read = handle.read.bind(handle)
      vi.spyOn(handle, 'read').mockImplementationOnce(async (...args) => {
        const result = await read(...args)
        await utimes(source, new Date(0), new Date(0))
        return result
      })
    })
    await expect(convertCoverLetter(root, 'cover_letters/Letter.md', signal)).rejects.toThrow('changed while it was being read')
    await expect(readdir(letters)).resolves.toEqual(['Letter.md'])
  })

  it('stops without output when cancelled while the source is read', async () => {
    await writeFile(join(letters, 'Letter.md'), 'letter')
    const controller = new AbortController()
    afterOpen(isSource, () => { controller.abort() })
    await expect(convertCoverLetter(root, 'cover_letters/Letter.md', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(readdir(letters)).resolves.toEqual(['Letter.md'])
  })

  it('reports an unconfirmed conversion when the source cannot be closed', async () => {
    await writeFile(join(letters, 'Letter.md'), 'letter')
    afterOpen(isSource, (handle) => {
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
        await close()
        throw new Error('injected close failure')
      })
    })
    await expect(convertCoverLetter(root, 'cover_letters/Letter.md', signal)).rejects.toThrow('could not be converted safely')
    await expect(readdir(letters)).resolves.toEqual(['Letter.md'])
  })

  it.each([
    [Object.assign(new Error('injected link loop'), { code: 'ELOOP' }), 'already exists or is linked'],
    [new Error('injected failure without a code'), 'could not be created'],
  ])('names why the sibling DOCX could not be created %#', async (failure, message) => {
    await writeFile(join(letters, 'Letter.md'), 'letter')
    hooks.open = async (path, flags, open) => {
      if (typeof flags === 'number' && createsDocx(path, flags)) throw failure
      return open()
    }
    await expect(convertCoverLetter(root, 'cover_letters/Letter.md', signal)).rejects.toThrow(message)
    await expect(readdir(letters)).resolves.toEqual(['Letter.md'])
  })

  it('does not confirm a DOCX that gains a second link after creation', async () => {
    await writeFile(join(letters, 'Letter.md'), 'letter')
    afterOpen(createsDocx, async () => { await link(join(letters, 'Letter.docx'), join(outside, 'alias.docx')) })
    await expect(convertCoverLetter(root, 'cover_letters/Letter.md', signal)).rejects.toThrow('could not be confirmed')
  })

  it('does not confirm a DOCX replaced at its name during the write', async () => {
    await writeFile(join(letters, 'Letter.md'), 'letter')
    hooks.open = async (path, flags, open) => {
      if (typeof flags === 'number' && path.endsWith('/Letter.docx') && (flags & constants.O_CREAT) === 0) {
        await rename(join(letters, 'Letter.docx'), join(outside, 'moved.docx'))
        await writeFile(join(letters, 'Letter.docx'), 'impostor')
      }
      return open()
    }
    await expect(convertCoverLetter(root, 'cover_letters/Letter.md', signal)).rejects.toThrow('could not be confirmed')
    await expect(readFile(join(letters, 'Letter.docx'), 'utf8')).resolves.toBe('impostor')
  })
})
