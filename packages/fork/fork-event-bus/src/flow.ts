/**
 * The notification flow as data: which routes take which events, and where the answer of each goes. A route's answer can become an
 * event another route takes, so routes chain into a graph the agent can read and change at run time. Pure: no storage, no Host.
 */
import { matchesSubscription } from './match.ts'
import type { RoutePatch, RouteResult, Subscription } from './types.ts'

/** Source of the events the bus publishes for a route whose answer goes on to other routes. No sensor or ingest token can publish it. */
export const FLOW_SOURCE = 'flow'

/** Where a route's answer can go. */
export const ROUTE_RESULTS: readonly RouteResult[] = ['notify', 'urgent', 'main', 'quiet', 'event']

/**
 * The event kind that carries a route's answer.
 * @param id - the route.
 * @returns the kind, e.g. `flow.ci.result`.
 */
export const flowResultKind = (id: string): string => `${FLOW_SOURCE}.${id}.result`

/**
 * Where a `session` route's answer goes.
 * @param route - the route.
 * @returns its explicit `result`, `quiet` for a `quietResult` row, otherwise `notify`.
 */
export function resultOf(route: Subscription): RouteResult {
  return route.session?.result ?? (route.session?.quietResult === true ? 'quiet' : 'notify')
}

/**
 * The routes that take a route's answer. Subjects are left out: an answer's subject is known only at run time, so the graph counts
 * every route the answer could reach.
 * @param route - the route.
 * @param routes - every route that can take events.
 * @returns ids of the routes downstream; empty unless its answer goes on as an event.
 */
export function downstreamOf(route: Subscription, routes: readonly Subscription[]): string[] {
  if (route.action !== 'session' || resultOf(route) !== 'event') return []
  const probe = { source: FLOW_SOURCE, kind: flowResultKind(route.id), key: '-', subject: '-', title: '-' }
  return routes.filter(other => matchesSubscription({ ...other, subjects: [] }, probe)).map(other => other.id)
}

/**
 * Find a loop in the routes, so an answer can never feed itself.
 * @param routes - every route that can take events.
 * @returns the ids around one loop, or undefined when there is none.
 */
export function findCycle(routes: readonly Subscription[]): string[] | undefined {
  const next = new Map(routes.map(route => [route.id, downstreamOf(route, routes)]))
  const done = new Set<string>()
  const visit = (id: string, path: readonly string[]): string[] | undefined => {
    const at = path.indexOf(id)
    if (at !== -1) return [...path.slice(at), id]
    if (done.has(id)) return undefined
    for (const target of next.get(id) ?? []) {
      const loop = visit(target, [...path, id])
      if (loop !== undefined) return loop
    }
    done.add(id)
    return undefined
  }
  for (const route of routes) {
    const loop = visit(route.id, [])
    if (loop !== undefined) return loop
  }
  return undefined
}

/**
 * Lay a change over a route. Selector lists and limits replace; Session settings merge field by field, and a `notify` route keeps none.
 * @param route - the route as it stands.
 * @param patch - the fields to change.
 * @returns the changed route; `route` is left as it is.
 */
export function applyRoutePatch(route: Subscription, patch: RoutePatch): Subscription {
  const { session, ...fields } = patch
  const merged = { ...route, ...fields }
  if (merged.action === 'notify') {
    const { session: _dropped, ...rest } = merged
    return rest
  }
  return session === undefined ? merged : { ...merged, session: { ...route.session, ...session } as Subscription['session'] & {} }
}

/**
 * Lay a later change over an earlier one, so the stored patch stays the sum of every change.
 * @param earlier - the stored patch, if any.
 * @param later - the new change.
 * @returns the sum.
 */
export function mergeRoutePatches(earlier: RoutePatch | undefined, later: RoutePatch): RoutePatch {
  if (earlier === undefined) return later
  const session = earlier.session === undefined && later.session === undefined ? undefined : { ...earlier.session, ...later.session }
  return { ...earlier, ...later, ...(session === undefined ? {} : { session }) }
}
