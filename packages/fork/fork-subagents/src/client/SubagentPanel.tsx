/**
 * The right-Sidebar page: the Session's subagents, running ones first with what each is doing now,
 * then the finished ones with how they ended. A card opens the child's conversation in the Sidebar;
 * its corner button opens it in the main view.
 *
 * Subagents can start their own. Counts cover the whole tree, and a branch with something running
 * opens by itself (down to {@link AUTO_EXPAND_DEPTH} levels) and sits in the running section even
 * when its own top Session has finished, so running work is never hidden under a closed row.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  IconCheckOutlineRegular, IconChevronRightOutlineRegular, IconRefreshOutlineRegular, IconRightUpOutlineRegular, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import type {} from '@deepseek-ai/dsh-subagent/client'
import type {} from '../activity.ts'
import {
  AUTO_EXPAND_DEPTH, MAX_TREE_DEPTH, MAX_TREE_NODES, NO_COUNTS, catalogOf, endReason, finishedLabel, formatDuration, formatTokens,
  indexTree, isLive, metaParts, nowLine, rowsOf, summaryLine,
  type PanelRow, type PanelSources, type T, type TreeIndex,
} from './model.ts'
import css from './SubagentPanel.module.css'

/** Business actions the registration supplies. */
export interface PanelInjected {
  /** Read a Session's catalog and its direct children's projections (explicit, deduplicated by the Session layer). */
  prepare: (parentId: SessionId) => void
  /** Open a child's conversation as a Sidebar tab beside this page. */
  openAside: (address: SubagentAddress) => void
  /** Open a child's conversation in the main view. */
  openMain: (address: SubagentAddress) => void
}

/** Full props of the page body. */
export type SubagentPanelProps =
  PropsRuntime<'sidebar.right.pane.tab'> & InjectFace<PanelInjected> & PropsLocale<'fork.subagents'>

/** Re-render once a second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { clearInterval(timer) }
  }, [active])
  return now
}

/** Shared state and actions every level of the list reads. */
interface ListContext {
  readonly sources: PanelSources
  readonly index: TreeIndex
  readonly now: number
  /** Whether a row's children show: the viewer's choice, else open while something below runs. */
  readonly isExpanded: (row: PanelRow, depth: number) => boolean
  readonly toggle: (row: PanelRow, depth: number) => void
  readonly actions: PanelInjected
  readonly t: T
}

/**
 * Status mark of a row. Only work in progress and problems take colour: the loader while running, red for an
 * error, amber for a stop; a completed child gets a quiet grey check, never a green dot that reads as "online".
 */
function Mark({ row }: { row: PanelRow }) {
  if (row.state === 'done') {
    return <span className={css.mark} data-mark="done"><IconCheckOutlineRegular size={14} /></span>
  }
  const state = row.state === 'running' ? 'ongoing'
    : row.state === 'failed' ? 'error'
      : row.state === 'stopped' ? 'warning'
        : 'idle'
  return <span className={css.mark}><StateDot state={state} /></span>
}

