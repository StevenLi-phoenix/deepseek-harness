/**
 * The WeChat notice for a turn's protected memory changes: one short message in plain language that
 * says what happened and where it came from. It carries no id and asks for no reply: the owner
 * reviews and undoes changes with the `memory-admin` CLI (RUNBOOK 15), or tells the agent in words.
 */

import { originZh } from '@deepseek-ai/dsh-lsy-taint'
import type { MemoryCategory } from './entries.ts'

export { originZh }

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

const CATEGORY_ZH: Readonly<Record<MemoryCategory, string>> = {
  instructions: '指令',
  preferences: '偏好',
  identity: '身份信息',
  career: '职业信息',
  projects: '项目',
}

/** Where a write came from, as a clause: the owner's own chat reads as WeChat. */
function sourceClause(origin: string): string {
  return `来源：${origin === 'owner' ? '微信对话' : originZh(origin)}`
}

function sentence(item: NoticeItem): string {
  const category = CATEGORY_ZH[item.category]
  const lead = {
    saved: `记住了一条${category}`,
    replaced: `改写了一条${category}`,
    held: `扣下了一条${category}，还没写入`,
    forgot: `忘掉了一条${category}`,
  } as const
  return `${lead[item.kind]}：${opening(item.text)}（${sourceClause(item.origin)}）`
}

/**
 * Build the notice.
 * @param items - the changes of one turn, in order.
 * @returns the title (the whole message for one change) and, for several, one sentence per change.
 */
export function memoryNotice(items: readonly NoticeItem[]): { title: string; body?: string } {
  const [only] = items
  if (items.length === 1 && only !== undefined) return { title: sentence(only) }
  const held = items.filter(item => item.kind === 'held').length
  const title = `这一轮改动了 ${String(items.length)} 条记忆${held > 0 ? `，其中 ${String(held)} 条先扣下了` : ''}`
  const lines = items.slice(0, LISTED).map(sentence)
  if (items.length > LISTED) lines.push(`…另有 ${String(items.length - LISTED)} 条`)
  return { title, body: lines.join('\n') }
}
