/**
 * The flow graph as arithmetic: boxes and arrows in, columns and coordinates out, plus the walks the page needs (what lies
 * upstream and downstream of a box). Nothing here knows which graph it is given, so a small one can stand in for it in a test;
 * the topology the page draws is `flow-graph.ts`. Pure data and arithmetic: no DOM, no Host call.
 */

import type { ServiceId } from '../views.ts'

/** How a node sits in the flow, for its accent colour; `cond` is a question whose arrows are its answers. */
export type NodeRole = 'source' | 'core' | 'agent' | 'out' | 'cond'

/** The answer an arrow out of a `cond` box stands for. */
export type Branch = 'yes' | 'no'

/**
 * How far the running service matches a box: `live` is wired the way the box draws it, `partial` is wired differently or only in
 * part, and `planned` is drawn but not built.
 */
export type Wiring = 'live' | 'partial' | 'planned'

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
  /** Whether the running service is wired the way the box draws it; a box that says nothing is read as `live`. */
  readonly wired?: Wiring
  /** What carries the box in the running service, as plain identifiers: a subscription, a plugin, a service. */
  readonly via?: string
  /** Fixed place of the box as `[column, row]`; a graph whose boxes all have one is drawn on that grid instead of from its arrows. */
  readonly cell?: readonly [number, number]
  /** What the bus knows about this box: the event sources or the subscriptions whose counts it shows. */
  readonly tracks?: { readonly sources?: readonly string[]; readonly subscriptions?: readonly string[] }
  /** The service this box gets nothing without, though it runs on another one: it is marked when that service is down. */
  readonly needs?: ServiceId
  /** For a `partial` or `planned` box: how the running service differs from the drawing, in the owner's words like a title of its own. */
  readonly gap?: string
}

/** One arrow. */
export interface FlowEdge {
  readonly from: string
  readonly to: string
  readonly kind: EdgeKind
  /** Which answer of a `cond` box this arrow is. */
  readonly branch?: Branch
}

/** Box size and spacing, in canvas units. */
export const NODE_W = 152
export const NODE_H = 48
const COLUMN_GAP = 40
const ROW_GAP = 10
const PAD_X = 16
/** Room above the first row. */
const HEAD = 16
const PAD_BOTTOM = 16

/** A spot on the canvas. */
export interface CanvasPoint {
  readonly x: number
  readonly y: number
}

/** Where the boxes go. */
export interface Layout {
  /**
   * Column of each box: one more than its latest-placed upstream box, but not before its `minRank`; a source sits right before
   * the first box it feeds.
   */
  readonly rank: Readonly<Record<string, number>>
  readonly ranks: number
  /** Top-left corner of each box. */
  readonly at: Readonly<Record<string, CanvasPoint>>
  readonly width: number
  readonly height: number
}

/** What is connected to a box, through any number of steps. */
export interface Relatives {
  /** The box itself, everything that can reach it, and everything it can reach. */
  readonly nodes: ReadonlySet<string>
  /** The arrows among those boxes, as {@link edgeKey}s. */
  readonly edges: ReadonlySet<string>
}

/** What is connected to a box, one step away. */
export interface Neighbours {
  readonly before: readonly string[]
  readonly after: readonly string[]
}

/** A graph with its layout and the lookups the page needs. */
export interface FlowGraph {
  readonly nodes: readonly FlowNode[]
  readonly edges: readonly FlowEdge[]
  readonly layout: Layout
  /** The box with this id, if there is one. */
  readonly node: (id: string) => FlowNode | undefined
  /** Top-left corner of a box that is in the layout; throws for an unknown id. */
  readonly spot: (id: string) => CanvasPoint
  /** The curve of one arrow, from the right side of its source to the left side of its target, as an SVG path. */
  readonly path: (from: string, to: string) => string
  /** The middle of an arrow, where its answer is written. */
  readonly mid: (from: string, to: string) => CanvasPoint
  /** Boxes and arrows on any path through a box. */
  readonly relatives: (id: string) => Relatives
  /** Boxes one step upstream and downstream of a box, in the order the arrows are listed. */
  readonly neighbours: (id: string) => Neighbours
  /** The arrows of the shortest way through these boxes in turn, in walking order; a box with no way to it is passed over. */
  readonly route: (stops: readonly string[]) => readonly FlowEdge[]
}

