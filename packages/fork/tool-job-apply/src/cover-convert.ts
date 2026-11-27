/** Render plain cover-letter Markdown to Word without launching a process or resolving document resources. */
import { constants, type BigIntStats } from 'node:fs'
import { open, readlink, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import { crc32, deflateRawSync } from 'node:zlib'

const MAX_SOURCE_BYTES = 64 * 1024
const MAX_SOURCE_PATH = 238 // Leave two more characters for the .docx suffix.
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY
const READ_ONLY = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY
// Darwin sys/fcntl.h: rejects symlinks in every component. It cannot be combined with O_NOFOLLOW.
const DARWIN_NOFOLLOW_ANY = 0x20000000

class CoverConvertError extends Error {
  override readonly name = 'CoverConvertError'
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

function regularUnlinked(stat: BigIntStats): boolean {
  return stat.isFile() && stat.nlink === 1n
}

interface ParentDirectory {
  readonly handle: FileHandle
  readonly path: string
  readonly prefix: string
  readonly noFollow: number
}

async function openParent(path: string): Promise<ParentDirectory> {
  try {
    if (process.platform === 'darwin') {
      const handle = await open(path, DIRECTORY | DARWIN_NOFOLLOW_ANY)
      return { handle, path, prefix: path, noFollow: DARWIN_NOFOLLOW_ANY }
    }
    if (process.platform === 'linux') {
      // Walk one component at a time through kernel-owned descriptor names; O_NOFOLLOW protects each new leaf.
      let handle = await open('/', DIRECTORY)
      try {
        for (const segment of path.slice(1).split('/')) {
          const previous = handle
          handle = await open(`/proc/self/fd/${previous.fd}/${segment}`, DIRECTORY | constants.O_NOFOLLOW)
          await previous.close()
        }
        return { handle, path, prefix: `/proc/self/fd/${handle.fd}`, noFollow: constants.O_NOFOLLOW }
      } catch (error) {
        await handle.close()
        throw error
      }
    }
  } catch (_error) {
    throw new CoverConvertError('The job clone and cover letter path must use existing real directories, not links.')
  }
  throw new CoverConvertError('Cover letter conversion requires macOS or Linux with descriptor-based path checks.')
}

async function verifyParent(parent: ParentDirectory): Promise<void> {
  try {
    if (parent.noFollow !== DARWIN_NOFOLLOW_ANY) {
      if (await readlink(parent.prefix) === parent.path) return
    } else {
      const current = await open(parent.path, DIRECTORY | parent.noFollow)
      try {
        if (sameFile(await parent.handle.stat({ bigint: true }), await current.stat({ bigint: true }))) return
      } finally {
        await current.close()
      }
    }
  } catch (_error) {
    throw new CoverConvertError('The cover letter directory cannot be verified.')
  }
  throw new CoverConvertError('The cover letter directory moved during conversion.')
}

async function openSource(parent: ParentDirectory, name: string): Promise<FileHandle> {
  try {
    return await open(join(parent.prefix, name), READ_ONLY | parent.noFollow)
  } catch (error) {
    if (errorCode(error) === 'ELOOP') throw new CoverConvertError('The Markdown source must be a regular file with no links.')
    throw new CoverConvertError('The Markdown source could not be opened in cover_letters/.')
  }
}

async function readSource(parent: ParentDirectory, name: string, signal: AbortSignal): Promise<string> {
  const source = await openSource(parent, name)
  try {
    await verifyParent(parent)
    const first = await source.stat({ bigint: true })
    if (!regularUnlinked(first)) throw new CoverConvertError('The Markdown source must be a regular file with no links.')
    if (first.size > BigInt(MAX_SOURCE_BYTES)) throw new CoverConvertError('The Markdown source exceeds 64 KiB.')
    // The read is bounded even if another process changes the size after stat().
    const bytes = Buffer.alloc(MAX_SOURCE_BYTES + 1)
    let offset = 0
    while (offset < bytes.length) {
      signal.throwIfAborted()
      const { bytesRead } = await source.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > MAX_SOURCE_BYTES) throw new CoverConvertError('The Markdown source exceeds 64 KiB.')
    const last = await source.stat({ bigint: true })
    if (!regularUnlinked(last) || last.ctimeNs !== first.ctimeNs || last.mtimeNs !== first.mtimeNs || last.size !== BigInt(offset)) {
      throw new CoverConvertError('The Markdown source changed while it was being read.')
    }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))
    } catch (_error) {
      throw new CoverConvertError('The Markdown source is not valid UTF-8.')
    }
    if (/[^\P{Cc}\t\n\r]|\uFFFE|\uFFFF/u.test(text)) throw new CoverConvertError('The Markdown source must be plain text.')
    if (!text.trim()) throw new CoverConvertError('The Markdown source is empty.')
    return text
  } finally {
    await source.close()
  }
}

