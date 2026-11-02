/**
 * The event service's data flow as a graph: where an event comes from, what it passes through, and where an answer goes.
 * The topology is written down here (it mirrors `lsy/bundles/event/cordis.patch.yml` and `lsy/AGENTS.md`); the Flow page lays
 * it out from the edges alone, so a new edge moves the nodes by itself and a cycle fails `flow-graph.client.spec.ts`.
 * Pure data and arithmetic: no DOM, no Host call.
 */

import type { ServiceId } from '../views.ts'

/** How a node sits in the flow, for its accent colour. */
export type NodeRole = 'source' | 'core' | 'agent' | 'out'

/** What an edge carries: a pushed event, something the agent pulls through a tool, an outgoing message, or a call. */
export type EdgeKind = 'event' | 'pull' | 'send' | 'call'

/** One box on the canvas. */
export interface FlowNode {
  readonly id: string
  readonly role: NodeRole
  /** The overview card that gives this box its health dot; boxes inside the event service use `dsh`, boxes with no probe use none. */
  readonly service?: ServiceId
  /** Settings section the Manage button opens, when one exists. */
  readonly manage?: string
  /** Earliest column, so boxes with one job line up even when their inputs would put them further left. */
  readonly minRank?: number
}

/** One arrow. */
export interface FlowEdge {
  readonly from: string
  readonly to: string
  readonly kind: EdgeKind
}

/** Every box, in the order that breaks ties inside a column. */
export const NODES: readonly FlowNode[] = [
  { id: 'wechatIn', role: 'source', service: 'wechat', manage: 'lsy-wechat' },
  { id: 'qq', role: 'source', service: 'qq', manage: 'lsy-qq' },
  { id: 'bili', role: 'source', service: 'bili', manage: 'bili' },
  { id: 'github', role: 'source' },
  { id: 'pipelines', role: 'source' },
  { id: 'host', role: 'source' },
  { id: 'ams', role: 'source', service: 'ams' },
  { id: 'operator', role: 'source' },
  { id: 'schedule', role: 'source', manage: 'lsy-courses' },
  { id: 'presence', role: 'source' },
  { id: 'ingest', role: 'core', service: 'dsh' },
  { id: 'bus', role: 'core', service: 'bus', manage: 'lsy-subscriptions' },
  { id: 'dnd', role: 'core', service: 'dsh', manage: 'lsy-presence' },
  { id: 'main', role: 'agent', service: 'dsh', manage: 'lsy-agents', minRank: 3 },
  { id: 'sessions', role: 'agent', service: 'dsh', manage: 'lsy-agents' },
  { id: 'up', role: 'agent', service: 'dsh', manage: 'lsy-agents' },
  { id: 'llm', role: 'out', service: 'llm', manage: 'account' },
  { id: 'relay', role: 'core', service: 'dsh' },
  { id: 'gate', role: 'out', service: 'bili', manage: 'bili' },
  { id: 'cc', role: 'out', service: 'cc', manage: 'lsy-agents', minRank: 4 },
  { id: 'voice', role: 'out', service: 'voice', manage: 'lsy-agents', minRank: 4 },
  { id: 'wechatOut', role: 'out', service: 'wechat', manage: 'lsy-wechat' },
  { id: 'biliOut', role: 'out', service: 'bili', manage: 'bili' },
]

/** Every arrow. */
export const EDGES: readonly FlowEdge[] = [
  { from: 'wechatIn', to: 'main', kind: 'event' },
  { from: 'qq', to: 'main', kind: 'pull' },
  { from: 'ams', to: 'main', kind: 'event' },
  { from: 'schedule', to: 'main', kind: 'event' },
  { from: 'schedule', to: 'wechatOut', kind: 'send' },
  { from: 'bili', to: 'ingest', kind: 'event' },
  { from: 'pipelines', to: 'ingest', kind: 'event' },
  { from: 'host', to: 'ingest', kind: 'event' },
  { from: 'operator', to: 'ingest', kind: 'event' },
  { from: 'presence', to: 'ingest', kind: 'event' },
  { from: 'github', to: 'bus', kind: 'event' },
  { from: 'ingest', to: 'bus', kind: 'event' },
  { from: 'ingest', to: 'dnd', kind: 'event' },
  { from: 'bus', to: 'sessions', kind: 'event' },
  { from: 'bus', to: 'up', kind: 'event' },
  { from: 'bus', to: 'wechatOut', kind: 'send' },
  { from: 'dnd', to: 'wechatOut', kind: 'send' },
  { from: 'main', to: 'relay', kind: 'send' },
  { from: 'sessions', to: 'relay', kind: 'send' },
  { from: 'up', to: 'gate', kind: 'send' },
  { from: 'relay', to: 'wechatOut', kind: 'send' },
  { from: 'gate', to: 'biliOut', kind: 'send' },
  { from: 'main', to: 'cc', kind: 'call' },
  { from: 'main', to: 'voice', kind: 'call' },
  { from: 'voice', to: 'wechatOut', kind: 'send' },
  { from: 'main', to: 'llm', kind: 'call' },
  { from: 'sessions', to: 'llm', kind: 'call' },
  { from: 'up', to: 'llm', kind: 'call' },
]

/** Box size and spacing, in canvas units. */
export const NODE_W = 132
export const NODE_H = 46
const COLUMN_GAP = 76
const ROW_GAP = 14
const PAD_X = 16
/** Room above the first row for the column headings. */
const HEAD = 34
const PAD_BOTTOM = 16

/** Left edge of a column. */
export const columnX = (rank: number): number => PAD_X + rank * (NODE_W + COLUMN_GAP)