/** The key an arrow goes by in sets and in the DOM: `from>to`. */
export const edgeKey = (edge: Pick<FlowEdge, 'from' | 'to'>): string => `${edge.from}>${edge.to}`

/** The arrows into and out of each box, in the order they are listed. */
interface Adjacency {
  readonly into: ReadonlyMap<string, readonly FlowEdge[]>
  readonly out: ReadonlyMap<string, readonly FlowEdge[]>
}

function adjacency(nodes: readonly FlowNode[], edges: readonly FlowEdge[]): Adjacency {
  const into = new Map<string, FlowEdge[]>(nodes.map((node): [string, FlowEdge[]] => [node.id, []]))
  const out = new Map<string, FlowEdge[]>(nodes.map((node): [string, FlowEdge[]] => [node.id, []]))
  for (const edge of edges) {
    const head = into.get(edge.to)
    const tail = out.get(edge.from)
    // An arrow to a box that is not there is left out of the picture; `problems` reports it.
    if (head === undefined || tail === undefined) continue
    head.push(edge)
    tail.push(edge)
  }
  return { into, out }
}

/** The boxes in an order where every arrow points forward, and the boxes a cycle keeps out of it. */
function sortForward(nodes: readonly FlowNode[], { into, out }: Adjacency): { order: string[]; stuck: string[] } {
  const waiting = new Map(nodes.map((node): [string, number] => [node.id, into.get(node.id)?.length ?? 0]))
  const order = nodes.filter(node => waiting.get(node.id) === 0).map(node => node.id)
  // The queue grows while it is walked; a for-of over an array also visits what is pushed meanwhile.
  for (const id of order) {
    for (const edge of out.get(id) ?? []) {
      const left = (waiting.get(edge.to) ?? 0) - 1
      waiting.set(edge.to, left)
      if (left === 0) order.push(edge.to)
    }
  }
  const placed = new Set(order)
  return { order, stuck: nodes.map(node => node.id).filter(id => !placed.has(id)) }
}

/** Column of each box: the longest path from a source, with a source moved right up to the first box it feeds. */
function assignRanks(nodes: readonly FlowNode[], adj: Adjacency): Record<string, number> {
  const { order, stuck } = sortForward(nodes, adj)
  if (stuck.length > 0) throw new Error(`flow graph has a cycle through ${stuck.join(', ')}`)
  const minRank = new Map(nodes.map((node): [string, number] => [node.id, node.minRank ?? 0]))
  const rank: Record<string, number> = {}
  for (const id of order) {
    const before = (adj.into.get(id) ?? []).map(edge => rank[edge.from] ?? 0)
    rank[id] = Math.max((minRank.get(id) ?? 0) - 1, ...before) + 1
  }
  // A source sits right before the first box it feeds, not at the far left, so its arrows stay short.
  for (const node of nodes) {
    const feeds = (adj.out.get(node.id) ?? []).map(edge => rank[edge.to] ?? 0)
    if ((adj.into.get(node.id) ?? []).length === 0 && feeds.length > 0) rank[node.id] = Math.min(...feeds) - 1
  }
  return rank
}

/** Reorder each column in place to cut crossings: a few barycentre sweeps, each box going to the average row of its neighbours. */
function orderColumns(columns: string[][], adj: Adjacency): void {
  const before = (id: string): string[] => (adj.into.get(id) ?? []).map(edge => edge.from)
  const after = (id: string): string[] => (adj.out.get(id) ?? []).map(edge => edge.to)
  const row = new Map<string, number>()
  const rowOf = (id: string): number => row.get(id) ?? 0
  const number = (column: readonly string[]): void => { column.forEach((id, i) => { row.set(id, i) }) }
  columns.forEach(number)
  const sweep = (near: (id: string) => string[], order: readonly number[]): void => {
    for (const r of order) {
      const column = columns[r] ?? []
      const score = (id: string): number => {
        const others = near(id)
        return others.length === 0 ? rowOf(id) : others.reduce((sum, other) => sum + rowOf(other), 0) / others.length
      }
      column.sort((a, b) => score(a) - score(b) || rowOf(a) - rowOf(b))
      number(column)
    }
  }
  const forward = Array.from({ length: columns.length }, (_, i) => i)
  for (let pass = 0; pass < 4; pass += 1) {
    sweep(before, forward)
    sweep(after, [...forward].reverse())
  }
}