const XML = '<?xml version="1.0" encoding="UTF-8"?>'
const CONTENT_TYPES = XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
const RELATIONSHIPS = XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'

function textNode(text: string): string {
  const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return `<w:t xml:space="preserve">${escaped}</w:t>`
}

function paragraph(text: string, headingLevel = 0): string {
  const heading = headingLevel > 0
  const before = heading ? '<w:keepNext/>' : ''
  const outline = heading ? `<w:outlineLvl w:val="${headingLevel - 1}"/>` : ''
  const style = heading ? '<w:rPr><w:b/><w:sz w:val="28"/></w:rPr>' : ''
  const body = text.split('\n').map(line => line.split('\t').map(textNode).join('<w:tab/>')).join('<w:br/>')
  return `<w:p><w:pPr>${before}<w:spacing w:after="160"/>${outline}</w:pPr><w:r>${style}${body}</w:r></w:p>`
}

function headingText(markdown: string): string {
  const text = markdown.trimEnd()
  let marker = text.length
  while (marker > 0 && text[marker - 1] === '#') marker--
  return marker > 0 && marker < text.length && /[ \t]/u.test(text.charAt(marker - 1)) ? text.slice(0, marker).trim() : text.trimStart()
}

function documentXml(markdown: string): string {
  const paragraphs: string[] = []
  let prose = ''
  let separator = ''
  const flush = (): void => {
    if (prose) paragraphs.push(paragraph(prose))
    prose = ''
  }
  for (const line of markdown.split(/\r\n|\r|\n/u)) {
    if (!line.trim()) {
      flush()
    } else {
      const heading = /^(#{1,6})[ \t]+(.*)$/u.exec(line)
      const bullet = /^[-+*][ \t]+(.*)$/u.exec(line)
      if (heading?.[1] !== undefined && heading[2] !== undefined) {
        flush()
        paragraphs.push(paragraph(headingText(heading[2]), heading[1].length))
      } else if (bullet?.[1] !== undefined) {
        flush()
        paragraphs.push(paragraph(`• ${bullet[1].trim()}`))
      } else {
        const hardBreak = line.endsWith('  ') || line.endsWith('\\')
        const text = (line.endsWith('\\') ? line.slice(0, -1) : line).trim()
        prose += (prose ? separator : '') + text
        separator = hardBreak ? '\n' : ' '
      }
    }
  }
  flush()
  return XML + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + paragraphs.join('') + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>'
    + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'
    + '</w:sectPr></w:body></w:document>'
}

function docx(markdown: string): Buffer {
  const entries = [['[Content_Types].xml', CONTENT_TYPES], ['_rels/.rels', RELATIONSHIPS], ['word/document.xml', documentXml(markdown)]] as const
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  // ZIP32, deflate, fixed ASCII entry names and a fixed DOS date; no extra fields or data descriptors.
  for (const [name, xml] of entries) {
    const bytes = Buffer.from(xml, 'utf8')
    const compressed = deflateRawSync(bytes)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(8, 8)
    localHeader.writeUInt16LE(0x21, 12)
    localHeader.writeUInt32LE(crc32(bytes), 14)
    localHeader.writeUInt32LE(compressed.length, 18)
    localHeader.writeUInt32LE(bytes.length, 22)
    localHeader.writeUInt16LE(name.length, 26)
    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50)
    centralHeader.writeUInt16LE(20, 4)
    localHeader.copy(centralHeader, 6, 4, 30)
    centralHeader.writeUInt32LE(offset, 42)
    const filename = Buffer.from(name, 'ascii')
    local.push(localHeader, filename, compressed)
    central.push(centralHeader, filename)
    offset += localHeader.length + filename.length + compressed.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(central.reduce((sum, piece) => sum + piece.length, 0), 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...central, end])
}

