/**
 * Candidate collection: conversational exchanges, not single lines. In a QQ group an exchange is a message and the
 * reply that quotes it, or the next message by another member within a short gap; under the owner's Bilibili videos
 * it is a comment and a reply to it, read through bili-svc. Pairing, cleaning, screening, and the choice of what to
 * keep are pure functions; {@link StyleCollector} runs them over the live sources and stores the result.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { cleanBiliText, cleanQqText, FILTER_REASONS, screenExchange, type FilterReason, type LineRules } from './filter.ts'
import { sampleId, type Candidate, type StyleStore } from './store.ts'
import type { RunReport, SampleSource } from './view.ts'

/** A stored QQ message, as far as pairing reads it (the fields of fork-qq's `MessageRow`). */
export interface QqMessage {
  readonly messageId: string
  readonly userId: string
  /** Epoch milliseconds. */
  readonly at: number
  readonly text: string
  readonly replyTo: string | null
  readonly kinds: string
  readonly card: string
  readonly nickname: string
}

/** The slice of the QQ observer (`ctx.forkQq`) collection reads. */
export interface QqSource {
  groupOverview(): ReadonlyArray<{ readonly groupId: string; readonly recorded: boolean }>
  recentMessages(groupId: string, options: { hours: number; limit: number }): readonly QqMessage[]
}

/** A Bilibili comment as bili-svc's read API answers it. */
export interface BiliComment {
  readonly rpid: number
  readonly mid: number
  /** Epoch seconds. */
  readonly ctime: number
  readonly root: number
  readonly parent: number
  readonly text: string
  /**
   * Whether bili-svc's Reply Gate posted it (a ledger `posted_id`). Absent when bili-svc does not report it yet; a
   * reply by the owner's account is then not taken, because it may have been written by the agent.
   */
  readonly gate?: boolean
}

/** bili-svc's read API, as far as collection uses it. */
export interface BiliReader {
  /** Accounts bili-svc knows, with their member ids. */
  accounts(signal?: AbortSignal): Promise<ReadonlyArray<{ readonly id: string; readonly mid: number | null }>>
  /** Newest comments under the owner's videos, not written by any of the owner's accounts. */
  comments(limit: number, signal?: AbortSignal): Promise<readonly BiliComment[]>
  /** One thread (its first page): the root comment and the replies under it. */
  thread(rpid: number, signal?: AbortSignal): Promise<{ readonly root: BiliComment | null; readonly replies: readonly BiliComment[] }>
}

/** Two cleaned lines that form an exchange, before the filters. */
export interface Pair {
  readonly source: Exclude<SampleSource, 'owner-manual'>
  /** Round-robin key: one group, or one comment thread. */
  readonly key: string
  /** `reply`: the reply quotes or answers its prompt; `next`: it followed within the gap. */
  readonly how: 'reply' | 'next'
  /** Epoch milliseconds of the reply. */
  readonly at: number
  readonly prompt: string
  readonly reply: string
}

/** A pair, or why there is none. */
export type PairResult = Pair | { readonly reason: FilterReason }

/** How QQ writes the mention in front of a reply: the quoted member's number (NapCat), card, or nickname. */
const mentionNames = (message: QqMessage): string[] => [message.userId, message.card.trim(), message.nickname.trim()].filter(name => name !== '')

/**
 * Exchanges in one QQ group: each reply that quotes a stored message, then each unquoted message that answers
 * another member's within `gapMs` inside a back-and-forth (the two members alternate: the answerer spoke just
 * before, or the first speaker comes back right after). Two neighbouring lines in a busy group are often two
 * conversations; the alternation keeps the ones that are one.
 * @param groupId - the group, used only as the round-robin key.
 * @param messages - the group's messages, oldest first.
 * @param gapMs - longest gap between a message and an unquoted answer to it.
 * @returns pairs and refusals, in message order.
 */
export function qqPairs(groupId: string, messages: readonly QqMessage[], gapMs: number): PairResult[] {
  const byId = new Map(messages.map(message => [message.messageId, message]))
  const out: PairResult[] = []
  const make = (prompt: QqMessage, reply: QqMessage, how: Pair['how']): PairResult => {
    if (prompt.userId === reply.userId) return { reason: 'same-speaker' }
    const promptText = cleanQqText(prompt.text, prompt.kinds)
    if ('reason' in promptText) return promptText
    const replyText = cleanQqText(reply.text, reply.kinds, how === 'reply' ? mentionNames(prompt) : [])
    if ('reason' in replyText) return replyText
    return { source: 'qq-group', key: `qq:${groupId}`, how, at: reply.at, prompt: promptText.text, reply: replyText.text }
  }
  for (const message of messages) {
    if (message.replyTo === null) continue
    const quoted = byId.get(message.replyTo)
    out.push(quoted === undefined ? { reason: 'parent-missing' } : make(quoted, message, 'reply'))
  }
  for (const [index, message] of messages.entries()) {
    const previous = messages[index - 1]
    if (previous === undefined) continue
    if (message.replyTo !== null || message.userId === previous.userId || message.at - previous.at > gapMs) continue
    const before = messages[index - 2]
    const after = messages[index + 1]
    const dialog = (before !== undefined && before.userId === message.userId && previous.at - before.at <= gapMs)
      || (after !== undefined && after.userId === previous.userId && after.at - message.at <= gapMs)
    if (!dialog) continue
    out.push(make(previous, message, 'next'))
  }
  return out
}

