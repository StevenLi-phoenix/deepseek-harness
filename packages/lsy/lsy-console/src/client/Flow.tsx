/**
 * The message flow page, its own place in the sidebar. It answers, in this order: is anything broken and what does that touch; how
 * much came in and how much of it reached the owner; which ways are in use; and where one event went and what became of it. The
 * topology is fixed in `flow-graph.ts`; health comes from the overview route and the counts from the activity route, both on the
 * same 10 s poll, and all spans arrive together, so switching one needs no request.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PropsRuntime, PropsLocale, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the layout's SlotMap merge (the 'main' entry).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: registers the lsy.console locale namespace this component's `t` reads.
import type {} from './locales.ts'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { FLOW_WINDOWS, type FlowActivityView, type FlowRecentItem, type FlowWindow, type OverviewView, type ServiceCard } from '../views.ts'
import { statusText } from './cards.ts'
import { GRAPH, GRAPH_BUILT, PLANNED_COUNT } from './flow-graph.ts'
import { factOf, stopsOf, titleOf, type BoxFact } from './flow-view.ts'
import { FlowCanvas } from './FlowCanvas.tsx'
import { FlowSide } from './FlowDetail.tsx'
import { clock, type Translate } from './format.ts'
import { POLL_INTERVAL_MS, startPolling, type ResourceState } from './resource.ts'
import css from './Console.module.css'

/** How long a number takes to reach its new value. */
const COUNT_MS = 320

/** The page's injected face. */
export interface FlowInjected {
  hooks: {
    /** The shared overview store. */
    overview: ObservableSnapshot<ResourceState<OverviewView>>
    /** The activity store. */
    activity: ObservableSnapshot<ResourceState<FlowActivityView>>
  }
  /** One refresh of both; a request in flight is shared. */
  refresh: () => void
  /** Whether a Settings section is registered, so only live links show. */
  canManage: (section: string) => boolean
  /** Open Settings on one section. */
  openSettings: (section: string) => void
}

/** Props delivered by the slot. */
export type FlowProps = PropsRuntime<'main'> & InjectFace<FlowInjected> & PropsLocale<'lsy.console'>

const reducedMotion = (): boolean => typeof matchMedia !== 'function' || matchMedia('(prefers-reduced-motion: reduce)').matches

