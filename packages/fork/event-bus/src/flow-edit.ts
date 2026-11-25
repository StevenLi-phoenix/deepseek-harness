/**
 * Run-time changes of the notification flow and their stored history. A configuration route keeps its bundle row and
 * the change is stored over it in `route_overrides`; a run-time route is changed in place.
 */

import { applyRoutePatch, findCycle, flowResultKind, mergeRoutePatches } from './flow.ts'
import type { BusLogger } from './log.ts'
import type { EventQueue } from './queue.ts'
import { rowsOf, toRecord, type BusDomain, type BusStore } from './records.ts'
import { ROUTE_COALESCE_MS, ROUTE_MAX_PER_HOUR, type RouteSet } from './routes.ts'
import type { BusStatus } from './status.ts'
import type { FlowChange, FlowEdit, FlowEditMeta, FlowEditResult, RoutePatch, Subscription } from './types.ts'
import { FlowError, subscriptionProblem } from './validate.ts'

/** What the flow editor reads and calls. */
export interface FlowEditorDeps {
  store: BusStore
  routes: Pick<RouteSet, 'all' | 'byId' | 'configured' | 'isConfigured'>
  flushes: Pick<EventQueue, 'cancel' | 'dropPending' | 'rearm'>
  status: Pick<BusStatus, 'flowRoutes'>
  /** History entries kept; the oldest are pruned first. */
  changesKept: number
  logger: BusLogger
}

/** Applies one flow edit at a time on the storage chain and records it in `flow_changes`. */
export class FlowEditor {
  /** @param deps - storage, routes, flush timers, and the flow view. */
  constructor(private readonly deps: FlowEditorDeps) {}

  /**
   * Changes of the flow.
   * @param limit - most entries.
   * @returns the newest first.
   */
  history(limit: number): FlowChange[] {
    return rowsOf(this.deps.store.current()?.table('flow_changes')).sort((a, b) => b.at - a.at || b.id.localeCompare(a.id)).slice(0, limit) as FlowChange[]
  }

  /**
   * Apply and record one change.
   * @param edit - the change.
   * @param meta - who made it and why.
   * @returns the route as it stands, the history entry, and anything worth a second look.
   * @throws {FlowError} when the change would leave a route the bus cannot run, or a loop.
   */
  async edit(edit: FlowEdit, meta: FlowEditMeta): Promise<FlowEditResult> {
    const { store, routes } = this.deps
    return store.background.serialize(async () => {
      const domain = await store.ready
      const before = routes.byId(edit.id)
      await this.apply(domain, edit, before, meta)
      const after = routes.byId(edit.id)
      const now = Date.now()
      const changes = domain.table('flow_changes')
      // Once the history is full its size stops moving: a later stamp keeps two edits of one millisecond apart, and in order.
      const idAt = (stamp: number): string => `${String(stamp).padStart(15, '0')}-${String(changes.size).padStart(6, '0')}`
      let stamp = now
      while (changes.get(idAt(stamp)) !== undefined) stamp += 1
      const change: FlowChange = {
        id: idAt(stamp),
        at: now,
        op: edit.op,
        route: edit.id,
        ...(meta.by === undefined ? {} : { by: meta.by }),
        ...(meta.note === undefined ? {} : { note: meta.note }),
        ...(before === undefined ? {} : { before: JSON.stringify(before) }),
        ...(after === undefined ? {} : { after: JSON.stringify(after) }),
      }
      await changes.put(change.id, change)
      for (const old of this.history(Number.MAX_SAFE_INTEGER).slice(this.deps.changesKept)) await changes.delete(old.id)
      const who = meta.by === undefined ? '' : ` by ${meta.by}`
      this.deps.logger.info(`event-bus: flow ${edit.op} ${edit.id}${who}${meta.note === undefined ? '' : `: ${meta.note}`}`)
      const route = this.deps.status.flowRoutes().find(row => row.id === edit.id) ?? null
      const warnings = route?.result === 'event' && route.downstream.length === 0
        ? [`No route takes ${flowResultKind(edit.id)} yet, so its answers go to the notifier until one does.`]
        : []
      return { route, change, warnings }
    })
  }

