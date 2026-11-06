/** Downloading what a message carried: address checks, size caps, type detection, and content-addressed files. */
import { createHash } from 'node:crypto'
import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DEFAULT_MEDIA_HOST_SUFFIXES } from './address.ts'

export { DEFAULT_MEDIA_HOST_SUFFIXES }

/**
 * Whether a media link may be fetched: HTTPS, a plain host name (no IP address, no port), and a suffix on the list. Keeps a crafted
 * message from pointing the collector at an address on this machine or the network.
 * @param raw - the link.
 * @param suffixes - allowed host suffixes with the leading dot; a bare host equal to a suffix without its dot also passes.
 * @returns true when the link may be fetched.
 */
export function isAllowedMediaUrl(raw: string, suffixes: readonly string[] = DEFAULT_MEDIA_HOST_SUFFIXES): boolean {
  const url = URL.parse(raw)
  if (url === null || url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return false
  const host = url.hostname.toLowerCase()
  if (/^[0-9.]+$/.test(host) || host.includes(':')) return false
  return suffixes.some(suffix => host.endsWith(suffix) || host === suffix.slice(1))
}

/** A fetched body, capped. */
export class MediaTooLarge extends Error {}

/**
 * Fetch a link with a deadline and a size cap. Redirects are not followed.
 * @param url - the link; the caller checks it with {@link isAllowedMediaUrl}.
 * @param maxBytes - the size cap in bytes, checked against `content-length` and while streaming.
 * @param timeoutMs - the deadline for the whole fetch, in milliseconds.
 * @param fetchImpl - the fetch function; tests replace it.
 * @returns the body.
 * @throws {@link MediaTooLarge} when the body exceeds `maxBytes`.
 * @throws {@link Error} when the answer is a redirect or not OK, has no body, or does not arrive in time.
 */
export async function fetchCapped(url: string, maxBytes: number, timeoutMs: number, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
  if (response.status >= 300 && response.status < 400) throw new Error(`redirected (HTTP ${response.status}); not followed`)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) throw new MediaTooLarge(`${declared} bytes exceeds ${maxBytes}`)
  if (response.body === null) throw new Error('empty body')
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength
    if (total > maxBytes) throw new MediaTooLarge(`more than ${maxBytes} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * File extension for downloaded bytes: from the content for images and audio, from a name for others.
 * @param bytes - the downloaded content.
 * @param kind - the media kind; `image` falls back to `.img`, anything else to `.bin`.
 * @param name - the original file name, used when the content is not recognised.
 * @returns the extension with its dot.
 */
export function detectExtension(bytes: Buffer, kind: string, name?: string): string {
  if (bytes.length >= 12) {
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png'
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return '.jpg'
    if (bytes.subarray(0, 4).toString('latin1') === 'GIF8') return '.gif'
    if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp'
    if (bytes.subarray(4, 12).toString('latin1') === 'ftypheic' || bytes.subarray(4, 12).toString('latin1') === 'ftypmif1') return '.heic'
    if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WAVE') return '.wav'
    if (bytes.subarray(0, 3).toString('latin1') === 'ID3' || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return '.mp3'
    if (bytes.subarray(0, 5).toString('latin1') === '#!AMR') return '.amr'
    if (bytes.subarray(0, 10).toString('latin1').includes('SILK')) return '.silk'
  }
  const fromName = /\.[A-Za-z0-9]{1,5}$/.exec(name ?? '')?.[0]?.toLowerCase()
  if (fromName !== undefined) return fromName
  return kind === 'image' ? '.img' : '.bin'
}

/** The month a message belongs to, `YYYYMM`, in UTC. */
function month(at: number): string {
  const date = new Date(at)
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Write bytes to `<dir>/media/<group>/<YYYYMM>/<sha256>.<ext>` (mode 0600; a file already there is kept: the name is its content).
 * @param dir - the recorder's data directory.
 * @param groupId - the QQ group number; a value that is not 3 to 20 digits is replaced by a hash prefix in the path.
 * @param at - the message time in epoch milliseconds, which picks the month folder (UTC).
 * @param bytes - the content.
 * @param extension - the extension with its dot.
 * @returns the path, the hash, and the size.
 */
export async function saveMedia(
  dir: string, groupId: string, at: number, bytes: Buffer, extension: string,
): Promise<{ path: string; sha256: string; bytes: number }> {
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const safeGroup = /^[0-9]{3,20}$/.test(groupId) ? groupId : createHash('sha256').update(groupId).digest('hex').slice(0, 16)
  const folder = join(dir, 'media', safeGroup, month(at))
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const path = join(folder, `${sha256}${extension}`)
  const exists = await stat(path).then(() => true, () => false)
  if (!exists) {
    const temporary = `${path}.part`
    await writeFile(temporary, bytes, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, path)
  }
  return { path, sha256, bytes: bytes.length }
}

/**
 * Delete a downloaded file; a file already gone is fine.
 * @param path - the file to delete.
 */
export async function removeMedia(path: string): Promise<void> {
  await rm(path, { force: true })
}