/** One child: a card while running, a compact row once finished. `depth` is 0 at the top level. */
function Row({ row, depth, ctx }: { row: PanelRow; depth: number; ctx: ListContext }) {
  const { t, now, actions } = ctx
  const running = row.state === 'running'
  const meta = running ? metaParts(row, t) : [finishedLabel(row, now, t), ...metaParts(row, t)]
  const line = running ? nowLine(row.activity, now, t) : undefined
  const reason = running ? undefined : endReason(row, t)
  const note = row.activity?.note
  const expanded = row.children > 0 && ctx.isExpanded(row, depth)
  const runningBelow = row.below.running
  const disclosure = expanded ? t('children.hide') : t('children.show', { count: row.children })
  const runningBelowText = runningBelow > 0 ? t('children.running', { count: runningBelow }) : undefined
  const address = row.address
  const stateLabel = t(`state.${row.state}`)
  return (
    <li className={css.item} data-state={row.state}>
      <div className={css.card}>
        <button
          type="button"
          className={css.main}
          disabled={address === undefined}
          aria-label={[row.title, stateLabel, t('open.aside')].join(' · ')}
          onClick={() => { if (address !== undefined) actions.openAside(address) }}
        >
          <Mark row={row} />
          <span className={css.body}>
            <span className={css.titleRow}>
              <span className={css.title}>{row.title}</span>
              <span className={css.figures}>
                {row.durationMs !== undefined && <span>{formatDuration(row.durationMs, t)}</span>}
                {row.tokens !== undefined && <span className={css.tokens}>{formatTokens(row.tokens, t)}</span>}
              </span>
            </span>
            {meta.length > 0 && (
              <span className={css.meta}>
                {running
                  ? meta.join(' · ')
                  : <><span className={css.stateWord}>{meta[0]}</span>{meta.length > 1 && ` · ${meta.slice(1).join(' · ')}`}</>}
              </span>
            )}
            {line !== undefined && (
              <span className={css.now} data-stalled={line.stalled || undefined} data-retrying={line.retrying || undefined}>
                <span className={css.nowLabel}>{line.label}</span>
                {line.detail !== undefined && <span className={css.nowDetail}>{line.detail}</span>}
                {line.elapsed !== '' && (
                  <span className={css.nowElapsed}>
                    {line.stalled && row.activity !== undefined
                      ? t('stall', { duration: formatDuration(now - row.activity.at, t) })
                      : line.elapsed}
                  </span>
                )}
              </span>
            )}
            {reason !== undefined && <span className={css.reason}>{reason}</span>}
            {note !== undefined && (running || reason === undefined) && (
              <span className={css.note} data-kind={note.kind}>
                {note.kind === 'thought' ? t('note.thought', { text: note.text }) : note.text}
              </span>
            )}
          </span>
        </button>
        {address !== undefined && (
          <Tooltip label={t('open.main')} delayMs={500} side="bottom" align="end">
            <button
              type="button"
              className={css.side}
              aria-label={t('open.main.aria', { title: row.title })}
              onClick={() => { actions.openMain(address) }}
            >
              <IconRightUpOutlineRegular size={14} />
            </button>
          </Tooltip>
        )}
      </div>
      {row.children > 0 && (
        <button
          type="button"
          className={css.disclosure}
          aria-expanded={expanded}
          aria-label={runningBelowText === undefined ? disclosure : `${disclosure} · ${runningBelowText}`}
          data-running-below={runningBelowText === undefined ? undefined : ''}
          onClick={() => { ctx.toggle(row, depth) }}
        >
          <IconChevronRightOutlineRegular size={12} className={expanded ? css.chevronOpen : css.chevron} />
          <span>{disclosure}</span>
          {runningBelowText !== undefined && (
            <span className={css.runningBelow}>
              {!expanded && <StateDot state="ongoing" />}
              {runningBelowText}
            </span>
          )}
        </button>
      )}
      {expanded && (
        <div className={css.nested}>
          <Rows parentId={row.id} depth={depth + 1} ctx={ctx} />
        </div>
      )}
    </li>
  )
}

/**
 * A nested level: read its exact values when it opens and when its membership changes (the list
 * already carries structure and running state, so the level draws before the read returns).
 */
function NestedRows({ parentId, depth, ctx }: { parentId: SessionId; depth: number; ctx: ListContext }) {
  const { prepare } = ctx.actions
  const childIds = catalogOf(ctx.sources, parentId).entries.map(entry => entry.id).join(',')
  useEffect(() => { prepare(parentId) }, [prepare, parentId, childIds])
  const rows = rowsOf(ctx.sources, parentId, ctx.now, ctx.index)
  return <ul className={css.list}>{rows.map(row => <Row key={row.id} row={row} depth={depth} ctx={ctx} />)}</ul>
}

