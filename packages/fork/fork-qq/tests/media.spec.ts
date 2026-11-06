import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectExtension, fetchCapped, isAllowedMediaUrl, MediaTooLarge, removeMedia, saveMedia } from '../src/media.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fork-qq-media-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** `length` bytes that start with `head` and are zero after it. */
const padded = (head: readonly number[] | string, length = 16): Buffer => {
  const out = Buffer.alloc(length)
  const bytes = typeof head === 'string' ? Buffer.from(head, 'latin1') : Buffer.from(head)
  bytes.copy(out)
  return out
}

describe('isAllowedMediaUrl', () => {
  it('accepts an https host on the list, and a bare host equal to a suffix without its dot', () => {
    expect(isAllowedMediaUrl('https://multimedia.nt.qq.com.cn/a.jpg')).toBe(true)
    expect(isAllowedMediaUrl('https://cdn.example.org/a', ['.example.org'])).toBe(true)
    expect(isAllowedMediaUrl('https://EXAMPLE.org/a', ['.example.org'])).toBe(true)
  })

  it.each([
    ['not a URL', 'nonsense'],
    ['plain http', 'http://multimedia.nt.qq.com.cn/a.jpg'],
    ['a port', 'https://multimedia.nt.qq.com.cn:8443/a.jpg'],
    ['a user name', 'https://user@multimedia.nt.qq.com.cn/a.jpg'],
    ['a password', 'https://:secret@multimedia.nt.qq.com.cn/a.jpg'],
    ['an IPv4 address', 'https://127.0.0.1/a.jpg'],
    ['an IPv6 address', 'https://[::1]/a.jpg'],
    ['a host off the list', 'https://evil.example.net/a.jpg'],
  ])('refuses %s', (_name, link) => {
    expect(isAllowedMediaUrl(link)).toBe(false)
  })
})

describe('fetchCapped', () => {
  const answer = (init: ResponseInit & { body?: BodyInit | null } = {}): typeof fetch => async () => new Response(init.body ?? null, init)

  it('returns the body of an OK answer and asks for no redirect following', async () => {
    let seen: RequestInit | undefined
    const fetchImpl: typeof fetch = async (_url, init) => { seen = init; return new Response('hello') }
    expect((await fetchCapped('https://x/a', 100, 1000, fetchImpl)).toString()).toBe('hello')
    expect(seen?.redirect).toBe('manual')
  })

  it('refuses a redirect, naming the status, and any other failure status', async () => {
    await expect(fetchCapped('https://x/a', 100, 1000, answer({ status: 302 }))).rejects.toThrow('redirected (HTTP 302); not followed')
    await expect(fetchCapped('https://x/a', 100, 1000, answer({ status: 404 }))).rejects.toThrow('HTTP 404')
  })

  it('refuses a declared size over the cap before reading the body', async () => {
    const declared = answer({ body: 'x', headers: { 'content-length': '500' } })
    await expect(fetchCapped('https://x/a', 100, 1000, declared)).rejects.toBeInstanceOf(MediaTooLarge)
    await expect(fetchCapped('https://x/a', 100, 1000, declared)).rejects.toThrow('500 bytes exceeds 100')
  })

  it('reads the body when the declared size is missing or not a number', async () => {
    const garbled = answer({ body: 'abc', headers: { 'content-length': 'many' } })
    expect((await fetchCapped('https://x/a', 100, 1000, garbled)).toString()).toBe('abc')
  })

  it('stops a body that outgrows the cap while streaming', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(60)); controller.enqueue(new Uint8Array(60)); controller.close() },
    })
    await expect(fetchCapped('https://x/a', 100, 1000, answer({ body: stream }))).rejects.toThrow('more than 100 bytes')
  })

  it('joins the chunks of a streamed body', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from('ab')); controller.enqueue(Buffer.from('cd')); controller.close() },
    })
    expect((await fetchCapped('https://x/a', 100, 1000, answer({ body: stream }))).toString()).toBe('abcd')
  })

  it('reports an answer with no body', async () => {
    const bodyless: typeof fetch = async () => Object.defineProperty(new Response('x'), 'body', { value: null })
    await expect(fetchCapped('https://x/a', 100, 1000, bodyless)).rejects.toThrow('empty body')
  })
})