/** Corner of each box once its column is centred against the tallest one, and the canvas that holds them. */
function place(columns: readonly (readonly string[])[]): Pick<Layout, 'at' | 'width' | 'height'> {
  const ranks = columns.length
  const columnHeight = (count: number): number => count * NODE_H + (count - 1) * ROW_GAP
  const tallest = Math.max(0, ...columns.map(column => column.length))
  const inner = tallest === 0 ? 0 : columnHeight(tallest)
  const at: Record<string, CanvasPoint> = {}
  columns.forEach((column, r) => {
    const top = HEAD + (inner - columnHeight(column.length)) / 2
    column.forEach((id, i) => { at[id] = { x: PAD_X + r * (NODE_W + COLUMN_GAP), y: top + i * (NODE_H + ROW_GAP) } })
  })
  return { at, width: PAD_X * 2 + ranks * NODE_W + Math.max(0, ranks - 1) * COLUMN_GAP, height: HEAD + inner + PAD_BOTTOM }
}

/** The boxes at their fixed cells. */
function gridLayout(nodes: readonly FlowNode[]): Layout {
  const rank: Record<string, number> = {}
  const at: Record<string, CanvasPoint> = {}
  let ranks = 0
  let rows = 0
  for (const node of nodes) {
    const [column, row] = node.cell ?? [0, 0]
    rank[node.id] = column
    at[node.id] = { x: PAD_X + column * (NODE_W + COLUMN_GAP), y: HEAD + row * (NODE_H + ROW_GAP) }
    ranks = Math.max(ranks, column + 1)
    rows = Math.max(rows, row + 1)
  }
  return {
    rank, ranks, at,
    width: PAD_X * 2 + ranks * NODE_W + (ranks - 1) * COLUMN_GAP,
    height: HEAD + rows * NODE_H + (rows - 1) * ROW_GAP + PAD_BOTTOM,
  }
}

function computeLayout(nodes: readonly FlowNode[], adj: Adjacency): Layout {
  const rank = assignRanks(nodes, adj)
  const ranks = nodes.length === 0 ? 0 : Math.max(...Object.values(rank)) + 1
  const columns: string[][] = Array.from({ length: ranks }, () => [])
  for (const node of nodes) columns[rank[node.id] ?? 0]?.push(node.id)
  orderColumns(columns, adj)
  return { rank, ranks, ...place(columns) }
}

/**
 * Lay a graph out and give it its lookups: longest-path columns, a few barycentre sweeps to reduce crossings, each column centred.
 * @param nodes - the boxes.
 * @param edges - the arrows; a cycle throws.
 * @returns the graph.
 */
