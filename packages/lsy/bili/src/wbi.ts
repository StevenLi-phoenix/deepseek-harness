/**
 * WBI request signing. Several Bilibili web endpoints require `wts` (Unix
 * seconds) and `w_rid` (an MD5 over the sorted query and a "mixin key"). The
 * mixin key is a fixed permutation of two keys the `nav` answer publishes as
 * image file names; they rotate daily, so callers cache them for at most a day.
 */
import { createHash } from 'node:crypto'

/** Permutation that picks the mixin key's characters out of `imgKey + subKey`. */
const MIXIN_KEY_TABLE: readonly number[] = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
]

/** Characters the signer removes from every value before hashing. */
const FILTERED_CHARS = /[!'()*]/g

/** The two keys published by `nav` (`wbi_img.img_url` and `sub_url`). */
export interface WbiKeys {
  readonly imgKey: string
  readonly subKey: string
}

/**
 * The 32-character mixin key of one key pair.
 * @param keys - the published keys.
 * @returns the key appended to the query before hashing.
 */
export function mixinKey(keys: WbiKeys): string {
  const raw = keys.imgKey + keys.subKey
  return MIXIN_KEY_TABLE.map(index => raw[index] ?? '').join('').slice(0, 32)
}

/**
 * The file name stem of a `wbi_img` URL, which is the key itself.
 * @param url - e.g. `https://i0.hdslb.com/bfs/wbi/7cd0…077c.png`.
 * @returns the stem, or undefined when the URL has no file name.
 */
export function keyFromUrl(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined
  const name = url.slice(url.lastIndexOf('/') + 1)
  const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name
  return /^[0-9a-zA-Z]{16,64}$/.test(stem) ? stem : undefined
}

/**
 * Sign query parameters: add `wts`, sort by key, drop `!'()*` from values,
 * percent-encode, and append `w_rid`.
 * @param params - query parameters without `wts` or `w_rid`.
 * @param keys - the current key pair.
 * @param nowSeconds - Unix seconds stamped as `wts`.
 * @returns the signed query string, `w_rid` last.
 */
export function signQuery(params: Readonly<Record<string, string | number>>, keys: WbiKeys, nowSeconds: number): string {
  const entries: [string, string][] = Object.entries({ ...params, wts: nowSeconds })
    .map(([key, value]) => [key, String(value).replace(FILTERED_CHARS, '')])
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const query = entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')
  const rid = createHash('md5').update(query + mixinKey(keys)).digest('hex')
  return `${query}&w_rid=${rid}`
}