describe('detectExtension', () => {
  it.each([
    ['png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], '.png'],
    ['jpeg', [0xff, 0xd8, 0xff], '.jpg'],
    ['gif', 'GIF89a', '.gif'],
    ['webp', 'RIFF\u0000\u0000\u0000\u0000WEBP', '.webp'],
    ['heic', '\u0000\u0000\u0000\u0018ftypheic', '.heic'],
    ['heif mif1', '\u0000\u0000\u0000\u0018ftypmif1', '.heic'],
    ['wav', 'RIFF\u0000\u0000\u0000\u0000WAVE', '.wav'],
    ['mp3 with an ID3 tag', 'ID3\u0004', '.mp3'],
    ['mp3 frame sync', [0xff, 0xfb, 0x90], '.mp3'],
    ['amr', '#!AMR\n', '.amr'],
    ['silk', '\u0002#!SILK_V3', '.silk'],
  ] as Array<[string, readonly number[] | string, string]>)('recognises %s from its content', (_name, head, extension) => {
    expect(detectExtension(padded(head), 'image')).toBe(extension)
  })

  it('falls back to the file name, then to the kind', () => {
    const unknown = padded('????????????')
    expect(detectExtension(unknown, 'file', 'Report.PDF')).toBe('.pdf')
    expect(detectExtension(unknown, 'image', 'no-extension')).toBe('.img')
    expect(detectExtension(unknown, 'voice')).toBe('.bin')
    expect(detectExtension(Buffer.from('short'), 'file', 'a.txt')).toBe('.txt')
  })

  it('does not take a mere RIFF header for a picture or a sound', () => {
    expect(detectExtension(padded('RIFF\u0000\u0000\u0000\u0000AVI '), 'file')).toBe('.bin')
  })
})

describe('saveMedia', () => {
  it('writes the content under media/<group>/<month>/<sha256><ext>, private, and reports path, hash and size', async () => {
    const bytes = Buffer.from('picture bytes')
    const at = Date.UTC(2026, 9, 31, 23, 59, 0)
    const saved = await saveMedia(dir, '123456', at, bytes, '.jpg')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    expect(saved).toEqual({ path: join(dir, 'media', '123456', '202610', `${sha256}.jpg`), sha256, bytes: bytes.length })
    expect(readFileSync(saved.path)).toEqual(bytes)
    expect(statSync(saved.path).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'media', '123456')).mode & 0o777).toBe(0o700)
    expect(readdirSync(join(dir, 'media', '123456', '202610'))).toEqual([`${sha256}.jpg`])
  })

  it('keeps a file that is already there and files a December message under its own month', async () => {
    const bytes = Buffer.from('same content')
    const at = Date.UTC(2026, 11, 1, 0, 0, 0)
    const first = await saveMedia(dir, '123456', at, bytes, '.png')
    writeFileSync(first.path, 'marker')
    const second = await saveMedia(dir, '123456', at, bytes, '.png')
    expect(second.path).toBe(first.path)
    expect(first.path).toContain('202612')
    expect(readFileSync(first.path, 'utf8')).toBe('marker')
  })

  it('replaces a group id that is not 3 to 20 digits by a hash prefix, so it cannot name a path', async () => {
    const saved = await saveMedia(dir, '../../etc', 0, Buffer.from('x'), '.bin')
    const prefix = createHash('sha256').update('../../etc').digest('hex').slice(0, 16)
    expect(saved.path).toBe(join(dir, 'media', prefix, '197001', `${saved.sha256}.bin`))
    expect(saved.path.startsWith(join(dir, 'media'))).toBe(true)
  })
})

describe('removeMedia', () => {
  it('deletes a file and accepts one that is already gone', async () => {
    const path = join(dir, 'x.bin')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, 'x')
    await removeMedia(path)
    expect(readdirSync(dir)).toEqual([])
    await expect(removeMedia(path)).resolves.toBeUndefined()
  })
})
