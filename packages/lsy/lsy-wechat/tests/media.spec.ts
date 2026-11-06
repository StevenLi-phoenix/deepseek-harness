import { createCipheriv } from 'node:crypto'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ItemType } from '../src/api.ts'
import {
  attachmentNote, describeMedia, downloadMedia, mediaSpec, outboundKind, parseMediaKey, saveInboxFile, sniffImageType, uploadMedia,
} from '../src/media.ts'

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

/** A CDN double that keeps what was uploaded and serves it back for download. */
function uploadCdn(options: { status?: number; omitParam?: boolean } = {}) {
  const stored = new Map<string, Uint8Array>()
  const uploads: { url: string; headers: Record<string, string> }[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    expect(init?.redirect).toBe('error')
    if (url.pathname.endsWith('/upload')) {
      uploads.push({ url: url.href, headers: Object.fromEntries(new Headers(init?.headers).entries()) })
      if (options.status !== undefined) return new Response('no', { status: options.status })
      const param = `dl-${uploads.length}`
      stored.set(param, new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer()))
      return new Response(null, { status: 200, headers: options.omitParam === true ? {} : { 'x-encrypted-param': param } })
    }
    const entry = stored.get(url.searchParams.get('encrypted_query_param') ?? '')
    return entry === undefined ? new Response('missing', { status: 404 }) : new Response(new Uint8Array(entry))
  }
  return { fetch, uploads, stored }
}

describe('outboundKind', () => {
  it('sends image bytes as a picture, known video extensions as video, and the rest as files', () => {
    expect(outboundKind('anything.bin', PNG)).toBe('image')
    expect(outboundKind('clip.MP4', Buffer.from('....ftypisom'))).toBe('video')
    expect(outboundKind('notes.pdf', Buffer.from('%PDF-1.7'))).toBe('file')
    expect(outboundKind('fake.png', Buffer.from('not really'))).toBe('file')
  })
})

