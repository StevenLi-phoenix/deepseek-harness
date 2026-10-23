/** Pure text handling: inbound extraction, outbound size limits, shared-note framing, and outbox digests. */
import type { LsyNote } from '@deepseek-ai/dsh-lsy-event-bus'
import { ItemType, type WeixinItem, type WeixinMessage } from './api.ts'
import type { ActivityRecord, SentKind } from './storage.ts'

/** Third-party-documented ceiling of one WeChat text message in UTF-8 bytes. */
export const WECHAT_MAX_TEXT_BYTES = 16_384
/** Appended to the message that uses the last reply slot of a window. */
export const QUOTA_FOOTER = '\n\n（消息额度已用完，回复任意消息继续接收）'
/** Reply to `/new`. */
export const NEW_CHAT_REPLY = '已开始新对话。'
/** Answer to `/help`. */
export const HELP_REPLY = [
  '可用命令：',
  '/stop  立刻停下所有正在运行的任务（这里的对话和后台任务），并清掉排队的消息',
  '/new   开始新对话（旧对话还在网页里）',
  '/help  显示这份说明',
  '',
  '其他内容都直接交给 agent：文字、语音、图片、文件和视频都行。',
].join('\n')
/** Sent when the channel stops while a chat turn runs, so the owner's question does not vanish silently. */
export const RESTART_CUT_REPLY = '⚠️ dsh 正在重启，这一轮被打断了，没有完成。重启后（约半分钟）需要的话再发一次。'
/** Answer to `/stop` when nothing runs. */
export const STOP_IDLE_REPLY = '现在没有正在运行的任务。'

/**
 * Answer to `/stop` after cancelling running tasks.
 * @param labels - one name per cancelled task, in the order they were stopped.
 */
export function stopReply(labels: readonly string[]): string {
  return `⏹ 已停下 ${labels.length} 个正在运行的任务：\n${labels.map(label => `• ${label}`).join('\n')}\n\n监控和定时提醒不受影响；要停它们，直接告诉我。`
}
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

/** Length of a fence marker (```` ``` ```` or `~~~`, three or more) opening a line; 0 when there is none. */
function fenceRun(line: string): number {
  return /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]?.length ?? 0
}

/** A GFM table row: pipes at both ends. */
function isTableRow(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.length >= 2 && trimmed.startsWith('|') && trimmed.endsWith('|')
}

/** A GFM table separator row, such as `| --- | :-: |`. */
function isTableSeparator(line: string): boolean {
  if (!isTableRow(line)) return false
  const inner = line.trim().slice(1, -1)
  return inner !== '' && inner.split('|').every(cell => /^:?-+:?$/.test(cell.trim()))
}