/** Who wrote what, by Bilibili member id. */
export interface BiliIdentities {
  /** The owner's own account (猫灯): its hand-written replies are `owner-bili`. */
  readonly ownerMid: number | null
  /** Every account bili-svc holds (the owner's and the agent's): their words are never a stranger's. */
  readonly ownMids: ReadonlySet<number>
}

/**
 * Exchanges in one Bilibili thread: each reply and the comment it answers. A reply by the owner's account is
 * `owner-bili` only when bili-svc says the Reply Gate did not post it; a line by any other account bili-svc holds,
 * or by the Gate, is the agent's own and never a sample.
 * @param thread - the root comment and its replies.
 * @param ids - the owner's and the agent's member ids.
 * @returns pairs and refusals.
 */
export function biliPairs(
  thread: { readonly root: BiliComment | null; readonly replies: readonly BiliComment[] }, ids: BiliIdentities,
): PairResult[] {
  const all = [...thread.root === null ? [] : [thread.root], ...thread.replies]
  const byId = new Map(all.map(comment => [comment.rpid, comment]))
  const key = `bili:${String(thread.root?.rpid ?? thread.replies[0]?.root ?? 0)}`
  // owner: written by the owner's hand. agent: an account the agent speaks through, or the Gate.
  // unknown: the owner's account, hand unknown.
  const author = (comment: BiliComment): 'owner' | 'agent' | 'unknown' | 'viewer' => {
    if (comment.gate === true) return 'agent'
    if (ids.ownerMid !== null && comment.mid === ids.ownerMid) return comment.gate === false ? 'owner' : 'unknown'
    return ids.ownMids.has(comment.mid) ? 'agent' : 'viewer'
  }
  const out: PairResult[] = []
  for (const reply of thread.replies) {
    const prompt = byId.get(reply.parent !== 0 ? reply.parent : reply.root)
    if (prompt === undefined || prompt.rpid === reply.rpid) {
      out.push({ reason: 'parent-missing' })
      continue
    }
    const by = [author(prompt), author(reply)]
    if (by.includes('agent')) {
      out.push({ reason: 'own-account' })
      continue
    }
    if (by.includes('unknown')) {
      out.push({ reason: 'owner-unverified' })
      continue
    }
    if (prompt.mid === reply.mid) {
      out.push({ reason: 'same-speaker' })
      continue
    }
    out.push({
      source: by[1] === 'owner' ? 'owner-bili' : 'bili-viewer', key, how: 'reply', at: reply.ctime * 1000,
      prompt: cleanBiliText(prompt.text), reply: cleanBiliText(reply.text),
    })
  }
  return out
}

/** A pair that passed the filters. */
export interface Accepted extends Pair {
  readonly id: string
}

/**
 * Run the filters over pairs.
 * @param results - pairs and refusals from the pairing step.
 * @param rules - line rules.
 * @param oldestMs - a reply said before this is `old`.
 * @returns accepted pairs (in-run duplicates folded) and the refusals by reason.
 */
export function screenPairs(
  results: readonly PairResult[], rules: LineRules, oldestMs: number,
): { accepted: Accepted[]; filtered: Record<FilterReason, number> } {
  const filtered = Object.fromEntries(FILTER_REASONS.map(reason => [reason, 0])) as Record<FilterReason, number>
  const accepted: Accepted[] = []
  const seen = new Set<string>()
  for (const result of results) {
    if ('reason' in result) {
      filtered[result.reason] += 1
      continue
    }
    if (result.at < oldestMs) {
      filtered.old += 1
      continue
    }
    const screened = screenExchange(result, rules)
    if ('reason' in screened) {
      filtered[screened.reason] += 1
      continue
    }
    const id = sampleId(screened.prompt, screened.reply)
    if (seen.has(id)) {
      filtered.duplicate += 1
      continue
    }
    seen.add(id)
    accepted.push({ ...result, prompt: screened.prompt ?? '', reply: screened.reply, id })
  }
  return { accepted, filtered }
}

