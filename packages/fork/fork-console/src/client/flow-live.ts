/**
 * The picture is generated from the running flow. `flow-graph.ts` places the boxes and draws what no route carries; every route's arrows
 * come from here, from what it really takes and where its answer really goes, so the page never shows a way that is not there.
 * Pure: boxes and routes in, a graph out.
 */

import type { FlowRoute } from '../views.ts'
import { buildGraph, type FlowEdge, type FlowGraph, type FlowNode } from './flow-model.ts'

/** The first free row under the drawing, where boxes of new routes go. */
const FIRST_ROW = 14
/** Column of a route's box: after its sources, one further per route before it, still left of the owner's exit. */
const FIRST_COLUMN = 1
const LAST_COLUMN = 3

/**
 * What about the routes shapes the picture, so the page lays it out again only when that changes.
 * @param routes - every route.
 * @returns a string that changes with them.
 */
export function routeSignature(routes: readonly FlowRoute[]): string {
  return JSON.stringify(routes.map(route => [route.id, route.sources, route.result, route.downstream, route.removed]))
}

const globMatch = (pattern: string, value: string): boolean =>
  new RegExp(`^${pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(value)

/**
 * Lay the routes the agent has changed over the drawing.
 * @param base - the drawing.
 * @param routes - every route as it runs now.
 * @returns the drawing itself when no route was touched, otherwise a new graph.
 */
export function liveGraph(base: FlowGraph, routes: readonly FlowRoute[]): FlowGraph {
  if (routes.length === 0) return base

  const byId = new Map(routes.map(route => [route.id, route]))
  const owner = new Map<string, FlowNode>()
  for (const node of base.nodes) for (const id of node.tracks?.subscriptions ?? []) owner.set(id, node)

  const shown = new Set(routes.map(route => route.id))

  const depth = new Map<string, number>()
  const depthOf = (id: string): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    depth.set(id, 0)
    const before = routes.filter(route => route.downstream.includes(id)).map(route => depthOf(route.id) + 1)
    const value = Math.max(0, ...before)
    depth.set(id, value)
    return value
  }

  let row = FIRST_ROW
  const added: FlowNode[] = []
  const boxOf = new Map<string, string>()
  const redrawn = new Set<string>()
  for (const id of shown) {
    const route = byId.get(id)
    /* v8 ignore next -- every shown id is a route's. */
    if (route === undefined) continue
    const drawn = owner.get(id)
    if (drawn !== undefined) {
      boxOf.set(id, drawn.id)
      redrawn.add(drawn.id)
      continue
    }
    const box = `route:${id}`
    boxOf.set(id, box)
    redrawn.add(box)
    added.push({
      id: box,
      route: id,
      title: id,
      role: route.result === 'direct' ? 'core' : 'agent',
      cell: [Math.min(LAST_COLUMN, FIRST_COLUMN + depthOf(id)), row],
      tracks: { subscriptions: [id] },
      via: `route ${id}`,
    })
    row += 1
  }

  const nodes: FlowNode[] = [
    ...base.nodes.map((node) => {
      if (!redrawn.has(node.id)) return node
      const { gap: _gap, ...rest } = node
      /* v8 ignore next -- every redrawn box has tracks. */
      const id = node.tracks?.subscriptions?.[0] ?? node.id
      return { ...rest, wired: 'live' as const, via: `route ${id}`, route: id }
    }),
    ...added,
  ]

  // Arrows the drawing guessed for a route go; those it carries for something else stay.
  const sourceBoxes = new Set(base.nodes.filter(node => node.role === 'source').map(node => node.id))
  const edges: FlowEdge[] = base.edges.filter((edge) => {
    if (redrawn.has(edge.from) && (edge.kind === 'event' || edge.kind === 'send')) return false
    return !(redrawn.has(edge.to) && edge.kind === 'event' && sourceBoxes.has(edge.from))
  })

  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>()
    const walk = (at: string): boolean => {
      if (at === to) return true
      if (seen.has(at)) return false
      seen.add(at)
      return edges.some(edge => edge.from === at && walk(edge.to))
    }
    return walk(from)
  }
  const present = new Set(nodes.map(node => node.id))
  const connect = (from: string, to: string): void => {
    // The bus refuses a loop among routes, but an arrow of the drawing can still close one: the picture stays drawable without it.
    if (!present.has(from) || !present.has(to) || from === to) return
    if (edges.some(edge => edge.from === from && edge.to === to) || reaches(to, from)) return
    edges.push({ from, to, kind: 'event' })
  }

  for (const id of shown) {
    const route = byId.get(id)
    const box = boxOf.get(id)
    if (route === undefined || box === undefined || route.removed) continue
    for (const node of base.nodes) {
      if (node.role !== 'source') continue
      if ((node.tracks?.sources ?? []).some(source => route.sources.some(pattern => globMatch(pattern, source)))) connect(node.id, box)
    }
    // fork-wechat hands every note for the owner to the main agent (`chat.notes: turn`), so a note reaches WeChat through it.
    if (route.result === 'direct' || route.result === 'notify' || route.result === 'urgent' || route.result === 'main') connect(box, 'main')
    if (route.result === 'event') {
      for (const next of route.downstream) {
        const target = boxOf.get(next)
        if (target !== undefined) connect(box, target)
      }
    }
  }
  return buildGraph(nodes, edges)
}