/**
 * Split text into messages of at most `maxChars` code points, preferring line
 * breaks, and label the parts `[i/n]`. WeChat renders Markdown, so a part that
 * ends inside a code fence closes it and the next reopens it with the same
 * opening line, and a part that starts inside a table repeats its header and
 * separator rows. A line longer than a part is cut; beyond `maxParts` the last
 * part is cut. The fence and table handling follows pan17/dsh-wechat (MIT).
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
  const width = (line: string): number => Array.from(line).length
  const lines = text.split('\n')
  const parts: string[] = []
  let current: string[] = []
  let used = 0
  /** Lines carried into the current part (a reopened fence or a table header); a part of only these is empty. */
  let carried = 0
  let fence: { open: string; close: string; run: number; marker: string } | undefined
  let table: { header: string; separator: string } | undefined

  const add = (line: string): void => {
    if (current.length === 0 && line.trim() === '') return
    used += width(line) + (current.length > 0 ? 1 : 0)
    current.push(line)
  }
  /** Whether `line` closes the open fence. */
  const closes = (line: string): boolean =>
    fence !== undefined && fenceRun(line) >= fence.run && line.trim() === fence.marker.repeat(fenceRun(line))
  /** Code points the current part keeps free to close an open fence; the closing line itself uses them. */
  const reserve = (line: string): number => (fence === undefined || closes(line) ? 0 : width(fence.close) + 1)
  const room = (line: string): number => budget - used - reserve(line)
  /** End the current part; returns false when the parts are used up. */
  const flush = (): boolean => {
    if (parts.length === maxParts - 1) return false
    // A fence opened by this part's last line has no body here yet: the opener moves on instead of rendering empty.
    const bare = fence !== undefined && current.length > carried && current.at(-1) === fence.open
    const body = bare ? current.slice(0, -1) : current
    if (body.length > carried) parts.push([...body, ...fence === undefined || bare ? [] : [fence.close]].join('\n').trimEnd())
    current = []
    used = 0
    carried = 0
    if (fence !== undefined) add(fence.open)
    else if (table !== undefined) {
      add(table.header)
      add(table.separator)
    }
    carried = current.length
    return true
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const next = lines[index + 1] ?? ''
    const header = fence === undefined && table === undefined && isTableRow(line) && isTableSeparator(next)
    const unit = header ? [line, next] : [line]
    const need = unit.reduce((sum, item) => sum + width(item) + 1, 0) - (current.length === 0 ? 1 : 0)
    if (need > room(line) && current.length > carried && !flush()) {
      parts.push(fitText([...current, ...lines.slice(index)].join('\n'), budget, budget * 4))
      return parts.map((part, at) => `[${at + 1}/${parts.length}]\n${part}`)
    }
    if (width(line) + 1 > room(line) && unit.length === 1) {
      // A line longer than a part: cut it, carrying the open fence or table into each piece.
      let rest = Array.from(line)
      while (rest.length > 0) {
        const take = Math.max(1, room(line) - (current.length > 0 ? 1 : 0))
        add(rest.slice(0, take).join(''))
        rest = rest.slice(take)
        if (rest.length > 0 && !flush()) {
          parts.push(fitText([...current, rest.join(''), ...lines.slice(index + 1)].join('\n'), budget, budget * 4))
          return parts.map((part, at) => `[${at + 1}/${parts.length}]\n${part}`)
        }
      }
    } else {
      for (const item of unit) add(item)
    }
    // Structure after this line: fences open and close, tables start at a header and end at prose.
    if (fence !== undefined) {
      if (closes(line)) fence = undefined
    } else if (fenceRun(line) > 0) {
      const run = fenceRun(line)
      const marker = line.trimStart().charAt(0)
      fence = { open: line, close: marker.repeat(run), run, marker }
      table = undefined
    } else if (header) {
      table = { header: line, separator: next }
      index += 1
    } else if (table !== undefined && !isTableRow(line)) {
      table = undefined
    }
  }
  if (current.length > carried) parts.push(current.join('\n').trimEnd())
  return parts.map((part, at) => `[${at + 1}/${parts.length}]\n${part}`)
}

/**
 * Plain text of a note: title, body, and link separated by blank lines. The note's `origin` frames
 * only the chat Session's copy ({@link sharedNoteText}); the owner never sees it.
 * @param note - bus notification.
 * @returns the text WeChat shows.
 */
export function renderNote(note: LsyNote): string {
  return [note.title, note.body, note.url].filter(part => part !== undefined && part.trim() !== '').join('\n\n')
}

/** Who sent a shared note, by default: a Session the bus or the owner's tools started. */
const OTHER_SESSION = 'another session (an event, reminder, monitor, or operator task)'
/** Who sent a note relayed from a chat Session the owner left with `/new`. */
export const EARLIER_CHAT = 'an earlier chat Session (before /new; a reminder or monitor it set up)'

/** Stands in for a quoted message whose text neither the server nor the channel's records hold. */
const QUOTE_UNAVAILABLE = '（一条较早的消息，内容取不到）'
/** iLink ids carry their creation time in milliseconds above the low 22 bits. */
const ID_TIME_SHIFT = 22n
/** Decoded id times before this are not times. */
const MIN_ID_TIME = Date.UTC(2020, 0, 1)

/**
 * When a quoted message was sent: its create or update time, or the time in its id.
 * Follows xmanrui/dsh-im (MIT), `weixin-api.mjs` `weixinMessageTimestampMs`.
 * @param item - the quoted item.
 * @param now - clock, to reject ids that decode to the future.
 * @returns Unix epoch milliseconds, or undefined when the item carries no usable time.
 */
