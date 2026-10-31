/**
 * Turn origin: who started the open turn of a Session, and whether strangers' words reached it.
 *
 * The answer is read from the Session's own log, which the model cannot write: user messages carry
 * a durable `source`, and a prompt another Session passes the main agent carries a request id the
 * channel minted with {@link untrustedRequestId}. Nothing here reads message text, so a stranger
 * cannot forge an owner turn by writing the right words, and cannot clear a stain either.
 */

import { randomUUID } from 'node:crypto'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** Prefix of the request id of a prompt that is not the owner speaking. */
export const UNTRUSTED_REQUEST_PREFIX = 'lsy-untrusted:'

/** Tools whose results carry words strangers wrote (web pages, QQ groups). */
export const CONTAMINATING_TOOLS: ReadonlySet<string> = new Set([
  'web_fetch', 'web_search', 'qq_groups', 'qq_digest', 'qq_recent', 'qq_search',
])

/** Who and what shaped one turn. */
export interface TurnOrigin {
  /**
   * Labels of the inputs that started or joined the turn, in order: `owner`, `peer:<origin>`, `event`,
   * `scheduled`, `monitor`, `job`, `guest`, `subagent`.
   */
  readonly triggers: readonly string[]
  /** Every input was the owner's own prompt. */
  readonly owner: boolean
  /** Names of the tools called in the turn whose results carry strangers' words. */
  readonly contaminated: readonly string[]
  /** An owner turn in which no such tool ran: its words are the owner's alone. */
  readonly clean: boolean
}

/** Options of {@link turnOrigin}. */
export interface TurnOriginOptions {
  /** Tools that contaminate a turn; defaults to {@link CONTAMINATING_TOOLS}. */
  readonly contaminating?: ReadonlySet<string>
  /** Finds a live Session by id, so a subagent can inherit its parent's origin. */
  readonly parent?: (id: string) => Session | undefined
}

/** A request id for a prompt whose words are not the owner's, naming where they came from. */
export function untrustedRequestId(origin: string): string {
  const slug = origin.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '-').replaceAll(/^-+|-+$/gu, '').slice(0, 24)
  return `${UNTRUSTED_REQUEST_PREFIX}${slug === '' ? 'peer' : slug}:${randomUUID()}`
}

/** The trigger label of a user message's source, or undefined for context the host injected. */
function triggerOf(source: unknown): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const record = source as { kind?: unknown; rpcId?: unknown; principal?: unknown }
  switch (record.kind) {
    case 'user': {
      if (typeof record.rpcId === 'string' && record.rpcId.startsWith(UNTRUSTED_REQUEST_PREFIX)) {
        const origin = record.rpcId.slice(UNTRUSTED_REQUEST_PREFIX.length).split(':')[0] ?? ''
        return `peer:${origin === '' ? 'peer' : origin}`
      }
      return record.principal === undefined ? 'owner' : 'guest'
    }
    case 'schedule': return 'scheduled'
    case 'webhook': return 'event'
    case 'lsy-tool-monitor': return 'monitor'
    case 'tool-jobs': return 'job'
    default: return undefined
  }
}

/** Events of the open turn, newest first; empty when no turn is open. */
function* openTurnEvents(session: Session): Generator<SessionEvent> {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    // oxlint-disable-next-line typescript/no-deprecated -- Same Session history read as lsy-memory's visibility check.
    const event = session.eventAt(seq as never)
    if (event === undefined) continue
    if (event.type === 'turn/end') return
    yield event
    if (event.type === 'turn/start') return
  }
}

/**
 * Read the origin of the Session's open turn.
 * @param session - the Session whose tool is running.
 * @param options - contaminating tools and a parent lookup for subagents.
 * @returns the origin; with no open turn or no recognised input, `triggers` is empty and the turn counts as not the owner's.
 */
export function turnOrigin(session: Session, options: TurnOriginOptions = {}): TurnOrigin {
  const contaminating = options.contaminating ?? CONTAMINATING_TOOLS
  const subagent = session.header.origin === 'subagent'
  const triggers: string[] = []
  const contaminated: string[] = []
  let opened = false
  for (const event of [...openTurnEvents(session)].toReversed()) {
    if (event.type === 'turn/start') {
      opened = true
    } else if (event.type === 'user/message') {
      const label = subagent ? undefined : triggerOf(event.data.source)
      if (label !== undefined) triggers.push(label)
    } else if (event.type === 'tool/call' && contaminating.has(event.data.name) && !contaminated.includes(event.data.name)) {
      contaminated.push(event.data.name)
    }
  }
  let inherited: TurnOrigin | undefined
  if (subagent) {
    const parentId = session.header.parentSession
    const parent = parentId === undefined ? undefined : options.parent?.(parentId)
    inherited = parent === undefined ? undefined : turnOrigin(parent, options)
    triggers.push('subagent', ...inherited?.triggers ?? [])
    for (const name of inherited?.contaminated ?? []) if (!contaminated.includes(name)) contaminated.push(name)
  }
  const owner = opened && triggers.length > 0 && (subagent ? inherited?.owner === true : triggers.every(label => label === 'owner'))
  return { triggers, owner, contaminated, clean: owner && contaminated.length === 0 }
}

/** One short label for logs and audit lines, e.g. `peer:bili` or `owner+web_fetch`. */
export function describeOrigin(origin: TurnOrigin): string {
  if (origin.triggers.length === 0) return 'unknown'
  return [...new Set(origin.triggers), ...origin.contaminated].join('+')
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