describe('uploadMedia', () => {
  it('uploads the encrypted file and builds an item our own download path decrypts back', async () => {
    const cdn = uploadCdn()
    const requests: unknown[] = []
    const client = { getUploadUrl: (request: unknown) => { requests.push(request); return Promise.resolve({ uploadParam: 'up+1' }) } }
    const { kind, item } = await uploadMedia(client, 'owner@im.wechat', 'sticker.png', PNG, { cdnBaseUrl: CDN, timeoutMs: 5000, fetch: cdn.fetch })
    expect(kind).toBe('image')
    expect(requests).toEqual([expect.objectContaining({
      media_type: 1, to_user_id: 'owner@im.wechat', rawsize: PNG.byteLength, filesize: 32,
      rawfilemd5: expect.stringMatching(/^[0-9a-f]{32}$/) as string,
      filekey: expect.stringMatching(/^[0-9a-f]{32}$/) as string,
      aeskey: expect.stringMatching(/^[0-9a-f]{32}$/) as string,
    })])
    expect(cdn.uploads[0]!.url).toMatch(/^https:\/\/cdn\.test\/c2c\/upload\?encrypted_query_param=up%2B1&filekey=[0-9a-f]{32}$/)
    expect(cdn.uploads[0]!.headers['content-type']).toBe('application/octet-stream')
    expect(item).toMatchObject({ type: ItemType.IMAGE, image_item: { media: { encrypt_query_param: 'dl-1', encrypt_type: 1 }, mid_size: 32 } })
    // The receiving side of this package reads the item it built: same bytes back.
    await expect(downloadMedia(item, { cdnBaseUrl: CDN, maxBytes: 1024, timeoutMs: 5000, fetch: cdn.fetch })).resolves.toMatchObject({ kind: 'image', data: PNG })
  })

  it('names file items and sizes video items', async () => {
    const cdn = uploadCdn()
    const client = { getUploadUrl: () => Promise.resolve({ uploadFullUrl: 'https://cdn.test/c2c/upload?encrypted_query_param=x&filekey=y' }) }
    const pdf = await uploadMedia(client, 'o', '/tmp/报告 v2.pdf', Buffer.from('%PDF-1.7 tiny'), { cdnBaseUrl: CDN, timeoutMs: 5000, fetch: cdn.fetch })
    expect(pdf.item).toMatchObject({ type: ItemType.FILE, file_item: { file_name: '报告 v2.pdf', len: '13' } })
    await expect(downloadMedia(pdf.item, { cdnBaseUrl: CDN, maxBytes: 1024, timeoutMs: 5000, fetch: cdn.fetch })).resolves.toMatchObject({ kind: 'file', name: '报告 v2.pdf', mediaType: 'application/pdf' })
    const video = await uploadMedia(client, 'o', 'clip.mov', Buffer.alloc(20), { cdnBaseUrl: CDN, timeoutMs: 5000, fetch: cdn.fetch })
    expect(video.item).toMatchObject({ type: ItemType.VIDEO, video_item: { video_size: 32 } })
  })

  it('refuses a foreign upload URL and reports CDN failures without URLs', async () => {
    const client = (answer: { uploadFullUrl?: string; uploadParam?: string }) => ({ getUploadUrl: () => Promise.resolve(answer) })
    const ok = uploadCdn()
    await expect(uploadMedia(client({ uploadFullUrl: 'https://evil.test/upload' }), 'o', 'a.png', PNG, { cdnBaseUrl: CDN, timeoutMs: 5000, fetch: ok.fetch }))
      .rejects.toThrow(/^upload URL is outside the WeChat CDN$/)
    expect(ok.uploads).toEqual([])
    await expect(uploadMedia(client({ uploadParam: 'p' }), 'o', 'a.png', PNG, { cdnBaseUrl: CDN, timeoutMs: 5000, fetch: uploadCdn({ status: 500 }).fetch }))
      .rejects.toThrow(/^CDN upload failed with HTTP 500$/)
    await expect(uploadMedia(client({ uploadParam: 'p' }), 'o', 'a.png', PNG, { cdnBaseUrl: CDN, timeoutMs: 5000, fetch: uploadCdn({ omitParam: true }).fetch }))
      .rejects.toThrow(/^CDN upload returned no download parameter$/)
  })
})

/** A file item whose key is the base64 of the raw AES key. */
function fileItem(name: string, param: string) {
  return { type: ItemType.FILE, file_item: { file_name: name, media: { encrypt_query_param: param, aes_key: KEY.toString('base64') } } }
}

/** A CDN item any failing transport can be pointed at. */
const CDN_FILE = fileItem('a.txt', 'x')

/** A fetch that never answers until its signal aborts, then rejects with the signal's reason. */
const hangingFetch: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => { reject(init.signal?.reason as Error) })
})

describe('mediaSpec of items short of parts', () => {
  it('gives no spec for text and voice items, and downloadMedia refuses them', async () => {
    expect(mediaSpec({ type: ItemType.TEXT })).toBeUndefined()
    await expect(downloadMedia({ type: ItemType.TEXT }, options(cdn({}).fetch))).rejects.toThrow(/^not a media item$/)
  })

  it('reads an image, file, or video item without its body as having no reference and no key', () => {
    expect(mediaSpec({ type: ItemType.IMAGE })).toEqual({ kind: 'image', ref: undefined, key: undefined, name: 'image' })
    expect(mediaSpec({ type: ItemType.FILE })).toEqual({ kind: 'file', ref: undefined, key: undefined, name: 'file.bin' })
    expect(mediaSpec({ type: ItemType.VIDEO })).toEqual({ kind: 'video', ref: undefined, key: undefined, name: 'video.mp4' })
  })

  it('reads a body without media as having no reference and no key', () => {
    const empty = { media: null }
    expect(mediaSpec({ type: ItemType.IMAGE, image_item: empty })).toMatchObject({ ref: undefined, key: undefined })
    expect(mediaSpec({ type: ItemType.FILE, file_item: empty })).toMatchObject({ ref: undefined, key: undefined })
    expect(mediaSpec({ type: ItemType.VIDEO, video_item: empty })).toMatchObject({ ref: undefined, key: undefined })
  })

  it('falls back to a safe name when the file name holds only path dots', () => {
    expect(mediaSpec({ type: ItemType.FILE, file_item: { file_name: '..' } })?.name).toBe('file.bin')
    expect(mediaSpec({ type: ItemType.FILE, file_item: { file_name: 'a/b/.' } })?.name).toBe('file.bin')
  })
})