/**
 * What one run stores: every owner exchange first, then strangers' quoting replies, then their neighbouring
 * answers; within each tier round-robin over groups and threads, newest first. At most `perKey` from one group or
 * thread and `max` strangers' exchanges in all.
 * @param accepted - pairs that passed the filters.
 * @param limits - `max` strangers' samples per run and `perKey` per group or thread.
 * @returns the candidates, in the order of preference.
 */
export function pickForRun(accepted: readonly Accepted[], limits: { readonly max: number; readonly perKey: number }): Candidate[] {
  const toCandidate = (pair: Accepted): Candidate => ({ source: pair.source, at: pair.at, ...pair.prompt === '' ? {} : { prompt: pair.prompt }, reply: pair.reply })
  const owner = accepted.filter(pair => pair.source === 'owner-bili').toSorted((a, b) => b.at - a.at)
  const taken = new Map<string, number>()
  const strangers: Accepted[] = []
  for (const how of ['reply', 'next'] as const) {
    const queues = new Map<string, Accepted[]>()
    for (const pair of accepted.filter(candidate => candidate.source !== 'owner-bili' && candidate.how === how).toSorted((a, b) => b.at - a.at)) {
      queues.set(pair.key, [...queues.get(pair.key) ?? [], pair])
    }
    const order = [...queues.values()].toSorted((a, b) => (b[0]?.at ?? 0) - (a[0]?.at ?? 0))
    for (let round = 0; strangers.length < limits.max && round < limits.perKey; round += 1) {
      for (const queue of order) {
        const pair = queue[round]
        if (pair === undefined || strangers.length >= limits.max || (taken.get(pair.key) ?? 0) >= limits.perKey) continue
        strangers.push(pair)
        taken.set(pair.key, (taken.get(pair.key) ?? 0) + 1)
      }
    }
  }
  return [...owner, ...strangers].map(toCandidate)
}

/** Settings of a run. */
export interface CollectSettings {
  readonly rules: LineRules
  readonly qq: {
    readonly enabled: boolean
    readonly windowHours: number
    readonly maxMessages: number
    readonly gapMs: number
    readonly settleMs: number
  }
  readonly bili: { readonly enabled: boolean; readonly ownerAccount: string; readonly comments: number; readonly maxThreads: number }
  /** Strangers' samples said longer ago than this are retired (and never collected). */
  readonly maxAgeMs: number
  readonly perRun: number
  readonly perKey: number
  readonly review: 'optional' | 'required'
}

/** What the collector remembers between runs. */
interface CollectState {
  lastRun?: RunReport
  /** Epoch seconds each Bilibili thread root was last read. */
  threads: Record<string, number>
}

/** The logger slice the collector writes to. */
export interface CollectLogger {
  info(format: string, ...args: unknown[]): void
  debug(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
}

/** Runs collection over the live sources, one run at a time. */
export class StyleCollector {
  private running: Promise<RunReport> | undefined
  private state: Promise<CollectState> | undefined

  /**
   * @param deps - the store, the sources (resolved per run, so a source mounted later is used), the state file, settings, logger, clock.
   */
  constructor(private readonly deps: {
    readonly store: StyleStore
    readonly stateFile: string
    readonly settings: CollectSettings
    readonly qq: () => QqSource | undefined
    /** The Bilibili reader, or `no-token` when the bili-svc token is not set. */
    readonly bili: () => Promise<BiliReader | 'no-token'>
    readonly logger: CollectLogger
    readonly now?: () => number
  }) {}

  /** Whether a run is in progress. */
  get busy(): boolean {
    return this.running !== undefined
  }

  /** The last run's report, from memory or the state file. */
  async lastRun(): Promise<RunReport | undefined> {
    return (await this.loadState()).lastRun
  }

  /** The state file, read once; concurrent first callers share the read. */
  private loadState(): Promise<CollectState> {
    this.state ??= (async (): Promise<CollectState> => {
      try {
        const parsed = JSON.parse(await readFile(this.deps.stateFile, 'utf8')) as { threads?: unknown; lastRun?: RunReport }
        const threads = typeof parsed.threads === 'object' && parsed.threads !== null ? parsed.threads as Record<string, number> : {}
        return { threads, ...parsed.lastRun === undefined ? {} : { lastRun: parsed.lastRun } }
      } catch {
        return { threads: {} }
      }
    })()
    return this.state
  }

  private async saveState(state: CollectState): Promise<void> {
    await mkdir(dirname(this.deps.stateFile), { recursive: true, mode: 0o700 })
    const temporary = `${this.deps.stateFile}.${String(process.pid)}.tmp`
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    await rename(temporary, this.deps.stateFile)
  }

  /**
   * Collect now; a run already in progress is shared.
   * @param trigger - what started it.
   * @param signal - stops the Bilibili reads.
   * @returns the run's report.
   */
  run(trigger: RunReport['trigger'], signal?: AbortSignal): Promise<RunReport> {
    this.running ??= this.collect(trigger, signal).finally(() => { this.running = undefined })
    return this.running
  }

