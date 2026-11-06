/**
 * The strict line filter. A line from a QQ group or a Bilibili comment becomes a speaking-style sample only when it is
 * short, plain talk: no links, mentions, numbers, personal information, media, commands, words aimed at an AI, talk
 * about AI, the owner's identity markers, slurs, or the persona's forbidden stock lines. Notes a Session writes (memes,
 * traits, the persona card) pass a shorter list: personal information, links, digit runs, abuse, and sexual content about
 * minors. Everything here is deterministic; no model reads a
 * candidate before the owner's page shows it.
 */

import { ticHits } from '@deepseek-ai/dsh-lsy-integrity'

/** Why a candidate exchange was left out; the first side and the first rule that refuse it name the reason. */
export const FILTER_REASONS = [
  'empty', 'media', 'too-long', 'link', 'mention', 'number', 'command', 'instruction', 'ai-topic', 'identity', 'slur',
  'no-words', 'tic', 'echo', 'same-speaker', 'own-account', 'owner-unverified', 'parent-missing', 'old', 'duplicate',
  'removed', 'pii', 'minor',
] as const
/** One of {@link FILTER_REASONS}. */
export type FilterReason = typeof FILTER_REASONS[number]

/** Words that mark the owner or the agent; a line naming one is left out. Lowercase compare. */
export const BUILTIN_IDENTITY_MARKERS: readonly string[] = ['猫灯', 'maodeng', '猫猫', 'maomao', '魔女', 'lishuyu', 'stevenli', 'steven li', 'phoenix']

/** A small blocklist of slurs, abuse, and sexual terms; a line containing one is left out. Lowercase compare. */
export const BUILTIN_SLURS: readonly string[] = [
  '傻逼', '傻b', '煞笔', '沙比', '傻屌', '操你', '草你', '肏', '草泥马', '你妈', '尼玛', '死妈', '妈的', 'nmsl', 'cnm', 'tmd',
  '脑残', '智障', '弱智', '废物', '贱人', '婊', '屌', '鸡巴', '狗日', '黑鬼', '支那', '畜生', '滚蛋', '去死', 'fuck', 'shit', 'bitch',
  '福利姬', '约炮', '色图', '涩图', '黄图', '裸照', '做爱', '撸管', '自慰', '奶子', '娇喘', '涩涩', '色色', '性器官', 'porn',
]

/** Province-level names, major cities, and common cities abroad: a place counts only next to a person (「我在成都」). */
const CITIES = [
  '北京', '上海', '天津', '重庆', '广州', '深圳', '杭州', '南京', '苏州', '成都', '武汉', '西安', '长沙', '郑州', '济南', '青岛', '沈阳', '大连',
  '哈尔滨', '长春', '石家庄', '太原', '合肥', '福州', '厦门', '南昌', '昆明', '贵阳', '南宁', '海口', '兰州', '西宁', '银川', '乌鲁木齐', '拉萨',
  '呼和浩特', '宁波', '无锡', '东莞', '佛山', '珠海', '香港', '澳门', '台北', '广东', '浙江', '江苏', '四川', '湖北', '湖南', '河南', '河北', '山东',
  '山西', '陕西', '安徽', '福建', '江西', '云南', '贵州', '广西', '海南', '甘肃', '青海', '宁夏', '新疆', '西藏', '内蒙', '辽宁', '吉林', '黑龙江',
  '东京', '大阪', '首尔', '新加坡', '纽约', '洛杉矶', '旧金山', '西雅图', '波士顿', '芝加哥', '伦敦', '巴黎', '柏林', '悉尼', '墨尔本', '多伦多', '温哥华',
].join('|')

/** Kinds of personal information never stored, each with its own rule. */
export const PII_KINDS = ['name', 'qq', 'uid', 'phone', 'email', 'address', 'org', 'place', 'nick'] as const
/** One of {@link PII_KINDS}. */
export type PiiKind = typeof PII_KINDS[number]

// Specific patterns first: a phone or UID number is not also reported as a QQ number.
const PII_RULES: ReadonlyArray<readonly [PiiKind, RegExp]> = [
  // An alias the digests use, a name with an honorific, a self-introduction, or a Latin full name.
  ['name', /群友#[0-9a-f]{2,}|[\p{Script=Han}]{1,3}(?:老师|同学|先生|女士|小姐|教授|经理|学长|学姐)|(?:我叫|名叫|叫做|真名)[\p{Script=Han}A-Za-z]{2,}|\b[A-Z][a-z]+ [A-Z][a-z]+\b/u],
  ['phone', /(?<!\d)1[3-9]\d{9}(?!\d)|\d{3,4}-\d{7,8}/u],
  ['uid', /\b(?:uid|mid)\s*[:：=]?\s*\d{3,}/iu],
  ['qq', /(?:qq|扣扣|企鹅)\s*[号:：]?\s*\d{5,}|\b\d{6,11}\b/iu],
  ['email', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/u],
  ['address', /[\p{Script=Han}]{1,8}(?:路|街|巷|弄|小区|公寓|大厦|栋|单元)\d*号?|\d+号楼|门牌/u],
  ['org', /[\p{Script=Han}A-Za-z]{1,10}(?:大学|学院|中学|小学|高中|初中|公司|集团|研究所|研究院|医院|银行|工厂|厂)/u],
  ['place', new RegExp(String.raw`(?:住在|家在|老家在?|坐标)\p{Script=Han}{2,}|(?:人在|我在|你在|他在|她在|来自|定居|搬到|搬去)(?:\p{Script=Han}{1,6}(?:省|市|区|县|镇|村)|${CITIES})`, 'u')],
  ['nick', /[@＠]\S+/u],
]

/**
 * The first kind of personal information a text carries.
 * @param text - one line or one profile item.
 * @returns the kind, or undefined when none is found.
 */
export function piiKind(text: string): PiiKind | undefined {
  const folded = text.normalize('NFKC')
  return PII_RULES.find(([, rule]) => rule.test(folded))?.[0]
}

/** Minors together with sexual words: a line mixing them is left out. */
const MINORS = /萝莉|正太|幼女|幼童|未成年|小学生|初中生|中学生|儿童|恋童|炼铜/u
const SEXUAL = /色|涩|性|裸|黄|本子|r18|工口|ero|福利|娇喘|做爱|调教/iu

/**
 * Screen a note a Session writes (a meme, a trait, or the persona card): no personal information, no member alias,
 * no long digit run, no link, no abuse, nothing sexual about minors, and at most `maxChars` characters.
 * @param text - the text, already normalized.
 * @param maxChars - the longest text accepted.
 * @param blocklist - blocked words on top of the built-in slur list.
 * @returns undefined when it passes, else the reason.
 */
export function screenNote(text: string, maxChars: number, blocklist: readonly string[] = []): FilterReason | undefined {
  if (text === '') return 'empty'
  if (Array.from(text).length > maxChars) return 'too-long'
  const folded = text.normalize('NFKC')
  if (LINK.test(folded)) return 'link'
  if (LONG_NUMBER.test(folded)) return 'number'
  if (piiKind(text) !== undefined) return 'pii'
  const lower = folded.toLowerCase()
  if ([...BUILTIN_SLURS, ...blocklist].some(word => word !== '' && lower.includes(word.toLowerCase()))) return 'slur'
  if (MINORS.test(text) && SEXUAL.test(text)) return 'minor'
  return undefined
}

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
  if (piiKind(text) !== undefined) return { reason: 'pii' }
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