describe('downloadMedia typing and limits', () => {
  it('types a video as mp4 whatever its bytes are', async () => {
    const server = cdn({ clip: encrypt(Buffer.from('frames')) })
    const item = { type: ItemType.VIDEO, video_item: { media: { encrypt_query_param: 'clip', aes_key: KEY.toString('base64') } } }
    const media = await downloadMedia(item, options(server.fetch))
    expect(media).toMatchObject({ kind: 'video', name: 'video.mp4', mediaType: 'video/mp4' })
    expect(media.data.toString()).toBe('frames')
  })

  it('types a file from its extension, and one it does not know as opaque', async () => {
    const server = cdn({ doc: encrypt(Buffer.from('%PDF')), odd: encrypt(Buffer.from('?')) })
    const typed = (name: string, param: string) => downloadMedia(fileItem(name, param), options(server.fetch))
    await expect(typed('a.PDF', 'doc')).resolves.toMatchObject({ kind: 'file', mediaType: 'application/pdf' })
    await expect(typed('a.xyz', 'odd')).resolves.toMatchObject({ mediaType: 'application/octet-stream' })
  })

  it('refuses a declared length over the limit before reading the body', async () => {
    let cancelled = false
    const body = new ReadableStream({ cancel() { cancelled = true } })
    const fetch: typeof globalThis.fetch = () => Promise.resolve(new Response(body, { headers: { 'content-length': '5000' } }))
    await expect(downloadMedia(fileItem('a.txt', 'x'), options(fetch))).rejects.toThrow(/^media exceeds 1024 bytes$/)
    expect(cancelled).toBe(true)
  })

  it('refuses a body whose plaintext passes the limit though its ciphertext fits the padding allowance', async () => {
    const server = cdn({ edge: encrypt(Buffer.alloc(17)) })
    await expect(downloadMedia(fileItem('a.txt', 'edge'), options(server.fetch, 16))).rejects.toThrow(/^media exceeds 16 bytes$/)
  })

  it('reports a body that is not valid ciphertext as undecryptable', async () => {
    const server = cdn({ torn: Buffer.from('seven b') })
    await expect(downloadMedia(fileItem('a.txt', 'torn'), options(server.fetch))).rejects.toThrow(/^media could not be decrypted$/)
  })
})

