/** Text helpers of the QQ channel: framing inbound messages, splitting replies, and fixed command replies. */

/** Reply to `/new`. */
export const NEW_CHAT_REPLY = '好，换个新话题。'
/** Reply to `/help`. */
export const HELP_REPLY = '可用命令：\n/new 开始新的对话\n/help 显示这段说明'
/** Sent in place of an answer when a message could not reach the agent. */
export const FORWARD_FAILED_PREFIX = '⚠️ 消息没能交给 agent：'
/** What an attachment-only message reads as: attachments are not downloaded. */
export const ATTACHMENT_NOTE = '（这条消息带了附件，当前版本不读取附件）'

/** Last six characters of an openid: enough to tell peers apart in a prompt or log line without printing the whole id. */
export function shortId(id: string): string {
  return id.length <= 6 ? id : id.slice(-6)
}

/**
 * Make inbound text unable to pose as the channel's own frame: a line that opens with `[QQ`
 * gets a full-width bracket, so only the host writes real frames.
 */
export function sanitizeInbound(text: string): string {
  return text.replace(/^(\s*)\[(?=QQ)/gm, '$1［')
}

/** Who sent an inbound message, as the frame names them. */
export interface FrameSender {
  scope: 'c2c' | 'group'
  senderId: string
  groupId?: string | undefined
}

/**
 * The text the chat Session reads for one inbound message: a frame naming where it came from, then the
 * sender's words. Ids are shortened; the words are untrusted but not wrapped, since the Session's preset
 * already treats everything on QQ as data.
 */
export function frameInbound(sender: FrameSender, text: string): string {
  const body = sanitizeInbound(text.trim())
  const head = sender.scope === 'group'
    ? `[QQ 群 ${shortId(sender.groupId ?? '')} · 成员 ${shortId(sender.senderId)}]`
    : `[QQ 私聊 · ${shortId(sender.senderId)}]`
  return `${head} ${body}`
}

/** Positions after which a long text may be cut, best first. */
const BREAKS = ['\n\n', '\n', '。', '！', '？', '. ', '! ', '? ', '；', '; ', '，', ', ', ' ']

/**
 * Split one text into at most `maxParts` messages of at most `maxChars` code points. A cut falls on the
 * latest paragraph, line, sentence, or word break in the second half of the window, otherwise inside a
 * word. What does not fit in the last part is cut and marked with `…`.
 * @returns at least one non-empty part, or none for blank input.
 */
export function splitText(raw: string, maxChars: number, maxParts: number): string[] {
  const text = raw.toWellFormed().trim()
  if (text === '') return []
  const chars = Array.from(text)
  const parts: string[] = []
  let start = 0
  while (start < chars.length) {
    if (parts.length === maxParts - 1) {
      const rest = chars.slice(start)
      parts.push(rest.length <= maxChars ? rest.join('').trim() : `${rest.slice(0, maxChars - 1).join('').trimEnd()}…`)
      break
    }
    if (chars.length - start <= maxChars) {
      parts.push(chars.slice(start).join('').trim())
      break
    }
    const window = chars.slice(start, start + maxChars).join('')
    let cut = -1
    for (const mark of BREAKS) {
      const at = window.lastIndexOf(mark)
      if (at >= 0 && Array.from(window.slice(0, at + mark.length)).length >= maxChars / 2) {
        cut = Array.from(window.slice(0, at + mark.length)).length
        break
      }
    }
    if (cut < 0) cut = maxChars
    parts.push(chars.slice(start, start + cut).join('').trim())
    start += cut
  }
  return parts.filter(part => part !== '')
}
