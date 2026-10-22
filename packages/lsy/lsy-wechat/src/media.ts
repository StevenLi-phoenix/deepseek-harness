/**
 * WeChat media: inbound download from the WeChat CDN with AES-128-ECB
 * decryption, type detection, and the owner-only inbox the agent reads files
 * from; outbound encryption and upload of a local file as an image, video, or
 * file item.
 *
 * The CDN reference layout, the two `aes_key` encodings, and the origin check
 * follow xiaoshihou514/dsh-weixin (MIT, src/media.ts and src/protocol.ts) and
 * Tencent's @tencent-weixin/openclaw-weixin (src/cdn/pic-decrypt.ts).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { ItemType, UploadMediaType, type CdnMediaRef, type IlinkClient, type WeixinItem } from './api.ts'

/** Media the channel downloads; voice arrives as its transcript instead. */
export type MediaKind = 'image' | 'file' | 'video'

/** Image formats a Session prompt accepts. */
export type PromptImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

/** One downloaded and decrypted attachment. */
export interface InboundMedia {
  kind: MediaKind
  /** Safe leaf name, never a path. */
  name: string
  mediaType: string
  data: Buffer
}

/** Where and how to fetch one item. */
export interface MediaSpec {
  kind: MediaKind
  ref: CdnMediaRef | undefined
  /** base64 key as the CDN reference carries it; see {@link parseMediaKey}. */
  key: string | undefined
  /** Leaf name before type detection (images get their extension from the bytes). */
  name: string
}

/** Download limits and transport. */
export interface DownloadOptions {
  /** CDN base, for example `https://novac2c.cdn.weixin.qq.com/c2c`; `full_url` must share its origin. */
  cdnBaseUrl: string
  /** Largest decrypted attachment accepted. */
  maxBytes: number
  timeoutMs: number
  fetch?: typeof fetch
  signal?: AbortSignal
}

const FILE_TYPES: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.zip': 'application/zip', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}
const IMAGE_EXTENSION: Readonly<Record<PromptImageType, string>> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
}

/**
 * Decode a CDN media key: images carry base64 of the 16 raw bytes; files,
 * voice, and video carry base64 of those bytes as 32 hex characters.
 * @param encoded - the key as the reference carries it.
 * @returns the 16-byte AES key.
 */
export function parseMediaKey(encoded: string): Buffer {
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.length === 16) return decoded
  const text = decoded.toString('ascii')
  if (decoded.length === 32 && /^[0-9a-f]{32}$/i.test(text)) return Buffer.from(text, 'hex')
  throw new Error('media AES key is invalid')
}

/**
 * Detect a prompt-supported image format from its leading bytes.
 * @param data - decrypted bytes.
 * @returns the media type, or undefined for anything else.
 */
export function sniffImageType(data: Uint8Array): PromptImageType | undefined {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif'
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return undefined
}

/** A leaf name without path parts, control characters, or shell-hostile symbols. */
function safeName(input: string, fallback: string): string {
  const cleaned = basename(input.replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '_').replace(/[^\p{L}\p{N}._ -]/gu, '_').trim()
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? fallback : cleaned.slice(0, 120)
}

/**
 * The download spec of one item.
 * @param item - one inbound message item.
 * @returns the spec, or undefined for text and voice items.
 */
export function mediaSpec(item: WeixinItem): MediaSpec | undefined {
  switch (item.type) {
    case ItemType.IMAGE: {
      const image = item.image_item
      // The hex image key is the one inbound decryption should use; media.aes_key is the fallback.
      const key = image?.aeskey ? Buffer.from(image.aeskey, 'hex').toString('base64') : image?.media?.aes_key ?? undefined
      return { kind: 'image', ref: image?.media ?? undefined, key, name: 'image' }
    }
    case ItemType.FILE:
      return { kind: 'file', ref: item.file_item?.media ?? undefined, key: item.file_item?.media?.aes_key ?? undefined, name: safeName(item.file_item?.file_name ?? '', 'file.bin') }
    case ItemType.VIDEO:
      return { kind: 'video', ref: item.video_item?.media ?? undefined, key: item.video_item?.media?.aes_key ?? undefined, name: 'video.mp4' }
    default:
      return undefined
  }
}

/** Fetch failures as safe text: CDN URLs carry the encrypted parameter and never reach a log or prompt. */
function requestFailure(error: unknown, timedOut: boolean): Error {
  if (timedOut) return new Error('CDN request timed out')
  const cause = error instanceof Error && error.cause instanceof Error ? (error.cause as NodeJS.ErrnoException).code : undefined
  return new Error(cause === undefined ? 'CDN request failed' : `CDN request failed (${cause})`)
}

/**
 * Download and decrypt one media item.
 * @param item - an image, file, or video item.
 * @param options - CDN base, size cap, deadline, and transport.
 * @returns the attachment, typed from its bytes (images) or its name (files).
 * @throws Error with a reason fit for the owner and the agent; it never includes the CDN URL.
 */
