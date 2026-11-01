/** Zero-width and bidirectional control characters that hide a string inside another. */
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu

/**
 * Fold a text for comparison: compatibility forms (full-width letters and digits) become plain, invisible characters go,
 * letters lower-case.
 * @param text - any text.
 */
export function fold(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '').toLowerCase()
}

/**
 * Fold a text and keep only letters and digits, so spacing, punctuation, and separators cannot split a match.
 * @param text - any text.
 */
export function squash(text: string): string {
  return fold(text).replace(/[^\p{L}\p{N}]+/gu, '')
}