  private async collect(trigger: RunReport['trigger'], signal: AbortSignal | undefined): Promise<RunReport> {
    const now = this.deps.now ?? Date.now
    const started = now()
    const { settings, logger, store } = this.deps
    const state = await this.loadState()
    const results: PairResult[] = []

    let qq: RunReport['qq'] = { status: 'off', groups: 0, messages: 0 }
    const source = settings.qq.enabled ? this.deps.qq() : undefined
    if (settings.qq.enabled && source === undefined) qq = { status: 'unavailable', groups: 0, messages: 0 }
    if (source !== undefined) {
      let groups = 0
      let messages = 0
      for (const group of source.groupOverview().filter(candidate => candidate.recorded)) {
        // The newest minutes wait for the next run, so a message its sender recalls in time never becomes a sample.
        const rows = source.recentMessages(group.groupId, { hours: settings.qq.windowHours, limit: settings.qq.maxMessages })
          .filter(row => row.at <= started - settings.qq.settleMs)
        groups += 1
        messages += rows.length
        results.push(...qqPairs(group.groupId, rows, settings.qq.gapMs))
      }
      qq = { status: 'ok', groups, messages }
    }

    let bili: RunReport['bili'] = { status: 'off', comments: 0, threads: 0 }
    if (settings.bili.enabled) {
      try {
        const reader = await this.deps.bili()
        if (reader === 'no-token') {
          bili = { status: 'no-token', comments: 0, threads: 0 }
        } else {
          const accounts = await reader.accounts(signal)
          const ownerMid = accounts.find(account => account.id === settings.bili.ownerAccount)?.mid ?? null
          const ownMids = new Set(accounts.flatMap(account => (account.mid === null ? [] : [account.mid])))
          const comments = await reader.comments(settings.bili.comments, signal)
          // bili-svc reads a thread through a comment it stored, so each thread is asked for by its newest stored comment.
          const newest = new Map<number, { ctime: number; rpid: number }>()
          for (const comment of comments) {
            const root = comment.root === 0 ? comment.rpid : comment.root
            if ((newest.get(root)?.ctime ?? -1) < comment.ctime) newest.set(root, { ctime: comment.ctime, rpid: comment.rpid })
          }
          const due = [...newest]
            .filter(([root, last]) => (state.threads[String(root)] ?? 0) < last.ctime)
            .toSorted((a, b) => b[1].ctime - a[1].ctime)
            .slice(0, settings.bili.maxThreads)
          for (const [root, last] of due) {
            results.push(...biliPairs(await reader.thread(last.rpid, signal), { ownerMid, ownMids }))
            state.threads[String(root)] = Math.floor(now() / 1000)
          }
          const forgetBefore = Math.floor(now() / 1000) - 90 * 86_400
          for (const [root, at] of Object.entries(state.threads)) if (at < forgetBefore) Reflect.deleteProperty(state.threads, root)
          bili = { status: 'ok', comments: comments.length, threads: due.length }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn(`fork-style: Bilibili collection failed: ${message}`)
        bili = { status: 'unavailable', comments: 0, threads: 0, error: message.slice(0, 200) }
      }
    }

    const { accepted, filtered } = screenPairs(results, settings.rules, started - settings.maxAgeMs)
    const candidates = pickForRun(accepted, { max: settings.perRun, perKey: settings.perKey })
    const stored = await store.ingest(candidates, settings.review)
    filtered.duplicate += stored.duplicate
    filtered.removed += stored.removed
    const expired = await store.expire(started - settings.maxAgeMs)
    const bySource: Record<string, number> = {}
    for (const record of stored.added) bySource[record.source] = (bySource[record.source] ?? 0) + 1
    for (const record of stored.added) logger.debug(`fork-style: added ${record.id} (${record.source}, ${record.status}): ${JSON.stringify(record.prompt ?? '')} -> ${JSON.stringify(record.reply ?? '')}`)
    const report: RunReport = {
      at: started, ms: now() - started, trigger, qq, bili,
      seen: results.length, accepted: accepted.length, added: stored.added.length, retired: stored.retired + expired,
      filtered: Object.fromEntries(Object.entries(filtered).filter(([, count]) => count > 0)), bySource,
    }
    logger.info(`fork-style: ${trigger} run: ${String(report.seen)} exchanges seen (qq ${qq.status}, ${String(qq.groups)} groups, ${String(qq.messages)} messages; bili ${bili.status}, ${String(bili.threads)} threads), ${String(report.accepted)} passed, ${String(report.added)} added ${JSON.stringify(bySource)}, ${String(report.retired)} retired; filtered ${JSON.stringify(report.filtered)}`)
    state.lastRun = report
    await this.saveState(state)
    return report
  }
}
