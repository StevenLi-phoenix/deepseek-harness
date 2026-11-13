/**
 * One box of the message flow: its name and one line about now. A healthy box stays quiet, so the eye goes to the one that is not:
 * broken is red and breathes, a box that lost what it needs is dashed, and one that saw nothing fades back. A question has round
 * ends. Memoised, so choosing a box redraws only the boxes whose lighting changed.
 */

import { memo, type KeyboardEvent, type ReactNode } from 'react'
import { NODE_H, NODE_W, type FlowNode, type CanvasPoint } from './flow-model.ts'
import type { BoxState } from './flow-view.ts'
import css from './Console.module.css'

/** Longest lines a box shows, in CJK-wide characters. */
const TITLE_MAX = 8.8
const FACT_MAX = 9.8

/** Half a width for a narrow Latin character, a whole one for a wide one. */
const widthOf = (char: string): number => /[ -ɏ]/u.test(char) ? 0.55 : 1

/**
 * Shorten a line to what a box can show.
 * @param text - the line.
 * @param limit - how many CJK-wide characters fit.
 * @returns the line, with an ellipsis when it was cut.
 */
export function clip(text: string, limit: number = FACT_MAX): string {
  let used = 0
  const kept: string[] = []
  for (const char of Array.from(text)) {
    used += widthOf(char)
    if (used > limit) return `${kept.join('')}…`
    kept.push(char)
  }
  return text
}

/** What a box is given. */
export interface FlowBoxProps {
  node: FlowNode
  /** Top-left corner on the canvas. */
  at: CanvasPoint
  state: BoxState
  /** The line about now; empty when there is nothing to say. */
  fact: string
  selected: boolean
  dim: boolean
  /** On the walked path. */
  walked: boolean
  title: string
  onChoose: (id: string) => void
}

/**
 * Draw one box.
 * @param props - the box, where it sits, how it stands, and what it says.
 * @returns the SVG group.
 */
export const FlowBox = memo(function FlowBox({ node, at, state, fact, selected, dim, walked, title, onChoose }: FlowBoxProps): ReactNode {
  const onKeyDown = (event: KeyboardEvent<SVGGElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onChoose(node.id)
    }
  }
  const label = [title, fact].filter(part => part !== '').join(', ')
  const hub = node.id === 'main' || node.id === 'wechatOut'
  return (
    <g
      className={css.flowNode}
      transform={`translate(${at.x} ${at.y})`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={label}
      data-node={node.id}
      data-role={node.role}
      data-state={state}
      data-hub={hub ? '' : undefined}
      data-dim={dim ? '' : undefined}
      data-walked={walked ? '' : undefined}
      onClick={(event) => { event.stopPropagation(); onChoose(node.id) }}
      onKeyDown={onKeyDown}
    >
      <title>{label}</title>
      {state === 'bad' ? <rect className={css.flowHalo} x={-3} y={-3} width={NODE_W + 6} height={NODE_H + 6} rx={12} /> : null}
      <rect className={css.flowBox} width={NODE_W} height={NODE_H} rx={node.role === 'cond' ? NODE_H / 2 : 9} />
      {fact === ''
        ? <text className={css.flowTitle} x={12} y={NODE_H / 2 + 4.5}>{clip(title, TITLE_MAX)}</text>
        : (
          <>
            <text className={css.flowTitle} x={12} y={18}>{clip(title, TITLE_MAX)}</text>
            <text className={css.flowSub} x={12} y={33}>{clip(fact)}</text>
          </>
        )}
    </g>
  )
})