export async function downloadMedia(item: WeixinItem, options: DownloadOptions): Promise<InboundMedia> {
  const spec = mediaSpec(item)
  if (spec === undefined) throw new Error('not a media item')
  if (spec.key === undefined || spec.key === '') throw new Error('media AES key is missing')
  const key = parseMediaKey(spec.key)
  const base = options.cdnBaseUrl.replace(/\/+$/, '')
  const direct = spec.ref?.full_url?.trim()
  const param = spec.ref?.encrypt_query_param
  const url = direct || (param ? `${base}/download?encrypted_query_param=${encodeURIComponent(param)}` : '')
  if (url === '') throw new Error('media download URL is missing')
  const target = new URL(url)
  if (target.origin !== new URL(base).origin) throw new Error('media URL is outside the WeChat CDN')

  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  let encrypted: Buffer
  try {
    const response = await (options.fetch ?? fetch)(target, { redirect: 'error', signal })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`CDN download failed with HTTP ${response.status}`)
    }
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > options.maxBytes + 16) {
      await response.body?.cancel()
      throw new Error(`media exceeds ${options.maxBytes} bytes`)
    }
    encrypted = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    if (options.signal?.aborted === true) throw error
    if (error instanceof Error && /^(CDN download failed|media exceeds)/.test(error.message)) throw error
    throw requestFailure(error, timeout.aborted)
  }
  if (encrypted.byteLength > options.maxBytes + 16) throw new Error(`media exceeds ${options.maxBytes} bytes`)
  let data: Buffer
  try {
    const decipher = createDecipheriv('aes-128-ecb', key, null)
    data = Buffer.concat([decipher.update(encrypted), decipher.final()])
  } catch {
    throw new Error('media could not be decrypted')
  }
  if (data.byteLength > options.maxBytes) throw new Error(`media exceeds ${options.maxBytes} bytes`)

  if (spec.kind === 'image') {
    const type = sniffImageType(data)
    return type === undefined
      ? { kind: 'image', name: 'image.bin', mediaType: 'application/octet-stream', data }
      : { kind: 'image', name: `image.${IMAGE_EXTENSION[type]}`, mediaType: type, data }
  }
  if (spec.kind === 'video') return { kind: 'video', name: spec.name, mediaType: 'video/mp4', data }
  return { kind: 'file', name: spec.name, mediaType: FILE_TYPES[extname(spec.name).toLowerCase()] ?? 'application/octet-stream', data }
}

/**
 * Write one attachment into the inbox: the directory is created owner-only
 * (0700) and ignores itself through its own `.gitignore`, so a workspace that
 * is a git repository never commits the owner's attachments; the file is
 * owner-only (0600) and never written over an existing one.
 * @param directory - absolute inbox directory.
 * @param media - the attachment.
 * @param now - receipt time, which leads the file name.
 * @returns the absolute path written.
 */
export async function saveInboxFile(directory: string, media: InboundMedia, now: Date = new Date()): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(directory, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  })
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const path = join(directory, `${stamp}-${randomBytes(4).toString('hex')}-${media.name}`)
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(media.data)
  } finally {
    await file.close()
  }
  return path
}

/**
 * One-line description for the prompt and the logs.
 * @param media - the attachment.
 * @returns kind, file name for files, media type, and size.
 */
export function describeMedia(media: InboundMedia): string {
  const bytes = media.data.byteLength
  const size = bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
  const what = media.kind === 'file' ? `file "${media.name}"` : media.kind
  return `${what} (${media.mediaType}, ${size})`
}

/** Largest image handed to the Session as an image part; the Host's default image limit. */
export const PROMPT_IMAGE_MAX_BYTES = 20 * 1024 * 1024

/** One media item of an owner message after the download attempt. */
export type ReceivedMedia =
  | { media: InboundMedia; path: string }
  | { failed: MediaKind; name: string; reason: string }

/**
 * Whether a received attachment goes into the prompt as an image part.
 * @param received - one received item.
 * @returns true for a typed image within {@link PROMPT_IMAGE_MAX_BYTES}.
 */
export function isPromptImage(received: ReceivedMedia): received is { media: InboundMedia & { mediaType: PromptImageType }; path: string } {
  return 'media' in received && received.media.kind === 'image' && received.media.mediaType in IMAGE_EXTENSION
    && received.media.data.byteLength <= PROMPT_IMAGE_MAX_BYTES
}

/**
 * The model-facing note listing what each attachment became, appended to the
 * owner's text. A failed item says its content is unavailable, so the agent
 * does not go looking for it.
 * @param received - the message's media items in order.
 * @param imagesAttached - whether the prompt carries the image parts.
 * @returns the note, or an empty string when the message had no media.
 */