/** Where the boxes go. */
export interface Layout {
  /** Column of each box: one more than its latest-placed upstream box, but not before its `minRank`; 0 for a source. */
  readonly rank: Readonly<Record<string, number>>
  readonly ranks: number
  /** Top-left corner of each box. */
  readonly at: Readonly<Record<string, { readonly x: number; readonly y: number }>>
  readonly width: number
  readonly height: number
}

/**
 * Place the boxes: longest-path columns, then a few barycentre sweeps to reduce crossings, then centre each column.
 * @param nodes - the boxes.
 * @param edges - the arrows; a cycle throws.
 * @returns the layout.
 */
export function layout(nodes: readonly FlowNode[], edges: readonly FlowEdge[]): Layout {
  const rank: Record<string, number> = {}
  const incoming = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()
  for (const node of nodes) { incoming.set(node.id, []); outgoing.set(node.id, []) }
  for (const edge of edges) { incoming.get(edge.to)?.push(edge.from); outgoing.get(edge.from)?.push(edge.to) }

  const byId = new Map(nodes.map(node => [node.id, node]))
  const visiting = new Set<string>()
  const place = (id: string): number => {
    if (rank[id] !== undefined) return rank[id]
    if (visiting.has(id)) throw new Error(`flow graph has a cycle at ${id}`)
    visiting.add(id)
    rank[id] = Math.max((byId.get(id)?.minRank ?? 0) - 1, ...(incoming.get(id) ?? []).map(place)) + 1
    visiting.delete(id)
    return rank[id]
  }
  for (const node of nodes) place(node.id)
  const ranks = Math.max(...Object.values(rank)) + 1

  const columns: string[][] = Array.from({ length: ranks }, () => [])
  for (const node of nodes) columns[rank[node.id] ?? 0]?.push(node.id)

  const row = new Map<string, number>()
  const rowOf = (id: string): number => row.get(id) ?? 0
  columns.forEach((column) => { column.forEach((id, i) => { row.set(id, i) }) })
  const sweep = (neighbours: Map<string, string[]>, order: number[]): void => {
    for (const r of order) {
      const column = columns[r] ?? []
      const score = (id: string): number => {
        const near = neighbours.get(id) ?? []
        return near.length === 0 ? rowOf(id) : near.reduce((sum, other) => sum + rowOf(other), 0) / near.length
      }
      column.sort((a, b) => score(a) - score(b) || rowOf(a) - rowOf(b))
      column.forEach((id, i) => { row.set(id, i) })
    }
  }
  const forward = Array.from({ length: ranks }, (_, i) => i)
  for (let pass = 0; pass < 4; pass += 1) {
    sweep(incoming, forward)
    sweep(outgoing, [...forward].reverse())
  }

  const tallest = Math.max(...columns.map(column => column.length))
  const columnHeight = (count: number): number => count * NODE_H + (count - 1) * ROW_GAP
  const inner = columnHeight(tallest)
  const at: Record<string, { x: number; y: number }> = {}
  columns.forEach((column, r) => {
    const top = HEAD + (inner - columnHeight(column.length)) / 2
    column.forEach((id, i) => { at[id] = { x: columnX(r), y: top + i * (NODE_H + ROW_GAP) } })
  })
  return { rank, ranks, at, width: PAD_X * 2 + ranks * NODE_W + (ranks - 1) * COLUMN_GAP, height: HEAD + inner + PAD_BOTTOM }
}

/** The page's layout, computed once. */
export const LAYOUT: Layout = layout(NODES, EDGES)

/** Top-left corner of a box that is in the layout. */
export function spot(id: string): { readonly x: number; readonly y: number } {
  const found = LAYOUT.at[id]
  if (found === undefined) throw new Error(`flow graph has no box ${id}`)
  return found
}

/**
 * The curve of one arrow, from the right side of its source to the left side of its target.
 * @param from - source id.
 * @param to - target id.
 * @returns an SVG path.
 */
export function edgePath(from: string, to: string): string {
  const a = spot(from)
  const b = spot(to)
  const x1 = a.x + NODE_W
  const y1 = a.y + NODE_H / 2
  const x2 = b.x
  const y2 = b.y + NODE_H / 2
  const reach = Math.max(36, (x2 - x1) / 2)
  return `M${x1} ${y1} C${x1 + reach} ${y1} ${x2 - reach} ${y2} ${x2} ${y2}`
}

/** What a box is connected to. */
export interface Relatives {
  /** The box itself, everything that can reach it, and everything it can reach. */
  readonly nodes: ReadonlySet<string>
  /** The arrows among those boxes, as `from>to`. */
  readonly edges: ReadonlySet<string>
}

/**
 * Walk the graph both ways from a box.
 * @param id - the box.
 * @returns the boxes and arrows on any path through it.
 */
export function relatives(id: string): Relatives {
  const nodes = new Set([id])
  const edges = new Set<string>()
  const walk = (start: string, next: (edge: FlowEdge) => [string, string] | null): void => {
    // The queue grows while it is walked; a for-of over an array also visits what is pushed meanwhile.
    const queue = [start]
    for (const current of queue) {
      for (const edge of EDGES) {
        const step = next(edge)
        if (step === null || step[0] !== current) continue
        edges.add(`${edge.from}>${edge.to}`)
        if (!nodes.has(step[1])) { nodes.add(step[1]); queue.push(step[1]) }
      }
    }
  }
  walk(id, edge => [edge.from, edge.to])
  walk(id, edge => [edge.to, edge.from])
  return { nodes, edges }
}

/** Boxes upstream and downstream of one box, one step away, for the detail line. */
export function neighbours(id: string): { readonly before: readonly string[]; readonly after: readonly string[] } {
  return {
    before: EDGES.filter(edge => edge.to === id).map(edge => edge.from),
    after: EDGES.filter(edge => edge.from === id).map(edge => edge.to),
  }
}
