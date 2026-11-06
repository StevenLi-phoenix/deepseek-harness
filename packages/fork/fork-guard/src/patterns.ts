/**
 * The deterministic layer: patterns for contact details and identifiers, the same family `fork-style`'s line filter
 * (links, mentions, long numbers) and `fork-qq`'s group-note filter (addresses, long numbers, email) use. Pure functions,
 * no model; a refusal names the rule and never the match.
 */

import { fold } from './fold.ts'

/** A link: scheme, `www.`, a bare domain with a common ending, a Bilibili id, or a short-link host. Shared with fork-style's line filter. */
export const LINK = new RegExp(String.raw`(?:https?://|www\.|\b[\w-]+\.(?:com|cn|net|org|io|me|top|xyz|cc|tv|app|dev|ly|gg)\b|\bBV\w{10}\b|\bav\d{3,}\b|b23\.tv)`, 'iu')

/** An @ in either width. Shared with fork-style's line filter. */
export const MENTION = /[@＠]/u

/** Five digits in a row: a QQ number, a Bilibili uid, a phone number, an id. Shared with fork-style's line filter. */
export const LONG_NUMBER = /\d{5,}/u

const EMAIL = /[\w.+-]+\s*[@＠]\s*[\w-]+(?:\s*[.。]\s*[\w-]+)+/u
const CN_ID = /(?<!\d)\d{17}[\dxX](?!\d)/u
const CN_PHONE = /(?<!\d)(?:\+?86[\s-]?)?1[3-9]\d{9}(?!\d)/u
const US_PHONE = /(?<!\d)(?:\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]?[2-9]\d{2}[\s.-]?\d{4}(?!\d)/u
const BANK_RUN = /(?<!\d)\d{13,19}(?!\d)/gu
const CONTACT = new RegExp([
  String.raw`(?:微信|v信|手机号|电话|邮箱)\s*[:：]?\s*[A-Za-z0-9_.@-]{4,}`,
  String.raw`(?:\bqq\b|\bvx\b|wechat|e-?mail)\s*(?:[:：]\s*[\w.@-]{4,}|[\w.@-]*\d[\w.@-]{3,})`,
].join('|'), 'iu')
const OS_PATH = /(?:\/Users\/[A-Za-z0-9._-]+|C:\\Users\\[A-Za-z0-9._ -]+|\/home\/[A-Za-z0-9._-]+)/u
const ADDRESS = new RegExp([
  '[一-龥]{2,}(?:省|自治区|特别行政区)', '[一-龥]{2,}市[一-龥]+(?:区|县)',
  '[一-龥]+(?:路|街|巷|弄|大街|大道)(?:\\d+|[一二三四五六七八九十百]+)号',
  '小区', '公寓', '宿舍', '[一-龥]+(?:栋|号楼)',
  String.raw`\d{1,5}\s+[A-Za-z]+\s+(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr)\b`,
].join('|'), 'iu')
const URL_TOKEN = new RegExp(
  String.raw`(?:https?://|www\.)[^\s]*[?&#][\w.-]*(?:token|key|secret|sig|auth|session|passw(?:or)?d|pwd|ticket|code|uid|openid)[\w.-]*=[^\s&]+`,
  'iu',
)

/** One refusal rule: its name and the generic reason a caller may show the writer. */
export interface PatternRule {
  readonly rule: string
  readonly publicReason: string
}

const REASONS = {
  email: 'The text contains something that looks like an email address.',
  id_number: 'The text contains something that looks like an ID number.',
  phone: 'The text contains something that looks like a phone number.',
  bank_card: 'The text contains something that looks like a bank card number.',
  contact: 'The text names a contact handle.',
  url_token: 'The text contains a link that carries a token or an account id.',
  long_number: 'The text contains a long number (an account, phone, or ID number).',
  mention: 'The text mentions someone with @.',
  address: 'The text looks like an address.',
  os_path: 'The text contains a file path with an operating system user name.',
  link: 'The text contains a link.',
} as const satisfies Record<string, string>

/** Names of the rules in the order they are tried. */
export const PATTERN_RULES: readonly string[] = Object.keys(REASONS).map(key => `pattern.${key}`)

/**
 * Whether a digit string passes the Luhn check that payment card numbers carry.
 * @param digits - only digits.
 * @returns true when the checksum is valid.
 */
export function luhn(digits: string): boolean {
  let sum = 0
  let double = false
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    double = !double
  }
  return sum % 10 === 0
}

/** Options of {@link scanPatterns}. */
export interface PatternOptions {
  /** Refuse any link, not only one that carries a token. */
  readonly blockLinks: boolean
}

/**
 * Check a text against the patterns.
 * @param text - the text as written.
 * @param options - which optional rules apply.
 * @returns the first rule that matched, or undefined when none did.
 */
export function scanPatterns(text: string, options: PatternOptions): PatternRule | undefined {
  // Full-width digits and letters fold for the checks; digits split by spaces or dashes are read as one number.
  const folded = text.normalize('NFKC')
  const joined = folded.replace(/(?<=\d)[\s-](?=\d)/gu, '')
  const hit = (key: keyof typeof REASONS): PatternRule => ({ rule: `pattern.${key}`, publicReason: REASONS[key] })
  if (EMAIL.test(folded)) return hit('email')
  if (CN_ID.test(joined)) return hit('id_number')
  if (CN_PHONE.test(joined) || US_PHONE.test(folded)) return hit('phone')
  for (const run of joined.match(BANK_RUN) ?? []) if (luhn(run)) return hit('bank_card')
  if (CONTACT.test(fold(text))) return hit('contact')
  if (URL_TOKEN.test(folded)) return hit('url_token')
  if (LONG_NUMBER.test(joined)) return hit('long_number')
  if (MENTION.test(text)) return hit('mention')
  if (ADDRESS.test(folded)) return hit('address')
  if (OS_PATH.test(folded)) return hit('os_path')
  if (options.blockLinks && LINK.test(folded)) return hit('link')
  return undefined
}