export function attachmentNote(received: readonly ReceivedMedia[], imagesAttached: boolean): string {
  if (received.length === 0) return ''
  const lines = received.map((item) => {
    if ('failed' in item) {
      const what = item.failed === 'file' ? `file "${item.name}"` : item.failed
      return `- ${what} could not be received (${item.reason}); its content is unavailable, so do not look for it on disk.`
    }
    const where = `- ${describeMedia(item.media)} saved at ${item.path}`
    if (!isPromptImage(item)) return `${where}.`
    return imagesAttached ? `${where}; it is attached to this message.` : `${where}; the current model does not accept images.`
  })
  return ['WeChat attachments:', ...lines].join('\n')
}

/** What an outgoing attachment is sent as. */
export type OutboundKind = 'image' | 'video' | 'file'

const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(['.mp4', '.mov', '.m4v'])
const UPLOAD_TYPE: Record<OutboundKind, (typeof UploadMediaType)[keyof typeof UploadMediaType]> = {
  image: UploadMediaType.IMAGE, video: UploadMediaType.VIDEO, file: UploadMediaType.FILE,
}

/**
 * How an outgoing file is sent: a picture when its bytes are a PNG, JPEG, GIF,
 * or WebP image, a video for `.mp4`, `.mov`, and `.m4v`, a file otherwise.
 * @param name - file name, for the extension.
 * @param data - file content.
 * @returns the kind.
 */
export function outboundKind(name: string, data: Uint8Array): OutboundKind {
  if (sniffImageType(data) !== undefined) return 'image'
  if (VIDEO_EXTENSIONS.has(extname(name).toLowerCase())) return 'video'
  return 'file'
}

/** Upload deadline, destination check, and transport. */
export interface UploadOptions {
  /** CDN base; an upload URL must share its origin. */
  cdnBaseUrl: string
  timeoutMs: number
  fetch?: typeof fetch
  signal?: AbortSignal
}

/**
 * Encrypt one file with a fresh AES-128 key, upload it to the WeChat CDN for a
 * recipient, and build the message item that delivers it. The flow follows
 * xiaoshihou514/dsh-weixin (MIT, `sendMedia`) and @tencent-weixin/openclaw-weixin
 * (`src/cdn/upload.ts`): `getuploadurl`, POST the ciphertext, read the download
 * parameter from `x-encrypted-param`.
 * @param client - iLink client of the bot account.
 * @param to - recipient user id.
 * @param name - file name shown for a file item.
 * @param data - file content.
 * @param options - CDN base, deadline, and transport.
 * @returns the kind and the item for `sendmessage`.
 * @throws Error with a reason fit for the agent; it never includes an upload URL.
 */
export async function uploadMedia(
  client: Pick<IlinkClient, 'getUploadUrl'>, to: string, name: string, data: Buffer, options: UploadOptions,
): Promise<{ kind: OutboundKind; item: Record<string, unknown> }> {
  const kind = outboundKind(name, data)
  const key = randomBytes(16)
  const filekey = randomBytes(16).toString('hex')
  const cipher = createCipheriv('aes-128-ecb', key, null)
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()])
  const { uploadFullUrl, uploadParam } = await client.getUploadUrl({
    filekey,
    media_type: UPLOAD_TYPE[kind],
    to_user_id: to,
    rawsize: data.byteLength,
    rawfilemd5: createHash('md5').update(data).digest('hex'),
    filesize: ciphertext.byteLength,
    aeskey: key.toString('hex'),
  }, options.signal)
  const base = options.cdnBaseUrl.replace(/\/+$/, '')
  const url = new URL(uploadFullUrl
    ?? `${base}/upload?encrypted_query_param=${encodeURIComponent(uploadParam ?? '')}&filekey=${encodeURIComponent(filekey)}`)
  if (url.origin !== new URL(base).origin) throw new Error('upload URL is outside the WeChat CDN')

  const timeout = AbortSignal.timeout(options.timeoutMs)
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(ciphertext),
      redirect: 'error',
      signal: options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]),
    })
  } catch (error) {
    if (options.signal?.aborted === true) throw error
    throw requestFailure(error, timeout.aborted)
  }
  await response.body?.cancel()
  if (!response.ok) throw new Error(`CDN upload failed with HTTP ${response.status}`)
  const downloadParam = response.headers.get('x-encrypted-param')
  if (downloadParam === null || downloadParam === '') throw new Error('CDN upload returned no download parameter')

  // The key travels as base64 of its hex spelling, the encoding parseMediaKey's second branch reads.
  const media = { encrypt_query_param: downloadParam, aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 }
  switch (kind) {
    case 'image':
      return { kind, item: { type: ItemType.IMAGE, image_item: { media, mid_size: ciphertext.byteLength } } }
    case 'video':
      return { kind, item: { type: ItemType.VIDEO, video_item: { media, video_size: ciphertext.byteLength } } }
    case 'file':
      return { kind, item: { type: ItemType.FILE, file_item: { media, file_name: safeName(name, 'file.bin'), len: String(data.byteLength) } } }
  }
}