async function writeOutput(parent: ParentDirectory, name: string, content: Buffer, signal: AbortSignal): Promise<void> {
  await verifyParent(parent)
  signal.throwIfAborted()
  const path = join(parent.prefix, name)
  let target: FileHandle
  try {
    target = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | parent.noFollow, 0o600)
  } catch (error) {
    if (errorCode(error) === 'EEXIST' || errorCode(error) === 'ELOOP') {
      throw new CoverConvertError('The sibling DOCX already exists or is linked. Choose a new Markdown filename.')
    }
    throw new CoverConvertError('The sibling DOCX could not be created in cover_letters/.')
  }
  // Once created, finish the bounded write even on cancellation. Never unlink a path that another process may have replaced.
  try {
    try {
      await verifyParent(parent)
      if (!regularUnlinked(await target.stat({ bigint: true }))) throw new CoverConvertError('The DOCX destination is linked.')
      await target.writeFile(content)
      const current = await open(path, READ_ONLY | parent.noFollow)
      try {
        const written = await target.stat({ bigint: true })
        const named = await current.stat({ bigint: true })
        if (!sameFile(written, named) || !regularUnlinked(written) || !regularUnlinked(named) || written.size !== BigInt(content.length)) {
          throw new CoverConvertError('The DOCX destination changed during conversion.')
        }
      } finally {
        await current.close()
      }
      await verifyParent(parent)
    } finally {
      await target.close()
    }
  } catch (_error) {
    throw new CoverConvertError('DOCX creation could not be confirmed; the sibling file may be incomplete. Do not upload it.')
  }
}

/**
 * Converts one regular UTF-8 Markdown file in a deployment-controlled clone on macOS or Linux. The clone's
 * directories must not be moved by another host process during conversion. The result supports simple headings,
 * bullet lines, paragraphs and hard breaks; other Markdown remains literal. PDF is not provided because font
 * embedding and layout require a separate renderer. Existing files are never replaced; a failed write may leave
 * an incomplete output that must not be uploaded.
 * @param root Trusted, normalized absolute clone path from deployment settings, not a tool argument.
 * @param path Repository-relative, slash-separated Markdown path under cover_letters/ (64 KiB source limit).
 * @param signal Cancellation before output creation. An already-started exclusive creation is finished.
 * @returns The repository-relative path of the new sibling DOCX.
 */
export async function convertCoverLetter(root: string, path: string, signal: AbortSignal): Promise<string> {
  const segments = path.split('/')
  const name = segments.pop()
  if (segments[0] !== 'cover_letters' || name === undefined || !name.endsWith('.md') || path.length > MAX_SOURCE_PATH
    || [...segments, name].some(part => !/^[A-Za-z0-9_]/u.test(part) || /[^A-Za-z0-9_ .()-]|[ .]$/u.test(part))) {
    throw new CoverConvertError('Supply a relative Markdown path under cover_letters/ with ordinary filenames.')
  }
  if (!isAbsolute(root) || resolve(root) !== root || root === '/') throw new CoverConvertError('The job clone path is not configured correctly.')
  signal.throwIfAborted()
  let parent: ParentDirectory
  try {
    parent = await openParent(join(root, ...segments))
    try {
      const markdown = await readSource(parent, name, signal)
      signal.throwIfAborted()
      const target = `${name.slice(0, -3)}.docx`
      await writeOutput(parent, target, docx(markdown), signal)
      return [...segments, target].join('/')
    } finally {
      await parent.handle.close()
    }
  } catch (error) {
    if (error instanceof CoverConvertError) throw error
    signal.throwIfAborted()
    throw new CoverConvertError('The cover letter could not be converted safely. Do not upload an unconfirmed result.')
  }
}