describe('CDN transport failures', () => {
  const failed = (cause: unknown): Error => new TypeError('fetch failed https://cdn.test/secret', { cause })
  const unreachable = (cause: unknown): typeof fetch => () => Promise.reject(failed(cause))
  const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
  const uploadClient = { getUploadUrl: () => Promise.resolve({ uploadParam: 'p' }) }
  const upload = (fetch: typeof globalThis.fetch, extra: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
    uploadMedia(uploadClient, 'o', 'a.txt', Buffer.from('x'), { cdnBaseUrl: CDN, timeoutMs: 5000, fetch, ...extra })

  it('names the network error code of a failed download, never the URL', async () => {
    await expect(downloadMedia(CDN_FILE, options(unreachable(refused)))).rejects.toThrow(/^CDN request failed \(ECONNREFUSED\)$/)
  })

  it('reports a failed download with no code, no cause, or no Error plainly', async () => {
    await expect(downloadMedia(CDN_FILE, options(unreachable(new Error('no code'))))).rejects.toThrow(/^CDN request failed$/)
    await expect(downloadMedia(CDN_FILE, options(unreachable('not an error')))).rejects.toThrow(/^CDN request failed$/)
    await expect(downloadMedia(CDN_FILE, options(() => Promise.reject(new Error('bare'))))).rejects.toThrow(/^CDN request failed$/)
    await expect(downloadMedia(CDN_FILE, options(async () => { throw 'not an error' }))).rejects.toThrow(/^CDN request failed$/)
  })

  it('reports a download that outlives its deadline as timed out', async () => {
    await expect(downloadMedia(CDN_FILE, { ...options(hangingFetch), timeoutMs: 1 })).rejects.toThrow(/^CDN request timed out$/)
  })

  it('passes on the caller\'s own abort of a download unchanged', async () => {
    const stop = new AbortController()
    const reason = new Error('the channel is stopping')
    const pending = downloadMedia(CDN_FILE, { ...options(hangingFetch), signal: stop.signal })
    stop.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })

  it('reports a failed upload by its network error code, and one with none plainly', async () => {
    await expect(upload(unreachable(refused))).rejects.toThrow(/^CDN request failed \(ECONNREFUSED\)$/)
    await expect(upload(() => Promise.reject(new Error('bare')))).rejects.toThrow(/^CDN request failed$/)
  })

  it('reports an upload that outlives its deadline as timed out', async () => {
    await expect(upload(hangingFetch, { timeoutMs: 1 })).rejects.toThrow(/^CDN request timed out$/)
  })

  it('passes on the caller\'s own abort of an upload unchanged', async () => {
    const stop = new AbortController()
    const reason = new Error('the channel is stopping')
    const fetch: typeof globalThis.fetch = (input, init) => {
      const answer = hangingFetch(input, init)
      stop.abort(reason)
      return answer
    }
    await expect(upload(fetch, { signal: stop.signal })).rejects.toBe(reason)
  })

  it('builds the upload URL from an empty parameter when the client names neither', async () => {
    const urls: string[] = []
    const fetch: typeof globalThis.fetch = (input) => {
      urls.push(input instanceof Request ? input.url : String(input))
      return Promise.resolve(new Response(null, { status: 200, headers: { 'x-encrypted-param': 'dl' } }))
    }
    const client = { getUploadUrl: () => Promise.resolve({}) }
    await uploadMedia(client, 'o', 'a.txt', Buffer.from('x'), { cdnBaseUrl: CDN, timeoutMs: 5000, fetch })
    expect(urls[0]).toMatch(/^https:\/\/cdn\.test\/c2c\/upload\?encrypted_query_param=&filekey=[0-9a-f]{32}$/)
  })
})

describe('saveInboxFile failures', () => {
  it('passes on a .gitignore that cannot be written, and writes no attachment', async () => {
    const inbox = join(dir, 'inbox')
    await saveInboxFile(inbox, { kind: 'file', name: 'first.txt', mediaType: 'text/plain', data: Buffer.from('1') })
    const saved = readdirSync(inbox)
    rmSync(join(inbox, '.gitignore'))
    chmodSync(inbox, 0o500)
    try {
      const second = { kind: 'file', name: 'second.txt', mediaType: 'text/plain', data: Buffer.from('2') } as const
      await expect(saveInboxFile(inbox, second)).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      chmodSync(inbox, 0o700)
    }
    expect(readdirSync(inbox)).toEqual(saved.filter(name => name !== '.gitignore'))
  })
})

describe('attachmentNote of a failed file', () => {
  it('names the file that could not be received, and only the kind of anything else', () => {
    const note = attachmentNote([
      { failed: 'file', name: 'report.pdf', reason: 'CDN request timed out' },
      { failed: 'video', name: 'video.mp4', reason: 'CDN request failed' },
    ], false)
    expect(note.split('\n')).toEqual([
      'WeChat attachments:',
      '- file "report.pdf" could not be received (CDN request timed out); its content is unavailable, so do not look for it on disk.',
      '- video could not be received (CDN request failed); its content is unavailable, so do not look for it on disk.',
    ])
  })
})