/** A number that runs to its new value instead of jumping. */
function useCounted(target: number): number {
  const [shown, setShown] = useState(target)
  const from = useRef(target)
  useEffect(() => {
    if (from.current === target || reducedMotion()) {
      from.current = target
      setShown(target)
      return
    }
    const start = performance.now()
    const origin = from.current
    let frame = 0
    const step = (at: number): void => {
      const done = Math.min(1, (at - start) / COUNT_MS)
      const eased = 1 - (1 - done) ** 3
      const value = Math.round(origin + (target - origin) * eased)
      from.current = value
      setShown(value)
      if (done < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => { cancelAnimationFrame(frame) }
  }, [target])
  return shown
}

function Figure({ value, label, small }: { value: number; label: string; small?: boolean }): ReactNode {
  const shown = useCounted(value)
  return (
    <span className={css.flowFigure} data-small={small === true ? '' : undefined}>
      <strong>{shown}</strong>
      <span>{label}</span>
    </span>
  )
}

/** The broken service first; one line says all there is at a glance, a click goes to the box. */
function Verdict({ down, loaded, onOpen, onFix, canFix, t }: {
  down: readonly { card: ServiceCard; node: string | undefined; affected: readonly string[]; manage: string | undefined }[]
  loaded: boolean
  onOpen: (id: string) => void
  onFix: (section: string) => void
  canFix: (section: string) => boolean
  t: Translate
}): ReactNode {
  const first = down[0]
  if (first === undefined) {
    return (
      <div className={css.flowVerdict} data-state={loaded ? 'ok' : 'loading'} role="status">
        <span className={css.flowVerdictDot} aria-hidden="true" />
        <b>{t(loaded ? 'flow.verdict.ok' : 'status.loading')}</b>
      </div>
    )
  }
  const { card, node, affected, manage } = first
  return (
    <div className={css.flowVerdict} data-state="bad" role="status">
      <span className={css.flowVerdictDot} aria-hidden="true" />
      <button type="button" className={css.flowVerdictBody} onClick={() => { if (node !== undefined) onOpen(node) }}>
        <b>{t(`card.${card.id}.title`)}：{statusText(card, t)}</b>
        <span>
          {affected.length === 0 ? t('flow.verdict.noneElse') : t('flow.verdict.touches', { list: affected.join(t('flow.sep')) })}
          {down.length > 1 ? ` ${t('flow.verdict.more', { count: down.length - 1 })}` : ''}
        </span>
      </button>
      {manage !== undefined && canFix(manage)
        ? <button type="button" className={css.flowAction} data-primary="" onClick={() => { onFix(manage) }}>{t('flow.fix')}</button>
        : null}
    </div>
  )
}

/**
 * Render the message flow page.
 * @param props - the two stores, callbacks, and copy.
 * @returns the page.
 */
export function FlowPage({ useOverview, useActivity, refresh, canManage, openSettings, t }: FlowProps): ReactNode {
  const overview = useOverview(value => value)
  const activity = useActivity(value => value)
  const translate = t as Translate
  const [span, setSpan] = useState<FlowWindow>('24h')
  const [chosen, setChosen] = useState<string | null>(null)
  const [followed, setFollowed] = useState<FlowRecentItem | null>(null)
  const [showPlanned, setShowPlanned] = useState(false)
  useEffect(() => startPolling(refresh, POLL_INTERVAL_MS), [refresh])
  useEffect(() => {
    console.info(`[lsy-console] flow open ${GRAPH.nodes.length} boxes, ${GRAPH.edges.length} arrows`)
  }, [])

  const graph = showPlanned ? GRAPH : GRAPH_BUILT
  const view = activity.data
  const now = view?.checkedAt ?? overview.data?.checkedAt ?? 0
  const cards = useMemo(() => new Map<string, ServiceCard>((overview.data?.cards ?? []).map(card => [card.id, card])), [overview.data])
  const facts = useMemo(() => {
    const map = new Map<string, BoxFact>()
    for (const node of graph.nodes) map.set(node.id, factOf(node, { cards, activity: view, span, now, t: translate }))
    return map
  }, [graph, cards, view, span, now, translate])
  const down = useMemo(() => [...cards.values()].filter(card => card.tone === 'down').map((card) => {
    const owner = graph.nodes.find(node => node.service === card.id)
    return {
      card,
      node: owner?.id,
      manage: owner?.manage,
      affected: graph.nodes.filter(node => node.needs === card.id).map(node => titleOf(node, translate)),
    }
  }), [cards, graph, translate])

  const choose = useCallback((id: string) => {
    console.info(`[lsy-console] flow toggle ${id}`)
    setFollowed(null)
    setChosen(current => current === id ? null : id)
  }, [])
  const open = useCallback((id: string) => { setFollowed(null); setChosen(id) }, [])
  const clear = useCallback(() => { setChosen(null); setFollowed(null) }, [])
  const follow = useCallback((item: FlowRecentItem) => {
    console.info(`[lsy-console] flow follow ${item.kind} ${item.outcome}`)
    setChosen(null)
    setFollowed(current => current?.id === item.id ? null : item)
  }, [])
  const walk = useMemo(() => followed === null ? [] : graph.route(stopsOf(graph, followed)), [graph, followed])

  const funnel = view?.windows[span].funnel
  const held = view?.presence?.deferred ?? 0
  const failed = funnel?.failed ?? 0
  const stale = overview.stale || activity.stale
  return (
    <div className={css.flowPage} data-stale={stale ? '' : undefined}>
      <header className={css.flowHeader}>
        <div className={css.flowHeading}>
          <h1>{translate('title.flow')}</h1>
          {stale && view !== null ? <span className={css.flowStale}>{translate('status.stale', { time: clock(view.checkedAt) })}</span> : null}
        </div>
        <Verdict down={down} loaded={overview.checkedAt !== null} onOpen={open} onFix={openSettings} canFix={canManage} t={translate} />
        <div className={css.flowFunnel}>
          <Figure value={funnel?.events ?? 0} label={translate('flow.funnel.events')} />
          <span className={css.flowArrow} aria-hidden="true">→</span>
          <Figure value={funnel?.batches ?? 0} label={translate('flow.funnel.batches')} />
          <span className={css.flowArrow} aria-hidden="true">→</span>
          <Figure value={funnel?.sent ?? 0} label={translate('flow.funnel.sent')} />
          <span className={css.flowFunnelGap} />
          <Figure small value={funnel?.silent ?? 0} label={translate('flow.funnel.silent')} />
          {held > 0 ? <Figure small value={held} label={translate('flow.funnel.held')} /> : null}
          {failed > 0 ? <Figure small value={failed} label={translate('flow.funnel.failed')} /> : null}
          <div className={css.flowSpan} role="group" aria-label={translate('flow.span.label')} data-at={FLOW_WINDOWS.indexOf(span)}>
            <span className={css.flowSpanThumb} aria-hidden="true" />
            {FLOW_WINDOWS.map(option => (
              <button key={option} type="button" aria-pressed={span === option} onClick={() => { setSpan(option) }}>
                {translate(`flow.span.${option}`)}
              </button>
            ))}
          </div>
        </div>
      </header>
      <div className={css.flowBody}>
        <div className={css.flowScroll}>
          <div className={css.flowLanes} style={{ width: graph.layout.width }}>
            <span>{translate('flow.lane.from')}</span>
            <span>{translate('flow.lane.by')}</span>
            <span>{translate('flow.lane.to')}</span>
          </div>
          <FlowCanvas
            graph={graph}
            facts={facts}
            chosen={chosen}
            walk={walk}
            walkKey={followed?.id ?? ''}
            now={now}
            onChoose={choose}
            onClear={clear}
            translate={translate}
          />
          <label className={css.flowPlanned}>
            <input type="checkbox" checked={showPlanned} onChange={(event) => { setShowPlanned(event.target.checked) }} />
            {translate('flow.planned', { count: PLANNED_COUNT })}
          </label>
        </div>
        <FlowSide
          graph={graph}
          node={chosen === null ? undefined : graph.node(chosen)}
          fact={chosen === null ? undefined : facts.get(chosen)}
          recent={view?.recent ?? []}
          followed={followed?.id ?? null}
          now={now}
          canManage={canManage}
          onManage={openSettings}
          onFollow={follow}
          onBack={clear}
          translate={translate}
        />
      </div>
    </div>
  )
}
