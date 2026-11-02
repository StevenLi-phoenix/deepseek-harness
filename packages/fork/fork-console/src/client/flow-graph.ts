/**
 * The event service's data flow as a graph: where an event comes from, what it passes through, and where an answer goes.
 * The topology is written down here, drawn in the flow editor and exported from it (`nodes` and `edges` of its JSON); it is
 * the owner's picture of the flow, so a box may name something not wired yet. A diamond-shaped `cond` box asks a question and
 * its arrows carry the answer. The Flow page lays it out from the edges alone, so a new edge moves the nodes by itself and a
 * cycle fails `flow-graph.client.spec.ts`. Pure data and arithmetic: no DOM, no Host call.
 */

import type { ServiceId } from '../views.ts'

/** How a node sits in the flow, for its accent colour; `cond` is a question whose arrows are its answers. */
export type NodeRole = 'source' | 'core' | 'agent' | 'out' | 'cond'

/** The answer an arrow out of a `cond` box stands for. */
export type Branch = 'yes' | 'no'

/** What an edge carries: a pushed event, something the agent pulls through a tool, an outgoing message, or a call. */
export type EdgeKind = 'event' | 'pull' | 'send' | 'call'

/** One box on the canvas. */
export interface FlowNode {
  readonly id: string
  readonly role: NodeRole
  /** Name in the box when the dictionary has none (`flow.node.<id>`); such a box has no description either. */
  readonly title?: string
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
  /** Which answer of a `cond` box this arrow is. */
  readonly branch?: Branch
}

/** Every box, in the order that breaks ties inside a column. */
export const NODES: readonly FlowNode[] = [
  { id: 'wechatIn', role: 'source', service: 'wechat', manage: 'fork-wechat' },
  { id: 'qq', role: 'source', service: 'qq', manage: 'fork-qq' },
  { id: 'bili', role: 'source', service: 'bili', manage: 'bili' },
  { id: 'github', role: 'source' },
  { id: 'pipelines', role: 'source' },
  { id: 'host', role: 'source' },
  { id: 'ams', role: 'source', service: 'ams' },
  { id: 'operator', role: 'source' },
  { id: 'schedule', role: 'source', manage: 'fork-courses' },
  { id: 'presence', role: 'source' },
  { id: 'speech', role: 'source', title: '语音输出' },
  { id: 'personaIn', role: 'source', title: 'Persona', service: 'style', manage: 'fork-style' },
  { id: 'uploadLocal', role: 'source', title: 'bilibili upload from local' },
  { id: 'dnd', role: 'core', service: 'dsh', manage: 'fork-presence' },
  { id: 'merge', role: 'core', title: 'merge 定时任务 + 勿扰状态' },
  { id: 'deferQ', role: 'core', title: 'defer delay?' },
  { id: 'githubSessions', role: 'agent', title: 'Github Sessions Group By repo', service: 'dsh', manage: 'fork-agents' },
  { id: 'notifySession', role: 'agent', title: '通知消息 session', service: 'bus', manage: 'fork-subscriptions' },
  { id: 'qqSessions', role: 'agent', title: 'QQ sessions group by ids', service: 'dsh', manage: 'fork-agents' },
  { id: 'amsGroup', role: 'agent', title: 'AMS msg group', service: 'dsh', manage: 'fork-agents' },
  { id: 'repairQ', role: 'cond', title: '自动修复' },
  { id: 'repair', role: 'agent', title: '自动修复', service: 'dsh', manage: 'fork-agents' },
  { id: 'qqMain', role: 'agent', title: 'shared QQ main session (iso)', service: 'dsh', manage: 'fork-agents' },
  { id: 'autocutQ', role: 'cond', title: 'Autocut?' },
  { id: 'autocut', role: 'agent', title: 'autocut' },
  { id: 'main', role: 'agent', service: 'dsh', manage: 'fork-agents' },
  { id: 'up', role: 'agent', service: 'dsh', manage: 'fork-agents' },
  { id: 'gate', role: 'out', service: 'bili', manage: 'bili' },
  { id: 'cc', role: 'out', service: 'cc', manage: 'fork-agents' },
  { id: 'voice', role: 'out', service: 'voice', manage: 'fork-agents' },
  { id: 'persona', role: 'out', title: 'Persona', service: 'style', manage: 'fork-style' },
  { id: 'qqOut', role: 'out', title: 'QQ onebot', service: 'qq', manage: 'fork-qq' },
  { id: 'autocutOut', role: 'out', title: 'autocut' },
  { id: 'wechatOut', role: 'out', service: 'wechat', manage: 'fork-wechat' },
  { id: 'biliOut', role: 'out', service: 'bili', manage: 'bili' },
]

