/**
 * The card under the Data flow picture: what the chosen box is, how its service is doing, what feeds it, where it goes, and a
 * Manage button when its settings section exists.
 */

import type { ReactNode } from 'react'
import { factLines, statusText } from './cards.ts'
import type { FlowGraph, FlowNode } from './flow-model.ts'
import { noteOf, ownCard, titleOf, toneOf, wiringOf, type Cards } from './flow-view.ts'
import type { Translate } from './format.ts'
import css from './Console.module.css'

/** What the card is given. */
export interface FlowDetailProps {
  graph: FlowGraph
  /** The chosen box, if any. */
  node: FlowNode | undefined
  cards: Cards
  /** When the cards were read, for the age of their facts. */
  now: number
  /** Whether a section is registered, so only live links show. */
  canManage: (section: string) => boolean
  onManage: (section: string) => void
  translate: Translate
}

/**
 * Describe the chosen box, or say how to choose one.
 * @param props - the graph, the box, the cards, and the callbacks.
 * @returns the card.
 */
export function FlowDetail({ graph, node, cards, now, canManage, onManage, translate }: FlowDetailProps): ReactNode {
  if (node === undefined) {
    return (
      <div className={css.card} data-testid="flow-detail" aria-live="polite">
        <span className={css.line}>{translate('flow.pick')}</span>
      </div>
    )
  }
  const around = graph.neighbours(node.id)
  const names = (ids: readonly string[]): string => ids
    .flatMap((id) => {
      const other = graph.node(id)
      return other === undefined ? [] : [titleOf(other, translate)]
    })
    .join(translate('flow.sep'))
  const tone = toneOf(node, cards)
  const card = ownCard(node, cards)
  const note = noteOf(node, translate)
  const wiring = wiringOf(node)
  const { manage, via, gap } = node
  return (
    <div className={css.card} data-testid="flow-detail" aria-live="polite">
      <div className={css.cardHeader}>
        <span className={css.cardTitle}>
          {tone === 'none' ? null : <span className={css.dot} data-tone={tone} aria-hidden="true" />}
          {titleOf(node, translate)}
        </span>
        {manage !== undefined && canManage(manage)
          ? <button type="button" className={css.button} onClick={() => { onManage(manage) }}>{translate('common.manage')}</button>
          : null}
      </div>
      {note === undefined ? null : <span className={css.line}>{note}</span>}
      <div className={css.facts} data-wired={wiring}>
        <span>{translate(`flow.wired.${wiring}`)}</span>
        {via === undefined ? null : <span>{translate('flow.via', { list: via })}</span>}
        {gap === undefined ? null : <span>{gap}</span>}
      </div>
      {card === undefined
        ? null
        : (
          <div className={css.facts}>
            <span>{statusText(card, translate)}</span>
            {factLines(card, translate, now).map(line => <span key={line}>{line}</span>)}
          </div>
        )}
      <div className={css.facts}>
        {around.before.length === 0 ? null : <span>{translate('flow.from', { list: names(around.before) })}</span>}
        {around.after.length === 0 ? null : <span>{translate('flow.to', { list: names(around.after) })}</span>}
      </div>
    </div>
  )
}
