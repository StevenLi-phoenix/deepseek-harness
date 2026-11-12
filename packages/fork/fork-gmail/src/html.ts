/**
 * HTML mail bodies as plain text, in one linear pass over at most a bounded prefix: block elements become line breaks,
 * a link keeps its address after its text, `script`, `style`, `head`, and comments are dropped, and entities are
 * decoded. No DOM is built, so a hostile message cannot make the conversion slow; markup never reaches the model.
 */

/** Elements whose start or end begins a new line. */
const BLOCK = new Set([
  'address', 'article', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'li', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
])

/** Elements dropped with everything inside them. */
const DROPPED = ['script', 'style', 'head', 'title', 'noscript', 'template']

/** Named entities mail commonly uses. */
const NAMED: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '', zwj: '',
  mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', middot: '·', bull: '•', deg: '°', times: '×', divide: '÷', euro: '€', pound: '£',
  yen: '¥', cent: '¢', sect: '§', para: '¶', shy: '',
}

/**
 * Decode HTML entities; unknown names stay as written.
 * @param text - text with entities.
 * @returns the decoded text.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/giu, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      return code > 0 && code <= 0x10FFFF && !(code >= 0xD800 && code <= 0xDFFF) ? String.fromCodePoint(code) : ''
    }
    return NAMED[body.toLowerCase()] ?? whole
  })
}

/** Drop `<name …>…</name>` blocks by position search (linear; an unclosed block drops the rest). */
function dropBlocks(html: string): string {
  let out = html
  for (const name of DROPPED) {
    // ASCII-only lower case keeps every index aligned with `out` (full Unicode lower-casing can change lengths).
    const lower = out.replace(/[A-Z]/gu, char => char.toLowerCase())
    let result = ''
    let at = 0
    for (;;) {
      const start = lower.indexOf(`<${name}`, at)
      if (start === -1) break
      const after = lower.charAt(start + name.length + 1)
      if (after !== '' && !/[\s>/]/u.test(after)) {
        result += out.slice(at, start + 1)
        at = start + 1
        continue
      }
      result += out.slice(at, start)
      const end = lower.indexOf(`</${name}`, start)
      if (end === -1) {
        at = out.length
        break
      }
      const close = lower.indexOf('>', end)
      at = close === -1 ? out.length : close + 1
    }
    out = result + out.slice(at)
  }
  return out
}

/** Drop `<!-- … -->` comments (linear; an unclosed comment drops the rest). */
function dropComments(html: string): string {
  let result = ''
  let at = 0
  for (;;) {
    const start = html.indexOf('<!--', at)
    if (start === -1) return result + html.slice(at)
    result += html.slice(at, start)
    const end = html.indexOf('-->', start + 4)
    if (end === -1) return result
    at = end + 3
  }
}

/** The `href` of an `<a …>` tag, when it is an http(s) or mailto address. */
function hrefOf(tag: string): string | undefined {
  const match = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(tag)
  const href = decodeEntities((match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim())
  return /^(?:https?:|mailto:)/iu.test(href) ? href : undefined
}

/**
 * Convert an HTML body to text.
 * @param html - the body.
 * @param maxInputChars - characters of the source read at most.
 * @returns the text, with single blank lines between blocks and no trailing spaces.
 */
export function htmlToText(html: string, maxInputChars: number): string {
  const source = dropComments(dropBlocks(html.slice(0, maxInputChars)))
  let out = ''
  let at = 0
  let link: { href: string; start: number } | undefined
  while (at < source.length) {
    const open = source.indexOf('<', at)
    if (open === -1) {
      out += decodeEntities(source.slice(at))
      break
    }
    out += decodeEntities(source.slice(at, open))
    const close = source.indexOf('>', open)
    if (close === -1) break
    const tag = source.slice(open + 1, close)
    at = close + 1
    const name = /^\/?\s*([a-z][a-z0-9]*)/iu.exec(tag)?.[1]?.toLowerCase()
    if (name === undefined) continue
    const ending = tag.startsWith('/')
    if (name === 'a' && !ending) {
      const href = hrefOf(tag)
      link = href === undefined ? undefined : { href, start: out.length }
    } else if (name === 'a' && link !== undefined) {
      const label = out.slice(link.start).trim()
      const bare = link.href.replace(/^mailto:/iu, '')
      if (label !== bare && label !== link.href) out += ` (${link.href})`
      link = undefined
    } else if (name === 'img' && !ending) {
      const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/iu.exec(tag)
      const text = decodeEntities(alt?.[1] ?? alt?.[2] ?? '').trim()
      if (text !== '') out += `[${text}]`
    } else if (BLOCK.has(name)) {
      out += name === 'li' && !ending ? '\n- ' : name === 'td' || name === 'th' ? ' ' : '\n'
    }
  }
  return tidy(out)
}

/**
 * Normalize whitespace: spaces within a line collapsed, lines trimmed, at most one blank line in a row.
 * @param text - the text.
 * @returns the tidied text.
 */
export function tidy(text: string): string {
  return text
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t ]+/gu, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}