/** Every arrow. */
export const EDGES: readonly FlowEdge[] = [
  { from: 'wechatIn', to: 'main', kind: 'event' },
  { from: 'up', to: 'gate', kind: 'pull' },
  { from: 'gate', to: 'biliOut', kind: 'send' },
  { from: 'main', to: 'cc', kind: 'call' },
  { from: 'github', to: 'githubSessions', kind: 'event' },
  { from: 'presence', to: 'notifySession', kind: 'event' },
  { from: 'qq', to: 'qqSessions', kind: 'event' },
  { from: 'qqSessions', to: 'persona', kind: 'pull' },
  { from: 'bili', to: 'persona', kind: 'pull' },
  { from: 'notifySession', to: 'main', kind: 'event' },
  { from: 'qqSessions', to: 'main', kind: 'event' },
  { from: 'host', to: 'notifySession', kind: 'event' },
  { from: 'operator', to: 'main', kind: 'event' },
  { from: 'main', to: 'voice', kind: 'event' },
  { from: 'speech', to: 'main', kind: 'event' },
  { from: 'main', to: 'wechatOut', kind: 'event' },
  { from: 'personaIn', to: 'up', kind: 'event' },
  { from: 'bili', to: 'up', kind: 'event' },
  { from: 'ams', to: 'amsGroup', kind: 'event' },
  { from: 'amsGroup', to: 'repairQ', kind: 'event' },
  { from: 'repairQ', to: 'repair', kind: 'event', branch: 'yes' },
  { from: 'repair', to: 'notifySession', kind: 'event' },
  { from: 'personaIn', to: 'qqSessions', kind: 'event' },
  { from: 'personaIn', to: 'qqMain', kind: 'event' },
  { from: 'qqSessions', to: 'qqMain', kind: 'event' },
  { from: 'qqMain', to: 'qqOut', kind: 'pull' },
  { from: 'repairQ', to: 'notifySession', kind: 'event', branch: 'no' },
  { from: 'schedule', to: 'merge', kind: 'event' },
  { from: 'dnd', to: 'merge', kind: 'event' },
  { from: 'merge', to: 'main', kind: 'event' },
  { from: 'main', to: 'deferQ', kind: 'event' },
  { from: 'deferQ', to: 'wechatOut', kind: 'event' },
  { from: 'voice', to: 'wechatOut', kind: 'event' },
  { from: 'githubSessions', to: 'repairQ', kind: 'event' },
  { from: 'autocut', to: 'notifySession', kind: 'event' },
  { from: 'main', to: 'autocutOut', kind: 'event' },
  { from: 'pipelines', to: 'amsGroup', kind: 'event' },
  { from: 'uploadLocal', to: 'autocutQ', kind: 'event' },
  { from: 'autocutQ', to: 'autocut', kind: 'event', branch: 'yes' },
  { from: 'autocut', to: 'biliOut', kind: 'event' },
  { from: 'autocutQ', to: 'biliOut', kind: 'event', branch: 'no' },
  { from: 'autocut', to: 'amsGroup', kind: 'send' },
  { from: 'autocut', to: 'voice', kind: 'pull' },
  { from: 'qqMain', to: 'voice', kind: 'pull' },
]

/** Box size and spacing, in canvas units. */
export const NODE_W = 132
export const NODE_H = 46
const COLUMN_GAP = 76
const ROW_GAP = 14
const PAD_X = 16
/** Room above the first row. */
const HEAD = 16
const PAD_BOTTOM = 16

/** Left edge of a column. */
export const columnX = (rank: number): number => PAD_X + rank * (NODE_W + COLUMN_GAP)

/** Where the boxes go. */
export interface Layout {
  /**
   * Column of each box: one more than its latest-placed upstream box, but not before its `minRank`; a source sits right before
   * the first box it feeds.
   */
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
  // A source sits right before the first box it feeds, not at the far left, so its arrows stay short.
  for (const node of nodes) {
    const feeds = (outgoing.get(node.id) ?? []).map(id => rank[id] ?? 0)
    if ((incoming.get(node.id) ?? []).length === 0 && feeds.length > 0) rank[node.id] = Math.min(...feeds) - 1
  }
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

/** The middle of an arrow, where its answer is written. */
export function edgeMid(from: string, to: string): { readonly x: number; readonly y: number } {
  const a = spot(from)
  const b = spot(to)
  return { x: (a.x + NODE_W + b.x) / 2, y: (a.y + b.y + NODE_H) / 2 }
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
