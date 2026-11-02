/**
 * The Data flow settings section: the event service as a graph, from the places an event comes from, through the entry, the
 * bus and the agents, to the channels an answer leaves by. Each box wears the health dot of its service (the overview's cards,
 * the same store and the same 10 s poll), and choosing a box lights every path through it and describes it below. The topology
 * is fixed in `flow-graph.ts`; nothing here reaches the Host beyond the overview routes, so the page adds no service.
 */

import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { PropsRuntime, PropsLocale, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: registers the lsy.console locale namespace this component's `t` reads.
import type {} from './locales.ts'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { OverviewView, ServiceCard, Tone } from '../views.ts'
import { factLines, statusText } from './cards.ts'
import { EDGES, LAYOUT, NODES, NODE_H, NODE_W, edgePath, neighbours, relatives, spot, type FlowNode } from './flow-graph.ts'
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
export type FlowProps = PropsRuntime<'settings.section'> & InjectFace<FlowInjected> & PropsLocale<'lsy.console'>

/** What a box shows: its service's tone, `off` while nothing is read, `none` for a box nobody probes. */
type BoxTone = Tone | 'none'

const toneOf = (node: FlowNode, cards: ReadonlyMap<string, ServiceCard>): BoxTone => {
  if (node.service === undefined) return 'none'
  return cards.get(node.service)?.tone ?? 'off'
}

/** Only a box with a service of its own has a status line; boxes inside the event service would all repeat "running". */
const ownCard = (node: FlowNode, cards: ReadonlyMap<string, ServiceCard>): ServiceCard | undefined =>
  node.service === undefined || node.service === 'dsh' ? undefined : cards.get(node.service)

/** Longest status line a box shows before the detail line below takes over. */
const SUBTITLE_MAX = 14

const clip = (text: string): string => text.length > SUBTITLE_MAX ? `${text.slice(0, SUBTITLE_MAX - 1)}…` : text

function Box({ node, tone, subtitle, selected, dim, title, onChoose }: {
  node: FlowNode
  tone: BoxTone
  subtitle: string
  selected: boolean
  dim: boolean
  title: string
  onChoose: (id: string) => void
}): ReactNode {
  const at = spot(node.id)
  const onKeyDown = (event: KeyboardEvent<SVGGElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onChoose(node.id)
    }
  }
  return (
    <g
      className={css.flowNode}
      transform={`translate(${at.x} ${at.y})`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={subtitle === '' ? title : `${title}, ${subtitle}`}
      data-node={node.id}
      data-role={node.role}
      data-tone={tone}
      data-dim={dim ? '' : undefined}
      onClick={(event) => { event.stopPropagation(); onChoose(node.id) }}
      onKeyDown={onKeyDown}
    >
      <rect className={css.flowBox} width={NODE_W} height={NODE_H} rx={9} />
      {tone === 'none' ? null : <circle className={css.flowDot} cx={NODE_W - 12} cy={13} r={3.5} data-tone={tone} />}
      <text className={css.flowTitle} x={12} y={subtitle === '' ? 28 : 20}>{clip(title)}</text>
      {subtitle === '' ? null : <text className={css.flowSub} x={12} y={36}>{subtitle}</text>}
    </g>
  )
}

/**
 * Render the Data flow section.
 * @param props - the overview store hook, callbacks, and copy.
 * @returns the section.
 */
export function FlowSection({ useOverview, refresh, canManage, select, t }: FlowProps): ReactNode {
  const state = useOverview(value => value)
  const [chosen, setChosen] = useState<string | null>(null)
  const arrow = useId().replaceAll(':', '')
  useEffect(() => startPolling(refresh, POLL_INTERVAL_MS), [refresh])

  const translate = t as Translate
  const view = state.data
  const cards = new Map<string, ServiceCard>((view?.cards ?? []).map(card => [card.id, card]))
  const now = view?.checkedAt ?? 0
  const lit = chosen === null ? null : relatives(chosen)
  const choose = (id: string): void => {
    if (chosen !== id) console.info(`[lsy-console] flow choose ${id}`)
    setChosen(current => current === id ? null : id)
  }

  const status = state.checkedAt === null
    ? translate('status.loading')
    : view === null
      ? translate('status.failed')
      : state.stale ? translate('status.stale', { time: clock(view.checkedAt) }) : translate('status.live', { time: clock(view.checkedAt) })
  const tone = state.checkedAt === null ? 'loading' : state.stale ? 'stale' : 'live'
  const titleOf = (id: string): string => translate(`flow.node.${id}` as never)
  const list = (ids: readonly string[]): string => ids.map(titleOf).join(translate('flow.sep'))

  const picked = chosen === null ? undefined : NODES.find(node => node.id === chosen)
  const pickedCard = picked === undefined ? undefined : ownCard(picked, cards)
  const around = picked === undefined ? undefined : neighbours(picked.id)
  const manage = picked?.manage

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
        <svg
          className={css.flowSvg}
          width={LAYOUT.width}
          height={LAYOUT.height}
          viewBox={`0 0 ${LAYOUT.width} ${LAYOUT.height}`}
          role="group"
          aria-label={translate('title.flow')}
          onClick={() => { setChosen(null) }}
          onKeyDown={(event) => { if (event.key === 'Escape') setChosen(null) }}
        >
          <defs>
            <marker id={arrow} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path className={css.flowHead} d="M0 0.5 L7 4 L0 7.5 Z" />
            </marker>
          </defs>
          <g>
            {EDGES.map((edge) => {
              const key = `${edge.from}>${edge.to}`
              return (
                <path
                  key={key}
                  className={css.flowEdge}
                  d={edgePath(edge.from, edge.to)}
                  data-edge={key}
                  data-kind={edge.kind}
                  data-dim={lit !== null && !lit.edges.has(key) ? '' : undefined}
                  markerEnd={`url(#${arrow})`}
                />
              )
            })}
          </g>
          <g>
            {NODES.map((node) => {
              const card = ownCard(node, cards)
              return (
                <Box
                  key={node.id}
                  node={node}
                  tone={toneOf(node, cards)}
                  subtitle={card === undefined ? '' : statusText(card, translate)}
                  selected={chosen === node.id}
                  dim={lit !== null && !lit.nodes.has(node.id)}
                  title={titleOf(node.id)}
                  onChoose={choose}
                />
              )
            })}
          </g>
        </svg>
      </div>
      <div className={css.card} data-testid="flow-detail" aria-live="polite">
        {picked === undefined || around === undefined
          ? <span className={css.line}>{translate('flow.pick')}</span>
          : (
            <>
              <div className={css.cardHeader}>
                <span className={css.cardTitle}>
                  {toneOf(picked, cards) === 'none' ? null : <span className={css.dot} data-tone={toneOf(picked, cards)} aria-hidden="true" />}
                  {titleOf(picked.id)}
                </span>
                {manage !== undefined && canManage(manage)
                  ? <button type="button" className={css.button} onClick={() => { select?.(manage) }}>{translate('common.manage')}</button>
                  : null}
              </div>
              <span className={css.line}>{translate(`flow.node.${picked.id}.desc` as never)}</span>
              {pickedCard === undefined
                ? null
                : (
                  <div className={css.facts}>
                    <span>{statusText(pickedCard, translate)}</span>
                    {factLines(pickedCard, translate, now).map(line => <span key={line}>{line}</span>)}
                  </div>
                )}
              <div className={css.facts}>
                {around.before.length === 0 ? null : <span>{translate('flow.from', { list: list(around.before) })}</span>}
                {around.after.length === 0 ? null : <span>{translate('flow.to', { list: list(around.after) })}</span>}
              </div>
            </>
          )}
      </div>
    </section>
  )
}
