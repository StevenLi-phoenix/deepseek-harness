/**
 * The Data flow settings section: the event service as a graph, from the places an event comes from, through the Sessions that
 * group them and the questions asked on the way, to the channels an answer leaves by. Each box wears the health dot of its
 * service (the overview's cards, the same store and the same 10 s poll), and choosing a box lights every path through it and
 * describes it below. The topology is fixed in `flow-graph.ts`; nothing here reaches the Host beyond the overview routes, so the
 * page adds no service.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PropsRuntime, PropsLocale, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: registers the fork.console locale namespace this component's `t` reads.
import type {} from './locales.ts'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { OverviewView, ServiceCard } from '../views.ts'
import { GRAPH } from './flow-graph.ts'
import { FlowCanvas } from './FlowCanvas.tsx'
import { FlowDetail } from './FlowDetail.tsx'
import { clock, type Translate } from './format.ts'
import { POLL_INTERVAL_MS, startPolling, type ResourceState } from './resource.ts'
import css from './Console.module.css'

/**
 * The section's injected face: the overview's store, since the boxes read the same cards. Model routing is shared
 * infrastructure, not a step of the flow, so the balance route is left out.
 */
export interface FlowInjected {
  hooks: {
    /** The shared overview store. */
    overview: ObservableSnapshot<ResourceState<OverviewView>>
  }
  /** One refresh; a request in flight is shared. */
  refresh: () => void
  /** Whether a section is registered, so only live links show. */
  canManage: (section: string) => boolean
}

/** Props delivered by the settings shell. */
export type FlowProps = PropsRuntime<'settings.section'> & InjectFace<FlowInjected> & PropsLocale<'fork.console'>

/**
 * Render the Data flow section.
 * @param props - the overview store hook, callbacks, and copy.
 * @returns the section.
 */
export function FlowSection({ useOverview, refresh, canManage, select, t }: FlowProps): ReactNode {
  const state = useOverview(value => value)
  const [chosen, setChosen] = useState<string | null>(null)
  useEffect(() => startPolling(refresh, POLL_INTERVAL_MS), [refresh])
  useEffect(() => {
    console.info(`[fork-console] flow open ${GRAPH.nodes.length} boxes, ${GRAPH.edges.length} arrows, ${GRAPH.layout.ranks} columns`)
  }, [])

  const translate = t as Translate
  const view = state.data
  const cards = useMemo(() => new Map<string, ServiceCard>((view?.cards ?? []).map(card => [card.id, card])), [view])
  const choose = useCallback((id: string) => {
    console.info(`[fork-console] flow toggle ${id}`)
    setChosen(current => current === id ? null : id)
  }, [])
  const clear = useCallback(() => { setChosen(null) }, [])
  const manage = useCallback((section: string) => { select?.(section) }, [select])

  const status = state.checkedAt === null
    ? translate('status.loading')
    : view === null
      ? translate('status.failed')
      : state.stale ? translate('status.stale', { time: clock(view.checkedAt) }) : translate('status.live', { time: clock(view.checkedAt) })
  const tone = state.checkedAt === null ? 'loading' : state.stale ? 'stale' : 'live'

  return (
    <section className={css.section} aria-label={translate('title.flow')} data-stale={state.stale ? '' : undefined}>
      <div className={css.header}>
        <span className={css.status} role="status">
          <span className={css.dot} data-tone={tone} aria-hidden="true" />
          {status}
        </span>
        <span>{translate('flow.hint')}</span>
      </div>
      <div className={css.flowLegend} aria-hidden="true">
        {(['event', 'pull', 'send', 'call'] as const).map(kind => (
          <span key={kind} className={css.flowKey}>
            <svg width="28" height="8" viewBox="0 0 28 8"><line className={css.flowEdge} data-kind={kind} x1="1" y1="4" x2="27" y2="4" /></svg>
            {translate(`flow.legend.${kind}`)}
          </span>
        ))}
      </div>
      <div className={css.flowScroll}>
        <FlowCanvas graph={GRAPH} cards={cards} chosen={chosen} onChoose={choose} onClear={clear} translate={translate} />
      </div>
      <FlowDetail
        graph={GRAPH}
        node={chosen === null ? undefined : GRAPH.node(chosen)}
        cards={cards}
        now={view?.checkedAt ?? 0}
        canManage={canManage}
        onManage={manage}
        translate={translate}
      />
    </section>
  )
}
