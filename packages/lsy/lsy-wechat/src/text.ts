/** Pure text handling: inbound extraction, outbound size limits, reply framing, and outbox digests. */
import { isSilentReply, type LsyNote } from '@deepseek-ai/dsh-lsy-event-bus'
import { ItemType, type WeixinItem, type WeixinMessage } from './api.ts'

/** Third-party-documented ceiling of one WeChat text message in UTF-8 bytes. */
export const WECHAT_MAX_TEXT_BYTES = 16_384
/** Appended to the message that uses the last reply slot of a window. */
export const QUOTA_FOOTER = '\n\n（消息额度已用完，回复任意消息继续接收）'
/** Reply to `/new`. */
export const NEW_CHAT_REPLY = '已开始新对话。'
/** Characters of a quoted message kept in front of the owner's text. */
const MAX_QUOTE_CHARS = 200
/** Separator between digest entries. */
const DIGEST_RULE = '────────'

/**
 * Keep at most `maxChars` code points and `maxBytes` UTF-8 bytes, ending a cut text with `…`.
 * @param text - text to bound.
 * @param maxChars - code points kept, including the ellipsis.
 * @param maxBytes - UTF-8 bytes kept, including the ellipsis.
 * @returns the text, or a prefix of it plus `…`.
 */
export function fitText(text: string, maxChars: number, maxBytes: number = WECHAT_MAX_TEXT_BYTES): string {
  const points = Array.from(text)
  if (points.length <= maxChars && Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let kept = ''
  let bytes = Buffer.byteLength('…', 'utf8')
  for (const point of points.slice(0, Math.max(0, maxChars - 1))) {
    bytes += Buffer.byteLength(point, 'utf8')
    if (bytes > maxBytes) break
    kept += point
  }
  return `${kept}…`
}

/**
 * Split text into messages of at most `maxChars` code points, preferring line
 * breaks, and label the parts `[i/n]`. Beyond `maxParts` the last part is cut.
 * @param text - text to send.
 * @param maxChars - code points per message, labels included.
 * @param maxParts - messages at most.
 * @param maxBytes - UTF-8 bytes per message.
 * @returns one or more messages.
 */
export function splitText(text: string, maxChars: number, maxParts: number, maxBytes: number = WECHAT_MAX_TEXT_BYTES): string[] {
  if (Array.from(text).length <= maxChars && Buffer.byteLength(text, 'utf8') <= maxBytes) return [text]
  // Room for a `[n/n]\n` label; byte budgets assume 4 bytes per code point at worst.
  const budget = Math.max(1, Math.min(maxChars - 8, Math.floor((maxBytes - 16) / 4)))
  const chunks: string[] = []
  let rest = Array.from(text)
  while (rest.length > 0 && chunks.length < maxParts) {
    if (chunks.length === maxParts - 1 || rest.length <= budget) {
      chunks.push(fitText(rest.join(''), budget, budget * 4))
      break
    }
    const window = rest.slice(0, budget)
    const lineBreak = window.lastIndexOf('\n')
    const cut = lineBreak >= budget / 2 ? lineBreak + 1 : budget
    chunks.push(rest.slice(0, cut).join('').trimEnd())
    rest = rest.slice(cut)
  }
  return chunks.map((chunk, index) => `[${index + 1}/${chunks.length}]\n${chunk}`)
}

/**
 * Plain text of a note: title, body, and link separated by blank lines.
 * @param note - bus notification.
 * @returns the text WeChat shows; it renders no Markdown.
 */
export function renderNote(note: LsyNote): string {
  return [note.title, note.body, note.url].filter(part => part !== undefined && part.trim() !== '').join('\n\n')
}

/** Text or placeholder of one item; empty for items that carry nothing usable. */
function itemText(item: WeixinItem): string {
  switch (item.type) {
    case ItemType.TEXT:
      return item.text_item?.text ?? ''
    case ItemType.VOICE: {
      const said = item.voice_item?.text?.trim()
      return said ? `[语音] ${said}` : '[语音]'
    }
    case ItemType.IMAGE:
      return '[图片]'
    case ItemType.FILE: {
      const name = item.file_item?.file_name?.trim()
      return name ? `[文件 ${name}]` : '[文件]'
    }
    case ItemType.VIDEO:
      return '[视频]'
    default:
      return ''
  }
}

/**
 * Prompt text of one inbound message: a short quote prefix, the text items,
 * speech-to-text of voice items, and placeholders for media.
 * @param message - inbound message.
 * @returns the text, or an empty string when nothing usable was sent.
 */
export function inboundText(message: WeixinMessage): string {
  const lines: string[] = []
  for (const item of message.item_list ?? []) {
    const quote = item.ref_msg
    if (quote !== null && quote !== undefined) {
      const quoted = (quote.message_item ? itemText(quote.message_item) : '') || (quote.title ?? '')
      const flat = quoted.replace(/\s+/g, ' ').trim()
      if (flat !== '') lines.push(`[引用] ${fitText(flat, MAX_QUOTE_CHARS)}`)
    }
    const text = itemText(item)
    if (text !== '') lines.push(text)
  }
  return lines.join('\n').trim()
}

/**
 * Concatenated text parts of one message content.
 * @param content - content parts of an assistant message.
 * @returns the joined text, or undefined when it has none.
 */
export function contentText(content: readonly unknown[]): string | undefined {
  const text = content
    .filter((part): part is { type: 'text'; text: string } => typeof part === 'object' && part !== null
      && 'type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
    .trim()
  return text === '' ? undefined : text
}

/**
 * What to tell the owner when a chat turn ends.
 * @param text - final assistant text of the turn, if any.
 * @param outcome - `TurnEndReason.kind`.
 * @returns the message, or undefined when the turn needs none.
 */
export function relayText(text: string | undefined, outcome: string): string | undefined {
  if (isSilentReply(text)) return undefined
  const warning = `⚠️ 本轮未完成（${outcome}）`
  if (text === undefined) return outcome === 'completed' ? undefined : warning
  return outcome === 'completed' ? text : `${text}\n\n${warning}`
}

/** One undelivered text. */
export interface QueuedText {
  text: string
  /** Unix epoch milliseconds. */
  queuedAt: number
}

/** One digest message and how many queued texts it carries. */
export interface Digest {
  text: string
  count: number
}

/**
 * Pack the oldest queued texts into one message within the limits. The first
 * text is always included, cut when it does not fit on its own.
 * @param queued - queued texts, oldest first; not empty.
 * @param maxChars - code points of the message.
 * @param timeZone - IANA zone for the queue timestamps.
 * @param maxBytes - UTF-8 bytes of the message.
 * @returns the message and the number of texts it carries.
 */
export function buildDigest(
  queued: readonly QueuedText[],
  maxChars: number,
  timeZone: string,
  maxBytes: number = WECHAT_MAX_TEXT_BYTES,
): Digest {
  const stamp = new Intl.DateTimeFormat('zh-CN', {
    timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  const header = (count: number): string => count === queued.length
    ? `📬 未送达的 ${count} 条消息`
    : `📬 未送达的消息 ${count}/${queued.length}（其余稍后送达）`
  // The widest header any count can produce; reserved before packing entries.
  const reserve = Array.from(header(0)).length + 4
  const entries: string[] = []
  let chars = reserve
  let bytes = Buffer.byteLength(header(0), 'utf8') + 16
  for (const item of queued) {
    const entry = `${DIGEST_RULE} ${stamp.format(item.queuedAt)}\n${item.text}`
    const entryChars = Array.from(entry).length + 2
    const entryBytes = Buffer.byteLength(entry, 'utf8') + 2
    if (entries.length > 0 && (chars + entryChars > maxChars || bytes + entryBytes > maxBytes)) break
    entries.push(entries.length === 0 ? fitText(entry, maxChars - reserve - 2, maxBytes - bytes - 2) : entry)
    chars += entryChars
    bytes += entryBytes
  }
  return { text: [header(entries.length), ...entries].join('\n\n'), count: entries.length }
}
