/**
 * Whether a text repeats a distinctive span of the owner's memory, as a yes or no. The spans are 6 consecutive CJK
 * characters, or 3 consecutive words of a Latin-script text once a few filler words are dropped. Nothing that matched
 * is returned, so a caller that publishes text can ask without ever holding a fact.
 */

/** Consecutive Han, kana, or Hangul characters that make a span. */
export const CJK_SPAN = 6

/** Consecutive non-filler words that make a span. */
export const WORD_SPAN = 3

/** Filler words that never make a span on their own. */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'am',
  'with', 'by', 'as', 'it', 'its', 'this', 'that', 'i', 'my', 'me', 'you', 'your', 'he', 'his', 'she', 'her', 'they', 'their',
  'we', 'our', 'from', 'has', 'have', 'had', 'do', 'does', 'not', 'no', 'if', 'so', 'than', 'then', 'into', 'about',
])

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu
const WORD = /[\p{L}\p{N}]+/gu

/**
 * The span keys of a text: every CJK window of {@link CJK_SPAN} characters and every run of {@link WORD_SPAN} words.
 * @param text - any text; folded with NFKC and lower-cased first.
 * @returns opaque keys; two texts share a span when their key sets intersect.
 */
export function spanKeys(text: string): Set<string> {
  const folded = text.normalize('NFKC').toLowerCase()
  const keys = new Set<string>()
  for (const run of folded.match(CJK) ?? []) {
    const chars = Array.from(run)
    for (let start = 0; start + CJK_SPAN <= chars.length; start += 1) keys.add(`c:${chars.slice(start, start + CJK_SPAN).join('')}`)
  }
  // A CJK run or a sentence stop ends a run of words, so words on either side never join.
  for (const segment of folded.replace(CJK, '\n').split(/[\n.!?;。！？；]+/u)) {
    const words = (segment.match(WORD) ?? []).filter(word => !STOPWORDS.has(word) && Array.from(word).length > 1)
    for (let start = 0; start + WORD_SPAN <= words.length; start += 1) keys.add(`w:${words.slice(start, start + WORD_SPAN).join(' ')}`)
  }
  return keys
}

/**
 * Whether two span-key sets share a key.
 * @param left - keys of one text.
 * @param right - keys of another.
 */
export function sharesSpan(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  for (const key of small) if (large.has(key)) return true
  return false
}