/** One level of the tree: the top one split into running and finished, nested ones as a plain list. */
function Rows({ parentId, depth, ctx }: { parentId: SessionId; depth: number; ctx: ListContext }) {
  if (depth > 0) return <NestedRows parentId={parentId} depth={depth} ctx={ctx} />
  const rows = rowsOf(ctx.sources, parentId, ctx.now, ctx.index)
  const live = rows.filter(isLive)
  const finished = rows.filter(row => !isLive(row))
  // The running section counts running Sessions at every depth, matching the header and the summary.
  const running = (ctx.index.below.get(parentId) ?? NO_COUNTS).running
  return (
    <>
      {live.length > 0 && (
        <section className={css.section} aria-label={ctx.t('section.running')}>
          <h3 className={css.sectionTitle}>{ctx.t('section.count', { title: ctx.t('section.running'), count: running })}</h3>
          <ul className={css.list}>{live.map(row => <Row key={row.id} row={row} depth={0} ctx={ctx} />)}</ul>
        </section>
      )}
      {finished.length > 0 && (
        <section className={css.section} aria-label={ctx.t('section.finished')}>
          <h3 className={css.sectionTitle}>{ctx.t('section.count', { title: ctx.t('section.finished'), count: finished.length })}</h3>
          <ul className={css.list}>{finished.map(row => <Row key={row.id} row={row} depth={0} ctx={ctx} />)}</ul>
        </section>
      )}
    </>
  )
}

/**
 * The page body for the Sidebar's own Session.
 * @param props - Session standard props, the page actions, and the translator.
 * @returns the panel.
 */
export function SubagentPanel(props: SubagentPanelProps) {
  const { sessionId, useSessions, useSessionStatus, prepare, openAside, openMain, t } = props
  const projections = useSessions(state => state.projectionsBySession)
  const summaries = useSessions(state => state.byId)
  const statuses = useSessionStatus(value => value)
  // The viewer's open/closed choice per row; rows without one follow whether something below runs.
  const [choices, setChoices] = useState<ReadonlyMap<SessionId, boolean>>(() => new Map())
  const sources = useMemo<PanelSources>(() => ({ projections, summaries, statuses }), [projections, summaries, statuses])
  const index = useMemo(() => indexTree(sources, sessionId), [sources, sessionId])
  const catalog = catalogOf(sources, sessionId)
  const childIds = catalog.entries.map(entry => entry.id).join(',')
  // Read the catalog and its children's projections when the page opens and when membership changes;
  // live control frames keep them current afterwards. Nested levels read themselves when they open.
  useEffect(() => { prepare(sessionId) }, [prepare, sessionId, childIds])
  useEffect(() => {
    if (!index.truncated) return
    console.warn(
      '[fork-subagents] the subagent tree of %s is deeper than %d levels or larger than %d Sessions; counts stop there',
      sessionId, MAX_TREE_DEPTH, MAX_TREE_NODES,
    )
  }, [index.truncated, sessionId])
  const counts = index.below.get(sessionId) ?? NO_COUNTS
  // Tick while anything in the tree runs, so open turns and waits count up at every depth.
  const now = useNow(counts.running > 0)
  const top = rowsOf(sources, sessionId, now, index)
  const isExpanded = (row: PanelRow, depth: number): boolean =>
    choices.get(row.id) ?? (row.below.running > 0 && depth < AUTO_EXPAND_DEPTH)
  const ctx: ListContext = {
    sources,
    index,
    now,
    isExpanded,
    toggle: (row, depth) => {
      const open = !isExpanded(row, depth)
      setChoices(current => new Map(current).set(row.id, open))
    },
    actions: { prepare, openAside, openMain },
    t,
  }
  const summary = summaryLine(counts, t)
  return (
    <div className={css.panel} data-fork-subagents="">
      {summary !== '' && <p className={css.summary}>{summary}</p>}
      {catalog.state === 'error' && (
        <div className={css.error} role="alert">
          <span>{t('load.error')}</span>
          <button type="button" className={css.retry} onClick={() => { prepare(sessionId) }}>
            <IconRefreshOutlineRegular size={14} />
            {t('retry')}
          </button>
        </div>
      )}
      {catalog.state !== 'error' && top.length === 0 && (
        <p className={css.empty} role="status">{catalog.state === 'loading' ? t('loading') : t('empty')}</p>
      )}
      {top.length > 0 && <Rows parentId={sessionId} depth={0} ctx={ctx} />}
    </div>
  )
}
