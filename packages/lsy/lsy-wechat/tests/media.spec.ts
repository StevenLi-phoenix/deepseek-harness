import { createCipheriv } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ItemType } from '../src/api.ts'
import { describeMedia, downloadMedia, mediaSpec, parseMediaKey, saveInboxFile, sniffImageType } from '../src/media.ts'

const KEY = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of a png')])
const CDN = 'https://cdn.test/c2c'

function encrypt(data: Uint8Array, key = KEY): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

/** A fetch double answering CDN downloads by `encrypted_query_param`. */
function cdn(files: Record<string, Uint8Array | number>) {
  const urls: string[] = []
  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    urls.push(url.href)
    expect(init?.redirect).toBe('error')
    const entry = files[url.searchParams.get('encrypted_query_param') ?? '']
    if (entry === undefined || typeof entry === 'number') return Promise.resolve(new Response('nope', { status: typeof entry === 'number' ? entry : 404 }))
    return Promise.resolve(new Response(new Uint8Array(entry)))
  }
  return { fetch, urls }
}

const options = (fetch: typeof globalThis.fetch, maxBytes = 1024) => ({ cdnBaseUrl: CDN, maxBytes, timeoutMs: 5000, fetch })

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lsy-wechat-media-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('parseMediaKey', () => {
  it('accepts base64 raw bytes and base64 of a hex string', () => {
    expect(parseMediaKey(KEY.toString('base64'))).toEqual(KEY)
    expect(parseMediaKey(Buffer.from(KEY.toString('hex')).toString('base64'))).toEqual(KEY)
    expect(() => parseMediaKey(Buffer.from('short').toString('base64'))).toThrow('media AES key is invalid')
  })
})

describe('sniffImageType', () => {
  it('reads the format from the leading bytes', () => {
    expect(sniffImageType(PNG)).toBe('image/png')
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('image/jpeg')
    expect(sniffImageType(Buffer.from('GIF89a...'))).toBe('image/gif')
    expect(sniffImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))).toBe('image/webp')
    expect(sniffImageType(Buffer.from('plain text'))).toBeUndefined()
  })
})

describe('mediaSpec', () => {
  it('prefers the hex image key and names files safely', () => {
    expect(mediaSpec({ type: ItemType.IMAGE, image_item: { aeskey: KEY.toString('hex'), media: { encrypt_query_param: 'p', aes_key: 'ignored' } } }))
      .toEqual({ kind: 'image', ref: { encrypt_query_param: 'p', aes_key: 'ignored' }, key: KEY.toString('base64'), name: 'image' })
    expect(mediaSpec({ type: ItemType.FILE, file_item: { file_name: '../../etc/pass\u0000wd', media: { aes_key: 'k' } } }))
      .toMatchObject({ kind: 'file', name: 'pass_wd' })
    expect(mediaSpec({ type: ItemType.VIDEO, video_item: { media: { aes_key: 'k' } } })).toMatchObject({ kind: 'video', name: 'video.mp4' })
    expect(mediaSpec({ type: ItemType.TEXT, text_item: { text: 'hi' } })).toBeUndefined()
    expect(mediaSpec({ type: ItemType.VOICE, voice_item: { text: 'said' } })).toBeUndefined()
  })
})

