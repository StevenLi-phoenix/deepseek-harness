/**
 * The message flow picture. The arrows that carry events are always drawn, heavier the more passed them, and a dot runs along the
 * ones that were used in the last minutes; an arrow for a tool or a call appears only with a box it belongs to. Choosing a box lights
 * every path through it, and following a feed row draws its way one arrow after another. Everything comes in as props.
 */

import { memo, useMemo, type ReactNode } from 'react'
import { columnX, edgeKey, type FlowEdge, type FlowGraph } from './flow-model.ts'
import { titleOf, type BoxFact } from './flow-view.ts'
import { FlowBox } from './FlowBox.tsx'
import type { Translate } from './format.ts'
import css from './Console.module.css'

/** How recent a passage keeps the dot running on an arrow. */
const LIVE_MS = 15 * 60_000
/** Most dots at once, so a busy minute stays calm. */
const MAX_DOTS = 10
/** Each arrow of a walked way starts this much after the one before it. */
const STEP_MS = 170
/** How far the picture may shrink to fit before the page scrolls sideways instead: below this its words are too small to read. */
const MIN_FIT = 0.8

interface FlowArrowProps {
  d: string
  edge: FlowEdge
  /** `broken`, `idle`, or nothing. */
  state: string | undefined
  weight: number
  dim: boolean
  lit: boolean
  dot: boolean
  answer: string | undefined
  mid: { x: number; y: number } | undefined
  /** Seconds the dot runs ahead, so dots do not march in step. */
  phase: number
}

const FlowArrow = memo(function FlowArrow({ d, edge, state, weight, dim, lit, dot, answer, mid, phase }: FlowArrowProps): ReactNode {
  const key = edgeKey(edge)
  return (
    <g>
      <path
        className={css.flowEdge}
        d={d}
        data-edge={key}
        data-kind={edge.kind}
        data-state={state}
        data-dim={dim ? '' : undefined}
        data-lit={lit ? '' : undefined}
        style={{ strokeWidth: lit ? weight + 0.75 : weight }}
      />
      {dot && !dim
        ? (
          <circle className={css.flowDot} r={2.5} data-dot={key}>
            <animateMotion dur="2.8s" begin={`-${phase}s`} repeatCount="indefinite" path={d} />
          </circle>
        )
        : null}
      {answer === undefined || mid === undefined
        ? null
        : (
          <text className={css.flowLabel} x={mid.x} y={mid.y + 4} textAnchor="middle" data-label={key} data-dim={dim ? '' : undefined}>
            {answer}
          </text>
        )}
    </g>
  )
})

/** What the picture is given. */
export interface FlowCanvasProps {
  graph: FlowGraph
  facts: ReadonlyMap<string, BoxFact>
  /** The chosen box, if any. */
  chosen: string | null
  /** The way of the followed feed row; empty when none is followed. */
  walk: readonly FlowEdge[]
  /** Changes with each new walk, so it draws again. */
  walkKey: string
  now: number
  onChoose: (id: string) => void
  /** Called on a click on the background or Escape. */
  onClear: () => void
  translate: Translate
  /** Words above the columns, for a graph on fixed cells. */
  lanes?: readonly { readonly column: number; readonly label: string }[]
}

/** 1 for an unused arrow, up to 3.25 for a busy one. */
const weightOf = (count: number): number => Math.min(3.25, 1 + Math.log10(count + 1))

/**
 * Draw the graph.
 * @param props - the graph, what each box says, the choice, and the callbacks.
 * @returns the SVG.
 */
export function FlowCanvas({
  graph, facts, chosen, walk, walkKey, now, onChoose, onClear, translate, lanes = [],
}: FlowCanvasProps): ReactNode {
  const lit = useMemo(() => chosen === null ? null : graph.relatives(chosen), [graph, chosen])
  const walked = useMemo(() => {
    const boxes = new Set(walk.flatMap(edge => [edge.from, edge.to]))
    return { boxes, edges: new Set(walk.map(edgeKey)) }
  }, [walk])
  const following = walk.length > 0
  const { width, height } = graph.layout
  let dots = 0
  return (
    <svg
      className={css.flowSvg}
      style={{ width: '100%', maxWidth: width, minWidth: Math.round(width * MIN_FIT) }}
      viewBox={`0 0 ${width} ${height}`}
      role="group"
      aria-label={translate('title.flow')}
      onClick={onClear}
      onKeyDown={(event) => { if (event.key === 'Escape') onClear() }}
    >
      {lanes.map(lane => <text key={lane.column} className={css.flowLane} x={columnX(lane.column)} y={15}>{lane.label}</text>)}
      <g>
        {graph.edges.map((edge, index) => {
          const key = edgeKey(edge)
          const onLit = lit?.edges.has(key) === true
          const supporting = edge.kind === 'pull' || edge.kind === 'call'
          if (supporting && !onLit) return null
          const source = facts.get(edge.from)
          const target = facts.get(edge.to)
          const broken = source?.state === 'bad'
          const idle = source?.state === 'idle' || target?.state === 'idle'
          const recent = source?.lastAt != null && now - source.lastAt < LIVE_MS
          const dot = recent && !broken && !supporting && dots < MAX_DOTS
          if (dot) dots += 1
          return (
            <FlowArrow
              key={key}
              d={graph.path(edge.from, edge.to)}
              edge={edge}
              state={broken ? 'broken' : idle ? 'idle' : undefined}
              weight={weightOf(source?.count ?? 0)}
              dim={following ? !walked.edges.has(key) : lit !== null && !onLit}
              lit={onLit}
              dot={dot}
              answer={edge.branch === undefined ? undefined : translate(`flow.branch.${edge.branch}`)}
              mid={edge.branch === undefined ? undefined : graph.mid(edge.from, edge.to)}
              phase={(index * 0.7) % 2.8}
            />
          )
        })}
      </g>
      {/* Drawn again on top, each from its start after the one before it: the walk reads as one thing moving through the service. */}
      <g key={walkKey}>
        {walk.map((edge, index) => (
          <path
            key={edgeKey(edge)}
            className={css.flowRun}
            d={graph.path(edge.from, edge.to)}
            pathLength={1}
            data-run={edgeKey(edge)}
            style={{ animationDelay: `${index * STEP_MS}ms` }}
          />
        ))}
      </g>
      <g>
        {graph.nodes.map((node) => {
          const fact = facts.get(node.id)
          return (
            <FlowBox
              key={node.id}
              node={node}
              at={graph.spot(node.id)}
              state={fact?.state ?? 'plain'}
              fact={fact?.text ?? ''}
              selected={chosen === node.id}
              dim={following ? !walked.boxes.has(node.id) : lit !== null && !lit.nodes.has(node.id)}
              walked={following && walked.boxes.has(node.id)}
              title={titleOf(node, translate)}
              onChoose={onChoose}
            />
          )
        })}
      </g>
    </svg>
  )
}
