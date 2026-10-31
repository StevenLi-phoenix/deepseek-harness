/**
 * The WeChat notice for a turn's protected memory changes: one short message, the entries' opening
 * words, and the reply words that undo, keep, or drop them.
 */

import type { MemoryCategory } from './entries.ts'

/** One change the owner is told about. */
export interface NoticeItem {
  /** `held` waits for the owner's answer; the others are done and can be undone. */
  readonly kind: 'saved' | 'replaced' | 'held' | 'forgot'
  readonly id: string
  readonly category: MemoryCategory
  readonly text: string
  /** The turn's origin label from `describeOrigin`, e.g. `owner` or `peer:bili+web_fetch`. */
  readonly origin: string
}

/** Entries listed in one notice; the rest are counted. */
const LISTED = 6
/** Characters of an entry shown. */
const OPENING_CHARS = 80

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function opening(text: string): string {
  const parts = Array.from(graphemes.segment(text), part => part.segment)
  return parts.length <= OPENING_CHARS ? text : `${parts.slice(0, OPENING_CHARS).join('')}…`
}

const FROM: Readonly<Record<string, string>> = {
  owner: '你的消息',
  'peer:bili': 'B站猫猫的传话',
  'peer:cc': 'Claude Code 的消息',
  'peer:peer': '另一个 Session 的传话',
  event: '事件触发的回合',
  scheduled: '提醒触发的回合',
  monitor: '监控触发的回合',
  job: '后台任务触发的回合',
  guest: '非 owner 的发言',
  subagent: '子 agent',
  unknown: '来源不明的回合',
}

/**
 * Where a write came from, in the owner's words.
 * @param origin - the `describeOrigin` label.
 */
export function originZh(origin: string): string {
  const [first = 'unknown', ...tools] = origin.split('+')
  const base = FROM[first] ?? (first.startsWith('peer:') ? `${first.slice(5)} 的传话` : first)
  const extra = tools.filter(name => name !== 'owner' && !(name in FROM))
  return extra.length === 0 ? base : `${base}，且读过 ${extra.join('、')} 的内容`
}

/**
 * Build the notice.
 * @param items - the changes of one turn, in order.
 * @returns the title and body of one WeChat message.
 */
export function memoryNotice(items: readonly NoticeItem[]): { title: string; body: string } {
  const held = items.filter(item => item.kind === 'held').length
  const done = items.length - held
  const title = held > 0
    ? `🧠 记忆：${String(held)} 条待你确认${done > 0 ? `，${String(done)} 条已写入` : ''}`
    : `🧠 记忆：${String(items.length)} 条变动`
  const verb = { saved: '已记下', replaced: '已改写', held: '待确认', forgot: '已忘记' } as const
  const lines = items.slice(0, LISTED).map((item) => {
    const base = `${verb[item.kind]} [${item.id}] ${item.category}：${opening(item.text)}`
    return item.kind === 'held' ? `${base}（来自${originZh(item.origin)}）` : item.origin === 'owner' ? base : `${base}（来自${originZh(item.origin)}）`
  })
  if (items.length > LISTED) lines.push(`…另有 ${String(items.length - LISTED)} 条`)
  const heldIds = items.filter(item => item.kind === 'held').slice(0, 3).map(item => item.id)
  const doneIds = items.filter(item => item.kind !== 'held').slice(0, 3).map(item => item.id)
  const hints: string[] = []
  if (heldIds.length > 0) hints.push(`保留回复「记下 ${heldIds.join(' ')}」，丢弃回复「忽略 ${heldIds.join(' ')}」`)
  if (doneIds.length > 0) hints.push(`撤销回复「撤销 ${doneIds.join(' ')}」`)
  return { title, body: [...lines, ...hints].join('\n') }
}
