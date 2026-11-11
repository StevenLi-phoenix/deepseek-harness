/**
 * Pure derivation of the panel from shared Session state: one row per direct child of a Session,
 * classified, sorted, and given its text, plus per-Session counts over the whole subagent tree (a
 * subagent may start its own). Nothing here renders or reads a store, so the rules are unit-tested
 * without a DOM.
 */
import type { SessionProjectionMap, SessionProjectionSnapshot, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { ForkSubagentActivity } from '../activity.ts'
import type {} from './locales.ts'

/** Translator bound to this package's namespace. */
export type T = TranslateNS<'fork.subagents'>

/** One catalog entry as the parent's projection lists it. */
export type CatalogEntry = SessionProjectionMap['subagentCatalog'][number]

/** How a child stands. Colour is spent only on `running` (motion), `failed` and `stopped`. */
export type RowState = 'running' | 'done' | 'failed' | 'stopped' | 'idle' | 'external'

/** One child Session, ready to draw. */
export interface PanelRow {
  readonly id: SessionId
  /** Address that opens the child's conversation; absent for external tasks. */
  readonly address?: SubagentAddress
  /** Creation description, else Session title, else agent name, else id. */
  readonly title: string
  /** Agent name under the title when the title is a description. */
  readonly name?: string
  readonly state: RowState
  /** Active-turn time: settled turns plus the open one. */
  readonly durationMs?: number
  /** Total provider tokens. */
  readonly tokens?: number
  readonly activity?: ForkSubagentActivity
  readonly createdAt: number
  /** Direct children this child has started, as far as its catalog is known. */
  readonly children: number
  /** Counts over every descendant of this child (itself excluded). */
  readonly below: StateCounts
}

/** Counts per state, for the header toggle, the panel's summary line, and a row's descendants. */
export type StateCounts = Readonly<Record<RowState, number>>

/** A Session's catalog read state, as the panel needs it. */
export type CatalogState = 'idle' | 'loading' | 'ready' | 'error'

/** Shared Session state the derivation reads. */
export interface PanelSources {
  readonly projections: Readonly<Record<SessionId, SessionProjectionSnapshot>>
  readonly summaries: Readonly<Record<SessionId, SessionSummary>>
  readonly statuses: SessionStatusSnapshot
}

/** Model phase longer than this reads as a stall. */
export const MODEL_STALL_MS = 5 * 60_000

/** A single tool call longer than this reads as a stall. */
export const TOOL_STALL_MS = 15 * 60_000

/**
 * The catalog of one Session and its read state.
 * @param sources - shared Session state.
 * @param sessionId - the parent.
 * @returns its direct children in catalog order and whether the list is known.
 */
export function catalogOf(sources: PanelSources, sessionId: SessionId): { entries: readonly CatalogEntry[]; state: CatalogState } {
  const snapshot = sources.projections[sessionId]
  const entries = snapshot?.values.subagentCatalog
  if (snapshot === undefined) return { entries: [], state: 'idle' }
  if (entries !== undefined) return { entries, state: 'ready' }
  if (snapshot.state === 'loading' || snapshot.state === 'error') return { entries: [], state: snapshot.state }
  return { entries: [], state: snapshot.state === 'ready' ? 'ready' : 'idle' }
}

/** Activity value of a child, from its summary or its projection store. */
function activityOf(sources: PanelSources, id: SessionId): ForkSubagentActivity | undefined {
  const value = sources.summaries[id]?.projectionValues?.forkSubagentActivity
    ?? sources.projections[id]?.values.forkSubagentActivity
  return value ?? undefined
}

/** Whether the Session runs a turn now. */
function isRunning(sources: PanelSources, id: SessionId): boolean {
  return (sources.statuses.get(id)?.running ?? sources.summaries[id]?.running) === true
}

/**
 * Classify one child.
 * @param running - whether a turn is open now.
 * @param activity - its activity, when the projection has a value.
 * @param lastTurnCompleted - the upstream timing projection's completion fact.
 * @returns the row state.
 */
export function classify(running: boolean, activity: ForkSubagentActivity | undefined, lastTurnCompleted: boolean | undefined): RowState {
  if (running) return 'running'
  const ended = activity?.ended
  if (ended === 'completed') return 'done'
  if (ended === 'error') return 'failed'
  if (ended !== undefined) return 'stopped'
  return lastTurnCompleted === true ? 'done' : 'idle'
}

/** Sum of the four disjoint token buckets. */
function tokensOf(usage: SessionProjectionMap['tokenUsage'] | undefined): number | undefined {
  return usage === undefined
    ? undefined
    : usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

/** Settled plus open-turn time, frozen at the open turn's last event once the child stops. */
function durationOf(timing: SessionProjectionMap['subagentTiming'] | undefined, running: boolean, now: number): number | undefined {
  if (timing === undefined) return undefined
  if (timing.active === undefined) return timing.settledMs
  const end = running ? now : timing.active.through
  return timing.settledMs + Math.max(0, end - timing.active.since)
}

/** Newest moment a row was known to act, for ordering finished rows. */
function lastSeen(row: PanelRow): number {
  return row.activity?.at ?? row.createdAt
}

/**
 * Whether a row belongs with the work in progress: it runs, or something it started still runs.
 * @param row - the row.
 * @returns true for the "running" section and the top of a level.
 */
export function isLive(row: PanelRow): boolean {
  return row.state === 'running' || row.below.running > 0
}

/** Deepest level the tree walk follows below the Session it starts from. */
export const MAX_TREE_DEPTH = 12

/** Most descendants one walk counts, so a runaway fan-out cannot stall a render. */
export const MAX_TREE_NODES = 1_000

/** Levels that open by themselves to show a running descendant; deeper ones open on click. */
export const AUTO_EXPAND_DEPTH = 4

/** Every state, in summary order. */
const STATES: readonly RowState[] = ['running', 'done', 'failed', 'stopped', 'idle', 'external']

/** All-zero counts, shared by rows without descendants. */
export const NO_COUNTS: StateCounts = { running: 0, done: 0, failed: 0, stopped: 0, idle: 0, external: 0 }

/** State of one catalog entry, the same rule its row uses. */
function stateOf(sources: PanelSources, entry: CatalogEntry): RowState {
  if (entry.mode === 'external') return 'external'
  const lastTurnCompleted = sources.summaries[entry.id]?.projectionValues?.subagentTiming?.lastTurnCompleted
  return classify(isRunning(sources, entry.id), activityOf(sources, entry.id), lastTurnCompleted)
}

/** Counts over a Session's whole subagent tree, for every Session the walk reached. */
export interface TreeIndex {
  /** Counts over every descendant of the Session the walk started from. */
  readonly total: StateCounts
  /** Per Session: counts over all its descendants, itself excluded. Sessions the walk did not reach are absent. */
  readonly below: ReadonlyMap<SessionId, StateCounts>
  /** The walk stopped at {@link MAX_TREE_DEPTH} or {@link MAX_TREE_NODES}, so the counts are a floor. */
  readonly truncated: boolean
}

/**
 * Walk the subagent tree under a Session through each Session's catalog (the list carries every
 * Session's catalog, so no read is needed), counting descendants per state for every node.
 * A Session met twice (a cycle, or listed under two parents) is counted once.
 * @param sources - shared Session state.
 * @param rootId - the Session to start from.
 * @returns per-Session descendant counts.
 */
export function indexTree(sources: PanelSources, rootId: SessionId): TreeIndex {
  const below = new Map<SessionId, StateCounts>()
  const seen = new Set<SessionId>([rootId])
  let truncated = false
  const walk = (parentId: SessionId, depth: number): StateCounts => {
    const counts: Record<RowState, number> = { ...NO_COUNTS }
    for (const entry of catalogOf(sources, parentId).entries) {
      if (seen.has(entry.id)) continue
      if (seen.size > MAX_TREE_NODES) {
        truncated = true
        break
      }
      seen.add(entry.id)
      counts[stateOf(sources, entry)] += 1
      if (entry.mode === 'external') continue
      if (depth >= MAX_TREE_DEPTH) {
        if (catalogOf(sources, entry.id).entries.length > 0) truncated = true
        continue
      }
      const nested = walk(entry.id, depth + 1)
      for (const state of STATES) counts[state] += nested[state]
    }
    below.set(parentId, counts)
    return counts
  }
  const total = walk(rootId, 1)
  return { total, below, truncated }
}

/**
 * Number of Sessions a set of counts covers.
 * @param counts - per-state counts.
 * @returns their sum.
 */
export function totalOf(counts: StateCounts): number {
  return STATES.reduce((sum, state) => sum + counts[state], 0)
}

/**
 * Rows for the direct children of one Session: live ones first (running, or with a running
 * descendant; newest started first), then the finished ones (most recently active first).
 * @param sources - shared Session state.
 * @param parentId - the parent Session.
 * @param now - clock for open turns.
 * @param index - tree counts, when the caller already walked the tree.
 * @returns the rows.
 */
export function rowsOf(sources: PanelSources, parentId: SessionId, now: number, index = indexTree(sources, parentId)): PanelRow[] {
  const rows = catalogOf(sources, parentId).entries.map((entry): PanelRow => {
    const summary = sources.summaries[entry.id]
    const external = entry.mode === 'external'
    const running = !external && isRunning(sources, entry.id)
    const activity = external ? undefined : activityOf(sources, entry.id)
    const state = stateOf(sources, entry)
    const values = summary?.projectionValues
    const name = entry.mode === 'continuable' || entry.mode === 'external' ? entry.name : undefined
    const description = entry.label || summary?.title || undefined
    const title = description ?? name ?? entry.id
    const durationMs = durationOf(values?.subagentTiming, running, now)
    const tokens = tokensOf(values?.tokenUsage)
    return {
      id: entry.id,
      ...external ? {} : { address: { parentSessionId: parentId, childSessionId: entry.id, mode: entry.mode } },
      title,
      ...description !== undefined && name !== undefined && name !== description ? { name } : {},
      state,
      ...durationMs === undefined ? {} : { durationMs },
      ...tokens === undefined ? {} : { tokens },
      ...activity === undefined ? {} : { activity },
      createdAt: entry.createdAt,
      children: external ? 0 : catalogOf(sources, entry.id).entries.length,
      below: index.below.get(entry.id) ?? NO_COUNTS,
    }
  })
  const live = rows.filter(isLive).sort((a, b) => b.createdAt - a.createdAt)
  const finished = rows.filter(row => !isLive(row)).sort((a, b) => lastSeen(b) - lastSeen(a))
  return [...live, ...finished]
}

/**
 * Count rows per state (one level; {@link indexTree} counts the whole tree).
 * @param rows - the rows.
 * @returns a count for every state.
 */
export function countStates(rows: readonly PanelRow[]): StateCounts {
  const counts: Record<RowState, number> = { running: 0, done: 0, failed: 0, stopped: 0, idle: 0, external: 0 }
  for (const row of rows) counts[row.state] += 1
  return counts
}

/**
 * The panel's one-line summary: non-zero counts, running first.
 * @param counts - per-state counts.
 * @param t - translator.
 * @returns e.g. "1 个在跑 · 8 个完成".
 */
export function summaryLine(counts: StateCounts, t: T): string {
  const parts: string[] = []
  if (counts.running > 0) parts.push(t('summary.running', { count: counts.running }))
  if (counts.done > 0) parts.push(t('summary.done', { count: counts.done }))
  if (counts.failed > 0) parts.push(t('summary.failed', { count: counts.failed }))
  if (counts.stopped > 0) parts.push(t('summary.stopped', { count: counts.stopped }))
  if (counts.idle > 0) parts.push(t('summary.idle', { count: counts.idle }))
  if (counts.external > 0) parts.push(t('summary.external', { count: counts.external }))
  return parts.join(' · ')
}

/**
 * A duration in the largest two units.
 * @param ms - milliseconds.
 * @param t - translator.
 * @returns e.g. "13 分 02 秒".
 */
export function formatDuration(ms: number, t: T): string {
  const total = Math.floor(Math.max(0, ms) / 1_000)
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3_600) % 24
  const days = Math.floor(total / 86_400)
  if (days > 0) return t('duration.days', { days, hours })
  if (hours > 0) return t('duration.hours', { hours, minutes: String(minutes).padStart(2, '0') })
  if (minutes > 0) return t('duration.minutes', { minutes, seconds: String(seconds).padStart(2, '0') })
  return t('duration.seconds', { seconds })
}

/**
 * A token total in K or M.
 * @param value - tokens.
 * @param t - translator.
 * @returns e.g. "1.2M tok".
 */
export function formatTokens(value: number, t: T): string {
  const scaled = (next: number): string => next >= 100 ? String(Math.round(next)) : String(Math.round(next * 10) / 10)
  if (value < 1_000) return t('tokens.plain', { value })
  if (value < 1_000_000) return t('tokens.thousand', { value: scaled(value / 1_000) })
  return t('tokens.million', { value: scaled(value / 1_000_000) })
}

/** What a running row says it is doing, and whether that has lasted too long. */
export interface NowLine {
  readonly label: string
  /** The tool call's preview, shown after the label. */
  readonly detail?: string
  /** How long the current wait has lasted. */
  readonly elapsed: string
  readonly stalled: boolean
  /** A retry is in progress. */
  readonly retrying: boolean
}

/**
 * The "doing now" line of a running child.
 * @param activity - its activity; undefined before the first turn starts.
 * @param now - clock.
 * @param t - translator.
 * @returns the line.
 */
export function nowLine(activity: ForkSubagentActivity | undefined, now: number, t: T): NowLine {
  if (activity === undefined || activity.phase === 'idle') {
    return { label: t('phase.waiting'), elapsed: '', stalled: false, retrying: false }
  }
  const lasted = Math.max(0, now - activity.since)
  const elapsed = t('phase.for', { duration: formatDuration(lasted, t) })
  if (activity.phase === 'retry') {
    const retry = activity.retry
    const label = retry?.max === undefined
      ? t('phase.retry', { attempt: retry?.attempt ?? 0 })
      : t('phase.retryOf', { attempt: retry.attempt, max: retry.max })
    return { label, ...retry?.reason ? { detail: retry.reason } : {}, elapsed, stalled: false, retrying: true }
  }
  if (activity.phase === 'tool' && activity.tool !== undefined) {
    const { name, preview, open } = activity.tool
    const label = open > 1 ? t('phase.toolMore', { name, count: open - 1 }) : t('phase.tool', { name })
    return { label, ...preview ? { detail: preview } : {}, elapsed, stalled: lasted > TOOL_STALL_MS, retrying: false }
  }
  return { label: t('phase.model'), elapsed, stalled: lasted > MODEL_STALL_MS, retrying: false }
}

/**
 * The small facts under a row's title: agent name, step, tool calls, the last tool.
 * @param row - the row.
 * @param t - translator.
 * @returns the facts in display order.
 */
export function metaParts(row: PanelRow, t: T): string[] {
  const parts: string[] = []
  if (row.name !== undefined) parts.push(row.name)
  const activity = row.activity
  if (activity !== undefined && activity.step > 0) parts.push(t('meta.step', { step: activity.step }))
  if (activity !== undefined && activity.toolCalls > 0) parts.push(t('meta.tools', { count: activity.toolCalls }))
  if (row.state === 'running' && activity?.phase !== 'tool' && activity?.lastTool !== undefined) {
    parts.push(t(activity.lastTool.error ? 'meta.lastToolFailed' : 'meta.lastTool', { name: activity.lastTool.name }))
  }
  return parts
}

/**
 * A clock time, with the date when it is not today.
 * @param at - epoch ms.
 * @param now - clock for "today".
 * @returns e.g. "11:43" or "11/10 18:54" (local time).
 */
export function formatClock(at: number, now: number): string {
  const date = new Date(at)
  const today = new Date(now)
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
  return sameDay ? hm : `${date.getMonth() + 1}/${date.getDate()} ${hm}`
}

/**
 * The state word of a finished row with the time it ended, so a row reads on its own when the section title is
 * scrolled away.
 * @param row - a row that is not running.
 * @param now - clock.
 * @param t - translator.
 * @returns e.g. "完成 11:43", or the state word alone when the end time is unknown.
 */
export function finishedLabel(row: PanelRow, now: number, t: T): string {
  const state = t(`state.${row.state}`)
  const ended = row.activity?.phase === 'idle' && row.activity.ended !== undefined ? row.activity.since : undefined
  return ended === undefined ? state : t('finished.at', { state, time: formatClock(ended, now) })
}

/**
 * Why a finished row stopped, when it did not complete.
 * @param row - a finished row.
 * @param t - translator.
 * @returns the reason, or undefined for completed and never-run rows.
 */
export function endReason(row: PanelRow, t: T): string | undefined {
  if (row.state === 'failed') return row.activity?.error ?? t('state.failed')
  if (row.state !== 'stopped') return undefined
  const ended = row.activity?.ended
  switch (ended) {
    case 'aborted': return t('ended.aborted')
    case 'interrupted': return t('ended.interrupted')
    case 'blocked': return t('ended.blocked')
    case 'max-tokens': return t('ended.max-tokens')
    case 'forked': return t('ended.forked')
    default: return t('state.stopped')
  }
}
