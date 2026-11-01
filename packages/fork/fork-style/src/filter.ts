/**
 * The strict line filter. A line from a QQ group or a Bilibili comment becomes a speaking-style sample only when it is
 * short, plain talk: no links, mentions, numbers, media, commands, words aimed at an AI, talk about AI, the owner's
 * identity markers, slurs, or the persona's forbidden stock lines. Everything here is deterministic; no model reads a
 * candidate before the owner's page shows it.
 */

import { ticHits } from '@deepseek-ai/dsh-fork-integrity'

/** Why a candidate exchange was left out; the first side and the first rule that refuse it name the reason. */
export const FILTER_REASONS = [
  'empty', 'media', 'too-long', 'link', 'mention', 'number', 'command', 'instruction', 'ai-topic', 'identity', 'slur',
  'no-words', 'tic', 'echo', 'same-speaker', 'own-account', 'owner-unverified', 'parent-missing', 'old', 'duplicate',
  'removed',
] as const
export type FilterReason = typeof FILTER_REASONS[number]

/** Words that mark the owner or the agent; a line naming one is left out. Lowercase compare. */
export const BUILTIN_IDENTITY_MARKERS: readonly string[] = ['猫灯', 'maodeng', '猫猫', 'maomao', '魔女', 'owner', 'stevenli', 'steven li', 'phoenix']

/** A small blocklist of slurs, abuse, and sexual terms; a line containing one is left out. Lowercase compare. */
export const BUILTIN_SLURS: readonly string[] = [
  '傻逼', '傻b', '煞笔', '沙比', '傻屌', '操你', '草你', '肏', '草泥马', '你妈', '尼玛', '死妈', '妈的', 'nmsl', 'cnm', 'tmd',
  '脑残', '智障', '弱智', '废物', '贱人', '婊', '屌', '鸡巴', '狗日', '黑鬼', '支那', '畜生', '滚蛋', '去死', 'fuck', 'shit', 'bitch',
  '福利姬', '约炮', '色图', '涩图', '黄图', '裸照', '做爱', '撸管', '自慰', '奶子', '娇喘', '涩涩', '色色', '性器官', 'porn',
]

/** Rules that vary per deployment. */
export interface LineRules {
  /** Longest side kept, in characters (code points) after trimming. */
  readonly maxChars: number
  /** Identity markers on top of {@link BUILTIN_IDENTITY_MARKERS}. */
  readonly identityMarkers: readonly string[]
  /** Blocked words on top of {@link BUILTIN_SLURS}. */
  readonly blocklist: readonly string[]
}