export function quotedAt(item: WeixinItem, now: number = Date.now()): number | undefined {
  for (const value of [item.create_time_ms, item.update_time_ms]) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > MIN_ID_TIME) return value
  }
  const id = item.msg_id
  let ms: number
  if (typeof id === 'string') ms = /^\d{16,20}$/.test(id) ? Number(BigInt(id) >> ID_TIME_SHIFT) : Number.NaN
  else if (typeof id === 'number' && Number.isFinite(id) && id > 0) ms = Math.floor(id / 2 ** 22)
  else return undefined
  return Number.isSafeInteger(ms) && ms >= MIN_ID_TIME && ms <= now + 86_400_000 ? ms : undefined
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
export function inboundText(message: WeixinMessage, recall?: (sentAt: number) => string | undefined): string {
  const lines: string[] = []
  for (const item of message.item_list ?? []) {
    const quote = item.ref_msg
    if (quote !== null && quote !== undefined) {
      let quoted = (quote.message_item ? itemText(quote.message_item) : '') || (quote.title ?? '')
      // A quoted bot message arrives as times only: look up what was sent then.
      if (quoted.trim() === '' && quote.message_item && recall !== undefined) {
        const at = quotedAt(quote.message_item)
        quoted = (at === undefined ? undefined : recall(at)) ?? QUOTE_UNAVAILABLE
      }
      const flat = quoted.replace(/\s+/g, ' ').trim()
      if (flat !== '') lines.push(`[引用] ${fitText(flat, MAX_QUOTE_CHARS)}`)
    }
    const text = itemText(item)
    if (text !== '') lines.push(text)
  }
  return lines.join('\n').trim()
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

/** How the time-gap notice names the bot's latest message. */
const SENT_PHRASES: Record<SentKind, string> = {
  reply: 'your reply',
  note: 'a note another session (an event, reminder, monitor, or operator task) sent the owner',
  file: 'a file you sent',
  notice: 'a WeChat channel notice',
  digest: 'a digest of messages that had waited for the owner',
}

/**
 * Wall-clock time as the chat Session reads it.
 * @param ms - Unix epoch milliseconds.
 * @param timeZone - IANA zone.
 * @returns e.g. `Thu 2026-10-22 08:49`.
 */
export function formatStamp(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(ms)
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find(item => item.type === type)?.value ?? ''
  return `${part('weekday')} ${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`
}

/**
 * A duration rounded down to whole minutes, at most two units.
 * @param ms - milliseconds; negative counts as zero.
 * @returns e.g. `12 min`, `5 h 39 min`, `2 d 3 h`, or `under a minute`.
 */
export function formatGap(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return 'under a minute'
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`
  if (hours > 0) return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`
  return `${rest} min`
}

/**
 * What the chat Session reads before an owner message that ends a quiet spell, so that it neither
 * takes the message for an answer to whatever came last nor guesses the time. All times come from
 * the channel's own records, never from the model.
 * @param now - when the owner message arrived.
 * @param before - the chat's activity before that message.
 * @param minGapMs - silence, in milliseconds, that counts as a quiet spell; 0 turns the notice off.
 * @param timeZone - IANA zone for the times.
 * @returns the notice, or undefined while the chat is active or has no history.
 */
export function timeGapNotice(now: number, before: ActivityRecord | undefined, minGapMs: number, timeZone: string): string | undefined {
  const ownerAt = before?.ownerAt
  const sentAt = before?.sentAt
  const last = Math.max(ownerAt ?? -Infinity, sentAt ?? -Infinity)
  if (minGapMs <= 0 || !Number.isFinite(last) || now - last < minGapMs) return undefined
  const head = `Time check: the owner sent the message below at ${formatStamp(now, timeZone)} (${timeZone}), after ${formatGap(now - last)} of silence in this WeChat chat.`
  let previous: string
  if (sentAt === undefined || (ownerAt !== undefined && ownerAt > sentAt)) {
    previous = ` The last message before it was the owner's own, at ${formatStamp(last, timeZone)}.`
  } else {
    const owner = ownerAt === undefined ? '.' : `; the owner last wrote at ${formatStamp(ownerAt, timeZone)} (${formatGap(now - ownerAt)} ago).`
    previous = ` The last message before it was ${SENT_PHRASES[before?.sent ?? 'reply']}, at ${formatStamp(sentAt, timeZone)}${owner}`
  }
  return `${head}${previous} Read the new message on its own terms: it starts a new exchange unless it clearly refers back to something earlier.`
}

/**
 * The copy of another Session's note that the chat Session keeps. It enters the chat Session's
 * history only at that Session's next step, often hours later, so it carries the time it was sent.
 * @param text - the rendered note.
 * @param at - when it was sent, in Unix epoch milliseconds.
 * @param timeZone - IANA zone for the time.
 * @param from - who sent it, as the chat Session reads it.
 */
export function sharedNoteText(text: string, at: number, timeZone: string, from: string = OTHER_SESSION): string {
  return `At ${formatStamp(at, timeZone)} (${timeZone}), ${from} sent the owner this message on WeChat.`
    + ` It is context, not the owner speaking: the owner may reply to it in this chat.\n${text}`
}
