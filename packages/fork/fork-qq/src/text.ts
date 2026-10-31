/** Turning OneBot message segments into the one-line text the store keeps and the agent reads. */
import type { OneBotSegment } from './onebot.ts'

/** Longest rendered text kept for one message, in code points. */
export const MAX_TEXT_CHARS = 4000

/** A media item a message carried. */
export interface MediaRef {
  kind: 'image' | 'voice' | 'video' | 'file'
  /** CDN address; QQ's links expire, which is why images are downloaded. */
  url?: string | undefined
  /** The protocol end's name for the item (a file id, or a name the `get_record` action takes). */
  file?: string | undefined
  name?: string | undefined
  bytes?: number | undefined
}

/** A message read into the shape the store keeps. */
export interface ParsedMessage {
  /** Rendered text: words as sent, with `[图片]`, `[语音]`, `@name` and similar markers. */
  text: string
  /** Message id of the message this one quotes. */
  replyTo?: string | undefined
  media: MediaRef[]
  /** Segment types seen, in order. */
  kinds: string[]
}

/** String value of a segment field, or undefined. */
function field(segment: OneBotSegment, name: string): string | undefined {
  const value = segment.data[name]
  return typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : undefined
}

/** A positive number from a segment field, or undefined. */
function size(segment: OneBotSegment): number | undefined {
  const value = Number(segment.data['file_size'])
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/** The title, description, and link of a JSON card, when it carries them. */
function cardTitle(raw: string | undefined): string {
  if (raw === undefined) return ''
  try {
    type Meta = { title?: unknown; desc?: unknown; qqdocurl?: unknown; jumpUrl?: unknown }
    const card = JSON.parse(raw) as { prompt?: unknown; meta?: Record<string, Meta> }
    const meta = Object.values(card.meta ?? {})[0]
    const parts = [typeof card.prompt === 'string' ? card.prompt : '', typeof meta?.title === 'string' ? meta.title : '', typeof meta?.desc === 'string' ? meta.desc : '']
    const url = typeof meta?.qqdocurl === 'string' ? meta.qqdocurl : typeof meta?.jumpUrl === 'string' ? meta.jumpUrl : ''
    return `${[...new Set(parts.filter(part => part !== ''))].join(' / ')}${url === '' ? '' : ` ${url}`}`.trim()
  } catch {
    return ''
  }
}

/**
 * Read a message's segments (or, for a protocol end set to string format, its CQ code) into text and media.
 * @param message - the event's `message` field.
 */
export function parseMessage(message: OneBotSegment[] | string | undefined): ParsedMessage {
  const segments: OneBotSegment[] = typeof message === 'string'
    ? [{ type: 'text', data: { text: message.replace(/\[CQ:[^\]]*\]/g, '') } }]
    : Array.isArray(message) ? message : []
  let text = ''
  let replyTo: string | undefined
  const media: MediaRef[] = []
  const kinds: string[] = []
  for (const segment of segments) {
    kinds.push(segment.type)
    switch (segment.type) {
      case 'text':
        text += field(segment, 'text') ?? ''
        break
      case 'at': {
        const target = field(segment, 'qq')
        text += target === 'all' ? '@全体成员 ' : `@${field(segment, 'name') ?? target ?? ''} `
        break
      }
      case 'reply':
        replyTo = field(segment, 'id')
        break
      case 'face':
        text += '[表情]'
        break
      case 'mface':
        text += `[表情包${field(segment, 'summary') === undefined ? '' : `:${field(segment, 'summary')}`}]`
        break
      case 'image':
        text += field(segment, 'summary') === '[动画表情]' ? '[动画表情]' : '[图片]'
        media.push({ kind: 'image', url: field(segment, 'url'), file: field(segment, 'file'), name: field(segment, 'file'), bytes: size(segment) })
        break
      case 'record':
        text += '[语音]'
        media.push({ kind: 'voice', url: field(segment, 'url'), file: field(segment, 'file'), name: field(segment, 'file'), bytes: size(segment) })
        break
      case 'video':
        text += '[视频]'
        media.push({ kind: 'video', url: field(segment, 'url'), file: field(segment, 'file'), name: field(segment, 'file') })
        break
      case 'file':
        text += `[文件:${field(segment, 'name') ?? field(segment, 'file') ?? ''}]`
        media.push({ kind: 'file', url: field(segment, 'url'), file: field(segment, 'file_id') ?? field(segment, 'file'), name: field(segment, 'name') ?? field(segment, 'file'), bytes: size(segment) })
        break
      case 'forward':
        text += '[合并转发]'
        break
      case 'json': {
        const title = cardTitle(field(segment, 'data'))
        text += `[卡片${title === '' ? '' : `:${title}`}]`
        break
      }
      case 'xml':
        text += '[卡片]'
        break
      case 'share':
        text += `[分享:${[field(segment, 'title'), field(segment, 'url')].filter(Boolean).join(' ')}]`
        break
      case 'poke':
        text += '[戳一戳]'
        break
      case 'dice':
        text += '[骰子]'
        break
      case 'rps':
        text += '[猜拳]'
        break
      default:
        text += `[${segment.type}]`
    }
  }
  return { text: Array.from(text.trim()).slice(0, MAX_TEXT_CHARS).join(''), replyTo, media, kinds }
}

/** A display name for a sender: the group card, else the nickname, else the number. */
export function displayName(sender: { card?: string | undefined; nickname?: string | undefined }, userId: string): string {
  const card = sender.card?.trim()
  if (card !== undefined && card !== '') return card
  const nickname = sender.nickname?.trim()
  return nickname !== undefined && nickname !== '' ? nickname : userId
}