  /** Apply one change to the stored rows; runs inside the storage chain. */
  private async apply(domain: BusDomain, edit: FlowEdit, before: Subscription | undefined, meta: FlowEditMeta): Promise<void> {
    const { routes, flushes } = this.deps
    const overrides = domain.table('route_overrides')
    const stored = domain.table('subscriptions')
    const configured = routes.isConfigured(edit.id)
    const override = overrides.get(edit.id)
    const row = stored.get(edit.id)
    const stamp = { updatedAt: Date.now(), ...(meta.by === undefined ? {} : { updatedBy: meta.by }) }
    const known = configured || row !== undefined
    if (edit.op === 'reset') {
      if (!configured) throw new FlowError('not_config', `"${edit.id}" is not a configuration route; set or remove it instead.`)
      this.assertNoCycle(routes.all().filter(route => route.id !== edit.id), routes.configured(edit.id))
      await overrides.delete(edit.id)
      flushes.rearm(domain, edit.id)
      return
    }
    if (edit.op !== 'set' && !known) throw new FlowError('not_found', `No route has id "${edit.id}"; flow_read lists them.`)
    if (edit.op === 'remove') {
      await (configured ? overrides.put(edit.id, { ...override, id: edit.id, removed: true, ...stamp }) : stored.delete(edit.id))
      await flushes.dropPending(domain, edit.id)
      return
    }
    if (edit.op === 'pause' || edit.op === 'resume') {
      const paused = edit.op === 'pause' ? { paused: true as const } : {}
      if (configured) {
        const { paused: _was, ...rest } = override ?? { id: edit.id, ...stamp }
        await overrides.put(edit.id, { ...rest, ...paused, ...stamp })
      }
      /* v8 ignore else -- an id that is not configured passed the check that it is known, so it has a row. */
      if (!configured && row !== undefined) {
        const { paused: _was, ...rest } = row
        await stored.put(edit.id, { ...rest, ...paused })
      }
      if (edit.op === 'pause') {
        flushes.cancel(edit.id)
      } else {
        flushes.rearm(domain, edit.id)
      }
      return
    }
    const original = routes.configured(edit.id)
    const base: Subscription = (original === undefined ? before : applyRoutePatch(original, (override?.patch ?? {}) as RoutePatch))
      ?? { id: edit.id, sources: [], kinds: [], subjects: [], action: 'notify', coalesceMs: ROUTE_COALESCE_MS, maxPerHour: ROUTE_MAX_PER_HOUR }
    const next = applyRoutePatch(base, edit.patch)
    const problem = subscriptionProblem(next)
    if (problem !== undefined) throw new FlowError('invalid_route', `event-bus: ${problem}`)
    if (next.sources.length === 0 && next.kinds.length === 0) {
      throw new FlowError('invalid_route', `Route "${edit.id}" needs sources or kinds; with neither it takes every event of every service.`)
    }
    this.assertNoCycle(routes.all().filter(route => route.id !== edit.id), next)
    if (configured) {
      const { removed: _removed, ...rest } = override ?? { id: edit.id, ...stamp }
      await overrides.put(edit.id, { ...rest, patch: mergeRoutePatches(override?.patch as RoutePatch | undefined, edit.patch), ...stamp })
    } else {
      const createdBy = row === undefined ? meta.by : row.createdBy
      const record = toRecord(next, createdBy === undefined ? {} : { createdBy }, row?.createdAt ?? Date.now())
      await stored.put(edit.id, row?.paused === true ? { ...record, paused: true } : record)
    }
  }

  /** Refuse a set of routes in which an answer could feed itself. */
  private assertNoCycle(others: readonly Subscription[], route: Subscription | undefined): void {
    /* v8 ignore next -- both callers pass a route. */
    const loop = findCycle(route === undefined ? others : [...others, route])
    if (loop === undefined) return
    throw new FlowError('cycle', `That change makes a loop: ${loop.join(' → ')}. An answer must not reach its own route again.`)
  }
}
