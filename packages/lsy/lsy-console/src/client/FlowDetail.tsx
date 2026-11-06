/**
 * The side of the message flow page. With nothing chosen it lists what just happened, and following a row draws its way through the
 * picture. With a box chosen it says how the box stands, how to fix it when it is broken, and what passed it. How the box is wired
 * stays behind a disclosure: it answers a builder's question, not the first one.
 */

import type { ReactNode } from 'react'
import type { FlowOutcome, FlowRecentItem } from '../views.ts'
import { clock, ago, type Translate } from './format.ts'
import type { FlowGraph, FlowNode } from './flow-model.ts'
import { noteOf, rowsThrough, titleOf, wiringOf, type BoxFact } from './flow-view.ts'
import css from './Console.module.css'

/** The word for each outcome. */
const OUTCOME_TONE: Readonly<Record<FlowOutcome, string>> = {
  sent: 'good', silent: 'quiet', failed: 'bad', working: 'busy', waiting: 'busy', suppressed: 'quiet', unmatched: 'quiet',
}

/** One row of the list. */
function FeedRow({ item, now, following, onFollow, translate }: {
  item: FlowRecentItem
  now: number
  following: boolean
  onFollow: (item: FlowRecentItem) => void
  translate: Translate
}): ReactNode {
  const today = new Date(item.at).toDateString() === new Date(now).toDateString()
  return (
    <button type="button" className={css.flowRow} aria-pressed={following} data-outcome={item.outcome} onClick={() => { onFollow(item) }}>
      <time className={css.flowRowTime}>{today ? clock(item.at) : ago(item.at, now, translate)}</time>
      <span className={css.flowRowTitle}>{item.title}</span>
      <span className={css.flowRowOutcome} data-tone={OUTCOME_TONE[item.outcome]}>{translate(`flow.outcome.${item.outcome}`)}</span>
    </button>
  )
}

/** What the side is given. */
export interface FlowSideProps {
  graph: FlowGraph
  node: FlowNode | undefined
  fact: BoxFact | undefined
  recent: readonly FlowRecentItem[]
  /** Events of the span the list leaves out, because nothing took them. */
  ignored: number
  /** The row being followed, by id. */
  followed: string | null
  now: number
  /** Whether a Settings section is registered, so only live links show. */
  canManage: (section: string) => boolean
  onManage: (section: string) => void
  onFollow: (item: FlowRecentItem) => void
  onBack: () => void
  translate: Translate
}

/**
 * Render the side.
 * @param props - the picture, the choice, and the list.
 * @returns the side panel.
 */
export function FlowSide({
  graph, node, fact, recent, ignored, followed, now, canManage, onManage, onFollow, onBack, translate,
}: FlowSideProps): ReactNode {
  const list = (items: readonly FlowRecentItem[]): ReactNode => (
    <div className={css.flowFeed}>
      {items.map(item => (
        <FeedRow key={item.id} item={item} now={now} following={followed === item.id} onFollow={onFollow} translate={translate} />
      ))}
    </div>
  )
  if (node === undefined) {
    return (
      <aside className={css.flowSide} data-testid="flow-side" key="feed">
        <h2 className={css.flowSideTitle}>{translate('flow.feed.title')}</h2>
        <p className={css.flowSideNote}>{translate('flow.feed.hint')}</p>
        {recent.length === 0 ? <p className={css.flowSideNote}>{translate('flow.feed.empty')}</p> : list(recent)}
        {ignored > 0 ? <p className={css.flowFeedRest}>{translate('flow.feed.ignored', { count: ignored })}</p> : null}
      </aside>
    )
  }
  const around = graph.neighbours(node.id)
  const names = (ids: readonly string[]): string => ids
    .flatMap((id) => {
      const other = graph.node(id)
      return other === undefined ? [] : [titleOf(other, translate)]
    })
    .join(translate('flow.sep'))
  const through = rowsThrough(graph, node.id, recent)
  const note = noteOf(node, translate)
  const wiring = wiringOf(node)
  const { manage, via, gap } = node
  const broken = fact?.state === 'bad' || fact?.state === 'hit'
  const action = manage !== undefined && canManage(manage)
    ? (
      <button type="button" className={css.flowAction} data-primary={broken ? '' : undefined} onClick={() => { onManage(manage) }}>
        {translate(broken ? 'flow.fix' : 'common.manage')}
      </button>
    )
    : null
  return (
    <aside className={css.flowSide} data-testid="flow-side" key={node.id}>
      <button type="button" className={css.flowBack} onClick={onBack}>{translate('flow.back')}</button>
      <h2 className={css.flowSideTitle}>{titleOf(node, translate)}</h2>
      {fact === undefined || fact.text === '' ? null : <p className={css.flowSideFact} data-state={fact.state}>{fact.text}</p>}
      {note === undefined ? null : <p className={css.flowSideNote}>{note}</p>}
      {action}
      <h3 className={css.flowSideHead}>{translate('flow.side.through')}</h3>
      {through.length === 0 ? <p className={css.flowSideNote}>{translate('flow.side.none')}</p> : list(through)}
      <h3 className={css.flowSideHead}>{translate('flow.side.around')}</h3>
      {around.before.length === 0 ? null : <p className={css.flowSideNote}>{translate('flow.from', { list: names(around.before) })}</p>}
      {around.after.length === 0 ? null : <p className={css.flowSideNote}>{translate('flow.to', { list: names(around.after) })}</p>}
      <details className={css.flowWiring}>
        <summary>{translate('flow.side.wiring')}</summary>
        <p className={css.flowSideNote}>{translate(`flow.wired.${wiring}`)}</p>
        {via === undefined ? null : <p className={css.flowSideNote}>{translate('flow.via', { list: via })}</p>}
        {gap === undefined ? null : <p className={css.flowSideNote}>{gap}</p>}
      </details>
    </aside>
  )
}
