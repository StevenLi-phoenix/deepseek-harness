/**
 * The right-Sidebar page: the Session's subagents, running ones first with what each is doing now,
 * then the finished ones with how they ended. A card opens the child's conversation in the Sidebar;
 * its corner button opens it in the main view.
 */
import { useEffect, useMemo, useState } from 'react'
import { IconChevronRightOutlineRegular, IconRefreshOutlineRegular, IconRightUpOutlineRegular, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import type {} from '@deepseek-ai/dsh-subagent/client'
import type {} from '../activity.ts'
import {
  catalogOf, countStates, endReason, formatDuration, formatTokens, metaParts, nowLine, rowsOf, summaryLine,
  type PanelRow, type PanelSources, type T,
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
  readonly now: number
  readonly expanded: ReadonlySet<SessionId>
  readonly toggle: (id: SessionId) => void
  readonly actions: PanelInjected
  readonly t: T
}

/** Status mark of a row: the loader while running, a dot otherwise. */
function Mark({ row }: { row: PanelRow }) {
  const state = row.state === 'running' ? 'ongoing'
    : row.state === 'done' ? 'done'
      : row.state === 'failed' ? 'error'
        : row.state === 'stopped' ? 'warning'
          : 'idle'
  return <span className={css.mark}><StateDot state={state} /></span>
}

/** One child: a card while running, a compact row once finished. */
function Row({ row, ctx }: { row: PanelRow; ctx: ListContext }) {
  const { t, now, actions } = ctx
  const running = row.state === 'running'
  const meta = metaParts(row, t)
  const line = running ? nowLine(row.activity, now, t) : undefined
  const reason = running ? undefined : endReason(row, t)
  const note = row.activity?.note
  const expanded = ctx.expanded.has(row.id)
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
            {meta.length > 0 && <span className={css.meta}>{meta.join(' · ')}</span>}
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
          onClick={() => { ctx.toggle(row.id) }}
        >
          <IconChevronRightOutlineRegular size={12} className={expanded ? css.chevronOpen : css.chevron} />
          {expanded ? t('children.hide') : t('children.show', { count: row.children })}
        </button>
      )}
      {expanded && (
        <div className={css.nested}>
          <Rows parentId={row.id} ctx={ctx} />
        </div>
      )}
    </li>
  )
}

/** One level of the tree, split into running and finished. */
function Rows({ parentId, ctx, sectioned = false }: { parentId: SessionId; ctx: ListContext; sectioned?: boolean }) {
  const rows = rowsOf(ctx.sources, parentId, ctx.now)
  const running = rows.filter(row => row.state === 'running')
  const finished = rows.filter(row => row.state !== 'running')
  if (!sectioned) {
    return <ul className={css.list}>{rows.map(row => <Row key={row.id} row={row} ctx={ctx} />)}</ul>
  }
  return (
    <>
      {running.length > 0 && (
        <section className={css.section} aria-label={ctx.t('section.running')}>
          <h3 className={css.sectionTitle}>{ctx.t('section.running')}</h3>
          <ul className={css.list}>{running.map(row => <Row key={row.id} row={row} ctx={ctx} />)}</ul>
        </section>
      )}
      {finished.length > 0 && (
        <section className={css.section} aria-label={ctx.t('section.finished')}>
          <h3 className={css.sectionTitle}>{ctx.t('section.finished')}</h3>
          <ul className={css.list}>{finished.map(row => <Row key={row.id} row={row} ctx={ctx} />)}</ul>
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
  const [expanded, setExpanded] = useState<ReadonlySet<SessionId>>(() => new Set())
  const sources = useMemo<PanelSources>(() => ({ projections, summaries, statuses }), [projections, summaries, statuses])
  const catalog = catalogOf(sources, sessionId)
  const childIds = catalog.entries.map(entry => entry.id).join(',')
  // Read the catalog and its children's projections when the page opens and when membership changes;
  // live control frames keep them current afterwards.
  useEffect(() => { prepare(sessionId) }, [prepare, sessionId, childIds])
  const top = rowsOf(sources, sessionId, Date.now())
  const anyRunning = Object.values(summaries).some(summary => summary.origin === 'subagent' && summary.running)
    || top.some(row => row.state === 'running')
  const now = useNow(anyRunning)
  const ctx: ListContext = {
    sources,
    now,
    expanded,
    toggle: (id) => {
      const opening = !expanded.has(id)
      if (opening) prepare(id)
      setExpanded((current) => {
        const next = new Set(current)
        if (opening) next.add(id)
        else next.delete(id)
        return next
      })
    },
    actions: { prepare, openAside, openMain },
    t,
  }
  const summary = summaryLine(countStates(top), t)
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
      {top.length > 0 && <Rows parentId={sessionId} ctx={ctx} sectioned />}
    </div>
  )
}