describe('downloadMedia', () => {
  it('downloads, decrypts, and types an image', async () => {
    const server = cdn({ p1: encrypt(PNG) })
    const media = await downloadMedia({ type: ItemType.IMAGE, image_item: { aeskey: KEY.toString('hex'), media: { encrypt_query_param: 'p1' } } }, options(server.fetch))
    expect(media).toEqual({ kind: 'image', name: 'image.png', mediaType: 'image/png', data: PNG })
    expect(server.urls).toEqual(['https://cdn.test/c2c/download?encrypted_query_param=p1'])
  })

  it('uses full_url on the CDN origin and refuses any other origin', async () => {
    const server = cdn({ p2: encrypt(Buffer.from('%PDF-1.7')) })
    const file = { type: ItemType.FILE, file_item: { file_name: 'a.pdf', media: { aes_key: KEY.toString('base64'), full_url: 'https://cdn.test/c2c/download?encrypted_query_param=p2' } } }
    await expect(downloadMedia(file, options(server.fetch))).resolves.toMatchObject({ kind: 'file', name: 'a.pdf', mediaType: 'application/pdf' })
    const foreign = { type: ItemType.FILE, file_item: { file_name: 'a.pdf', media: { aes_key: KEY.toString('base64'), full_url: 'https://evil.test/download?encrypted_query_param=p2' } } }
    await expect(downloadMedia(foreign, options(server.fetch))).rejects.toThrow('media URL is outside the WeChat CDN')
    expect(server.urls).toHaveLength(1)
  })

  it('reports missing keys, references, HTTP failures, and oversize bodies without URLs', async () => {
    const server = cdn({ big: encrypt(Buffer.alloc(2048)), gone: 404 })
    const image = (media: Record<string, string>, aeskey?: string) =>
      ({ type: ItemType.IMAGE, image_item: { media, ...aeskey === undefined ? {} : { aeskey } } })
    await expect(downloadMedia(image({ encrypt_query_param: 'gone' }), options(server.fetch))).rejects.toThrow(/^media AES key is missing$/)
    await expect(downloadMedia(image({ aes_key: KEY.toString('base64') }), options(server.fetch))).rejects.toThrow(/^media download URL is missing$/)
    await expect(downloadMedia(image({ encrypt_query_param: 'gone' }, KEY.toString('hex')), options(server.fetch))).rejects.toThrow(/^CDN download failed with HTTP 404$/)
    await expect(downloadMedia(image({ encrypt_query_param: 'big' }, KEY.toString('hex')), options(server.fetch))).rejects.toThrow(/^media exceeds 1024 bytes$/)
  })

  it('keeps an image it cannot type as an opaque file', async () => {
    const server = cdn({ odd: encrypt(Buffer.from('not an image')) })
    await expect(downloadMedia({ type: ItemType.IMAGE, image_item: { aeskey: KEY.toString('hex'), media: { encrypt_query_param: 'odd' } } }, options(server.fetch)))
      .resolves.toMatchObject({ kind: 'image', name: 'image.bin', mediaType: 'application/octet-stream' })
  })
})

describe('saveInboxFile', () => {
  it('writes an owner-only file under an owner-only inbox with a unique name', async () => {
    const media = { kind: 'image' as const, name: 'image.png', mediaType: 'image/png' as const, data: PNG }
    const first = await saveInboxFile(join(dir, 'inbox'), media, new Date(2026, 9, 22, 17, 42, 33))
    const second = await saveInboxFile(join(dir, 'inbox'), media, new Date(2026, 9, 22, 17, 42, 33))
    expect(first).toMatch(/inbox\/20261022-174233-[0-9a-f]{8}-image\.png$/)
    expect(second).not.toBe(first)
    expect(readFileSync(first)).toEqual(PNG)
    expect(statSync(first).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'inbox')).mode & 0o777).toBe(0o700)
    // The inbox ignores itself, so a workspace that is a git repository never commits the owner's attachments.
    expect(readFileSync(join(dir, 'inbox', '.gitignore'), 'utf8')).toBe('*\n')
  })
})

describe('describeMedia', () => {
  it('names the kind, type, and size', () => {
    expect(describeMedia({ kind: 'image', name: 'image.png', mediaType: 'image/png', data: Buffer.alloc(2048) })).toBe('image (image/png, 2.0 KB)')
    expect(describeMedia({ kind: 'file', name: 'a.pdf', mediaType: 'application/pdf', data: Buffer.alloc(3 * 1024 * 1024) })).toBe('file "a.pdf" (application/pdf, 3.0 MB)')
    expect(describeMedia({ kind: 'video', name: 'video.mp4', mediaType: 'video/mp4', data: Buffer.alloc(10) })).toBe('video (video/mp4, 10 B)')
  })
})
