/**
 * One box of the Data flow graph: a rounded rectangle, or a hexagon for a question, with its name, its service's health dot, and
 * a status line when the service has one. Memoised, so choosing a box redraws only the boxes whose lighting changed.
 */

import { memo, type KeyboardEvent, type ReactNode } from 'react'
import { NODE_H, NODE_W, type FlowNode, type CanvasPoint } from './flow-model.ts'
import type { BoxTone } from './flow-view.ts'
import css from './Console.module.css'

/** Longest line a box shows before the detail line below takes over. */
const LINE_MAX = 14
/** How far a hexagon's points reach in. */
const CUT = 14
const HEXAGON = `${CUT},0 ${NODE_W - CUT},0 ${NODE_W},${NODE_H / 2} ${NODE_W - CUT},${NODE_H} ${CUT},${NODE_H} 0,${NODE_H / 2}`

/**
 * Shorten a line to what a box can show.
 * @param text - the line.
 * @returns the line, with an ellipsis when it was cut.
 */
export const clip = (text: string): string => text.length > LINE_MAX ? `${text.slice(0, LINE_MAX - 1)}…` : text

/**
 * Break a title over up to two lines, at a space when there is one in reach, and clip what is left.
 * @param text - the title.
 * @returns one or two lines.
 */
export function wrapTitle(text: string): readonly string[] {
  if (text.length <= LINE_MAX) return [text]
  // Latin words are narrower than the CJK characters the limit is counted in, so a line may run two characters over to end at a space.
  const space = text.lastIndexOf(' ', LINE_MAX + 2)
  const cut = space >= 6 ? space : LINE_MAX
  return [text.slice(0, cut).trimEnd(), clip(text.slice(cut).trimStart())]
}

/** What a box is given. */
export interface FlowBoxProps {
  node: FlowNode
  /** Top-left corner on the canvas. */
  at: CanvasPoint
  tone: BoxTone
  /** The service's status line, empty when the box has none. */
  subtitle: string
  selected: boolean
  dim: boolean
  title: string
  onChoose: (id: string) => void
}

/**
 * Draw one box.
 * @param props - the box, where it sits, how it is lit, and what it says.
 * @returns the SVG group.
 */
export const FlowBox = memo(function FlowBox({ node, at, tone, subtitle, selected, dim, title, onChoose }: FlowBoxProps): ReactNode {
  const question = node.role === 'cond'
  const lines = wrapTitle(title)
  const left = question ? CUT + 4 : 12
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
      {question
        ? <polygon className={css.flowBox} points={HEXAGON} />
        : <rect className={css.flowBox} width={NODE_W} height={NODE_H} rx={9} />}
      {tone === 'none' ? null : <circle className={css.flowDot} cx={NODE_W - (question ? 20 : 12)} cy={13} r={3.5} data-tone={tone} />}
      {subtitle === ''
        ? lines.map((line, i) => (
          <text key={line} className={css.flowTitle} x={left} y={lines.length === 1 ? 28 : 20 + i * 14}>{line}</text>
        ))
        : (
          <>
            <text className={css.flowTitle} x={12} y={20}>{clip(title)}</text>
            <text className={css.flowSub} x={12} y={36}>{subtitle}</text>
          </>
        )}
    </g>
  )
})
