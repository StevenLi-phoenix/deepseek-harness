/**
 * The Data flow picture: every arrow, then every box, on one SVG. Choosing a box lights the arrows and boxes on any path through
 * it and dims the rest. The graph, the cards, and the choice come in as props; nothing here reads a store.
 */

import { memo, useId, useMemo, type ReactNode } from 'react'
import type { ServiceCard } from '../views.ts'
import { statusText } from './cards.ts'
import { edgeKey, type FlowEdge, type FlowGraph } from './flow-model.ts'
import { ownCard, titleOf, toneOf, type Cards } from './flow-view.ts'
import { FlowBox } from './FlowBox.tsx'
import type { Translate } from './format.ts'
import css from './Console.module.css'

interface FlowArrowProps {
  graph: FlowGraph
  edge: FlowEdge
  dim: boolean
  /** `id` of the arrowhead marker. */
  marker: string
  /** The answer written on the arrow, when it has one. */
  answer: string | undefined
}

const FlowArrow = memo(function FlowArrow({ graph, edge, dim, marker, answer }: FlowArrowProps): ReactNode {
  const key = edgeKey(edge)
  const mid = answer === undefined ? undefined : graph.mid(edge.from, edge.to)
  return (
    <g>
      <path
        className={css.flowEdge}
        d={graph.path(edge.from, edge.to)}
        data-edge={key}
        data-kind={edge.kind}
        data-dim={dim ? '' : undefined}
        markerEnd={`url(#${marker})`}
      />
      {answer === undefined || mid === undefined
        ? null
        : (
          <text className={css.flowLabel} x={mid.x} y={mid.y + 4} textAnchor="middle" data-branch={edge.branch} data-label={key} data-dim={dim ? '' : undefined}>
            {answer}
          </text>
        )}
    </g>
  )
})

/** What the picture is given. */
export interface FlowCanvasProps {
  graph: FlowGraph
  cards: Cards
  /** The chosen box, if any. */
  chosen: string | null
  onChoose: (id: string) => void
  /** Called on a click on the background or Escape. */
  onClear: () => void
  translate: Translate
}

/**
 * Draw the graph.
 * @param props - the graph, the cards its boxes read, the choice, and the callbacks.
 * @returns the SVG.
 */
export function FlowCanvas({ graph, cards, chosen, onChoose, onClear, translate }: FlowCanvasProps): ReactNode {
  const marker = useId().replaceAll(':', '')
  const lit = useMemo(() => chosen === null ? null : graph.relatives(chosen), [graph, chosen])
  const { width, height } = graph.layout
  const label = translate('title.flow')
  return (
    <svg
      className={css.flowSvg}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="group"
      aria-label={label}
      onClick={onClear}
      onKeyDown={(event) => { if (event.key === 'Escape') onClear() }}
    >
      <defs>
        <marker id={marker} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path className={css.flowHead} d="M0 0.5 L7 4 L0 7.5 Z" />
        </marker>
      </defs>
      <g>
        {graph.edges.map(edge => (
          <FlowArrow
            key={edgeKey(edge)}
            graph={graph}
            edge={edge}
            dim={lit !== null && !lit.edges.has(edgeKey(edge))}
            marker={marker}
            answer={edge.branch === undefined ? undefined : translate(`flow.branch.${edge.branch}`)}
          />
        ))}
      </g>
      <g>
        {graph.nodes.map((node) => {
          const card: ServiceCard | undefined = ownCard(node, cards)
          return (
            <FlowBox
              key={node.id}
              node={node}
              at={graph.spot(node.id)}
              tone={toneOf(node, cards)}
              subtitle={card === undefined ? '' : statusText(card, translate)}
              selected={chosen === node.id}
              dim={lit !== null && !lit.nodes.has(node.id)}
              title={titleOf(node, translate)}
              onChoose={onChoose}
            />
          )
        })}
      </g>
    </svg>
  )
}