export function buildGraph(nodes: readonly FlowNode[], edges: readonly FlowEdge[]): FlowGraph {
  const adj = adjacency(nodes, edges)
  const layout = nodes.length > 0 && nodes.every(node => node.cell !== undefined) ? gridLayout(nodes) : computeLayout(nodes, adj)
  const byId = new Map(nodes.map((node): [string, FlowNode] => [node.id, node]))

  const spot = (id: string): CanvasPoint => {
    const found = layout.at[id]
    if (found === undefined) throw new Error(`flow graph has no box ${id}`)
    return found
  }
  const mid = (from: string, to: string): CanvasPoint => {
    const a = spot(from)
    const b = spot(to)
    return { x: (a.x + NODE_W + b.x) / 2, y: (a.y + b.y + NODE_H) / 2 }
  }
  const path = (from: string, to: string): string => {
    const a = spot(from)
    const b = spot(to)
    // An arrow to a box in the same column or further left leaves by the bottom or the top, so it never crosses its own box.
    if (b.x <= a.x) {
      const down = b.y > a.y
      const x1 = a.x + NODE_W / 2
      const y1 = down ? a.y + NODE_H : a.y
      const x2 = b.x + NODE_W / 2
      const y2 = down ? b.y : b.y + NODE_H
      const bend = (y1 + y2) / 2
      return `M${x1} ${y1} C${x1} ${bend} ${x2} ${bend} ${x2} ${y2}`
    }
    const x1 = a.x + NODE_W
    const y1 = a.y + NODE_H / 2
    const x2 = b.x
    const y2 = b.y + NODE_H / 2
    const reach = Math.max(20, (x2 - x1) * 0.45)
    return `M${x1} ${y1} C${x1 + reach} ${y1} ${x2 - reach} ${y2} ${x2} ${y2}`
  }

  const relatives = (id: string): Relatives => {
    const nodesSeen = new Set([id])
    const edgesSeen = new Set<string>()
    const walk = (next: ReadonlyMap<string, readonly FlowEdge[]>, far: (edge: FlowEdge) => string): void => {
      const queue = [id]
      for (const current of queue) {
        for (const edge of next.get(current) ?? []) {
          edgesSeen.add(edgeKey(edge))
          const other = far(edge)
          if (!nodesSeen.has(other)) { nodesSeen.add(other); queue.push(other) }
        }
      }
    }
    walk(adj.out, edge => edge.to)
    walk(adj.into, edge => edge.from)
    return { nodes: nodesSeen, edges: edgesSeen }
  }
  const neighbours = (id: string): Neighbours => ({
    before: (adj.into.get(id) ?? []).map(edge => edge.from),
    after: (adj.out.get(id) ?? []).map(edge => edge.to),
  })

  const stepRoute = (from: string, to: string): readonly FlowEdge[] => {
    const cameBy = new Map<string, FlowEdge>()
    const queue = [from]
    for (const current of queue) {
      if (current === to) break
      for (const edge of adj.out.get(current) ?? []) {
        if (edge.kind === 'pull' || edge.to === from || cameBy.has(edge.to)) continue
        cameBy.set(edge.to, edge)
        queue.push(edge.to)
      }
    }
    const steps: FlowEdge[] = []
    for (let edge = cameBy.get(to); edge !== undefined; edge = cameBy.get(edge.from)) steps.unshift(edge)
    return steps
  }
  const route = (stops: readonly string[]): readonly FlowEdge[] => {
    const [first, ...rest] = stops
    const way: FlowEdge[] = []
    let at = first ?? ''
    for (const stop of rest) {
      const steps = stepRoute(at, stop)
      // A stop with no way to it is passed over, and the walk goes on from where it stands.
      if (steps.length > 0) { way.push(...steps); at = stop }
    }
    return way
  }

  return { nodes, edges, layout, node: id => byId.get(id), spot, path, mid, relatives, neighbours, route }
}

/**
 * Check a topology for the mistakes an edit can make; `buildGraph` itself only refuses a cycle.
 * @param nodes - the boxes.
 * @param edges - the arrows.
 * @returns one sentence per mistake, empty when the graph is sound.
 */
export function problems(nodes: readonly FlowNode[], edges: readonly FlowEdge[]): string[] {
  const found: string[] = []
  const ids = new Set<string>()
  for (const node of nodes) {
    if (ids.has(node.id)) found.push(`box ${node.id} is listed twice`)
    ids.add(node.id)
  }
  const seen = new Set<string>()
  for (const edge of edges) {
    const key = edgeKey(edge)
    for (const end of [edge.from, edge.to]) if (!ids.has(end)) found.push(`arrow ${key} joins ${end}, which is not a box`)
    if (edge.from === edge.to) found.push(`arrow ${key} loops back to its own box`)
    if (seen.has(key)) found.push(`arrow ${key} is drawn twice`)
    seen.add(key)
  }

  const adj = adjacency(nodes, edges)
  const role = new Map(nodes.map((node): [string, NodeRole] => [node.id, node.role]))
  for (const node of nodes) {
    const ins = adj.into.get(node.id) ?? []
    const outs = adj.out.get(node.id) ?? []
    if (ins.length + outs.length === 0) found.push(`box ${node.id} has no arrow`)
    if (node.role !== 'cond') continue
    if (ins.length === 0) found.push(`question ${node.id} is asked by nothing`)
    if (outs.length < 2) found.push(`question ${node.id} needs at least two arrows out`)
    const answers = new Set<Branch>()
    for (const edge of outs) {
      if (edge.branch === undefined) found.push(`arrow ${edgeKey(edge)} leaves question ${node.id} with no answer`)
      else if (answers.has(edge.branch)) found.push(`question ${node.id} answers ${edge.branch} twice`)
      else answers.add(edge.branch)
    }
  }
  for (const edge of edges) {
    if (edge.branch !== undefined && role.get(edge.from) !== 'cond') found.push(`arrow ${edgeKey(edge)} carries an answer but ${edge.from} asks no question`)
  }

  const { stuck } = sortForward(nodes, adj)
  if (stuck.length > 0) found.push(`arrows form a cycle through ${stuck.join(', ')}`)
  return found
}