const LINK = new RegExp(String.raw`(?:https?://|www\.|\b[\w-]+\.(?:com|cn|net|org|io|me|top|xyz|cc|tv|app|dev|ly|gg)\b|\bBV\w{10}\b|\bav\d{3,}\b|b23\.tv)`, 'iu')
const MENTION = /[@＠]/u
const LONG_NUMBER = /\d{5,}/u
const COMMAND = /^[/!！#＃][^\s]/u
const INSTRUCTION = new RegExp([
  '(?:忽略|无视)(?:之前|以上|前面|上面|所有|你的)', '你现在是', '你是一[个只名位]', '假装你', '扮演', '从现在开始你', '你的(?:设定|人设|规则)',
  'system', 'prompt', 'assistant', 'developer', 'jailbreak', '越狱', '提示词', '系统提示', '指令', 'ignore (?:all|previous|the)', 'pretend', 'roleplay',
].join('|'), 'iu')
const AI_TOPIC = new RegExp([
  '(?<![a-z])(?:ai|bots?|gpt|llm|agents?)(?![a-z])', '人工智能', '机器人', '智能体', '模型', 'chatgpt', 'claude', 'deepseek', 'gemini', 'kimi', '豆包',
  '通义', '文心', '智谱', 'qwen', '千问', '元宝', 'copilot', 'openai', 'anthropic', '深度求索',
].join('|'), 'iu')
const LETTER = /\p{L}/u
const SPACE = /\s+/gu

/**
 * One line, collapsed onto one line and trimmed.
 * @param text - the line as stored.
 * @returns the text that is screened and kept.
 */
export function normalizeLine(text: string): string {
  return text.replace(SPACE, ' ').trim()
}

/**
 * Screen one side of an exchange.
 * @param raw - the side's text, already free of channel markers (reply prefixes, stickers).
 * @param rules - deployment rules.
 * @returns the kept text, or the reason it was left out.
 */
export function screenLine(raw: string, rules: LineRules): { text: string } | { reason: FilterReason } {
  const text = normalizeLine(raw)
  if (text === '') return { reason: 'empty' }
  if (Array.from(text).length > rules.maxChars) return { reason: 'too-long' }
  // Full-width digits and letters fold for the checks only; the kept text keeps its own punctuation.
  const folded = text.normalize('NFKC')
  const lower = folded.toLowerCase()
  if (LINK.test(folded)) return { reason: 'link' }
  if (MENTION.test(text)) return { reason: 'mention' }
  if (LONG_NUMBER.test(folded)) return { reason: 'number' }
  if (COMMAND.test(text)) return { reason: 'command' }
  if (INSTRUCTION.test(folded)) return { reason: 'instruction' }
  if (AI_TOPIC.test(folded)) return { reason: 'ai-topic' }
  if ([...BUILTIN_IDENTITY_MARKERS, ...rules.identityMarkers].some(marker => marker !== '' && lower.includes(marker.toLowerCase()))) return { reason: 'identity' }
  if ([...BUILTIN_SLURS, ...rules.blocklist].some(word => word !== '' && lower.includes(word.toLowerCase()))) return { reason: 'slur' }
  if (!LETTER.test(text)) return { reason: 'no-words' }
  if (ticHits(text).length > 0) return { reason: 'tic' }
  return { text }
}

/**
 * Screen an exchange: both sides must pass, and a reply that repeats its prompt is an echo, not a reply.
 * @param exchange - the prompt (absent for a lone line the owner wrote) and the reply.
 * @param rules - deployment rules.
 * @returns the kept texts, or the first reason.
 */
export function screenExchange(
  exchange: { readonly prompt?: string | undefined; readonly reply: string }, rules: LineRules,
): { prompt?: string; reply: string } | { reason: FilterReason } {
  let prompt: string | undefined
  if (exchange.prompt !== undefined) {
    const side = screenLine(exchange.prompt, rules)
    if ('reason' in side) return side
    prompt = side.text
  }
  const reply = screenLine(exchange.reply, rules)
  if ('reason' in reply) return reply
  if (prompt !== undefined && prompt === reply.text) return { reason: 'echo' }
  return { ...prompt === undefined ? {} : { prompt }, reply: reply.text }
}

/** QQ segment kinds a sample may carry: words, the reply quote and its mention, and stickers (dropped from the text). */
const QQ_TEXT_KINDS = new Set(['text', 'at', 'reply', 'face', 'mface'])
const QQ_STICKERS = /\[(?:表情|动画表情)\]|\[表情包(?::[^\]]*)?\]/gu

/**
 * A QQ message's words without stickers, or `media` when it carries anything but words.
 * @param text - the stored one-line text (`[表情]`, `@name ` and similar markers included).
 * @param kinds - the stored comma-separated segment kinds.
 * @param quotedNames - the card and nickname of the member the message replies to: QQ puts `@name ` in front of a reply.
 * @returns the text to screen, or the reason.
 */
export function cleanQqText(text: string, kinds: string, quotedNames: readonly string[] = []): { text: string } | { reason: 'media' } {
  const segmentKinds = kinds === '' ? [] : kinds.split(',')
  if (segmentKinds.some(kind => !QQ_TEXT_KINDS.has(kind))) return { reason: 'media' }
  let words = text
  for (const name of quotedNames) {
    if (name !== '' && words.startsWith(`@${name} `)) {
      words = words.slice(name.length + 2)
      break
    }
  }
  return { text: words.replace(QQ_STICKERS, '') }
}

const BILI_REPLY_PREFIX = /^回复\s*@[^:：]{1,40}\s*[:：]\s*/u
const BILI_EMOTE = /\[[^[\]\s]{1,10}\]/gu

/**
 * A Bilibili comment's words: the `回复 @name :` prefix of a nested reply and the `[doge]`-style emotes go.
 * @param text - the comment text.
 * @returns the text to screen.
 */
export function cleanBiliText(text: string): string {
  return text.replace(BILI_REPLY_PREFIX, '').replace(BILI_EMOTE, '')
}
