/**
 * The routes as they stand at run time: the configuration rows with their stored overrides laid over them, then the
 * run-time subscriptions, in matching order.
 */

import { applyRoutePatch } from './flow.ts'
import { rowsOf, toSubscription, type BusDomain } from './records.ts'
import type { SubscriptionRecord } from './storage.ts'
import type { RoutePatch, Subscription } from './types.ts'

/** Coalesce window of a route the configuration or a flow edit does not set. */
export const ROUTE_COALESCE_MS = 60_000
/** Hourly batch limit of a route the configuration or a flow edit does not set. */
export const ROUTE_MAX_PER_HOUR = 12

/** Reads the configuration routes and the stored rows; it writes nothing. */
export class RouteSet {
  private readonly byConfigId: ReadonlyMap<string, Subscription>

  /**
   * @param config - the configuration's subscriptions, in matching order.
   * @param current - the open storage domain, or undefined before it opens.
   */
  constructor(private readonly config: readonly Subscription[], private readonly current: () => BusDomain | undefined) {
    this.byConfigId = new Map(config.map(subscription => [subscription.id, subscription]))
  }

  /**
   * Number of configuration rows, whether or not a flow edit took one out.
   * @returns the row count.
   */
  configCount(): number {
    return this.config.length
  }

  /**
   * Whether the configuration owns an id.
   * @param id - route id.
   * @returns true for a configuration row's id.
   */
  isConfigured(id: string): boolean {
    return this.byConfigId.has(id)
  }

  /**
   * A configuration row as the configuration writes it, without its run-time change.
   * @param id - route id.
   * @returns the row, or undefined for an id the configuration does not own.
   */
  configured(id: string): Subscription | undefined {
    return this.byConfigId.get(id)
  }

  /**
   * Stored run-time subscriptions.
   * @returns the rows, oldest first; none before the storage domain opens.
   */
  stored(): SubscriptionRecord[] {
    return rowsOf(this.current()?.table('subscriptions')).sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * Ids of paused subscriptions of either origin.
   * @returns the paused ids.
   */
  pausedIds(): ReadonlySet<string> {
    return new Set([
      ...this.stored().filter(record => record.paused === true).map(record => record.id),
      ...rowsOf(this.current()?.table('route_overrides')).filter(row => row.paused === true).map(row => row.id),
    ])
  }

  /**
   * Configuration routes as they stand at run time.
   * @returns the routes not taken out, each with its run-time change laid over it.
   */
  configRoutes(): Subscription[] {
    return this.config.flatMap((route) => {
      const effective = this.effective(route)
      return effective === undefined ? [] : [effective]
    })
  }

  /**
   * Configuration and run-time subscriptions.
   * @returns every route that takes events, in matching order.
   */
  all(): Subscription[] {
    return [...this.configRoutes(), ...this.stored().map(toSubscription)]
  }

  /**
   * One subscription by id from either origin.
   * @param id - route id.
   * @returns the route as it stands, or undefined when no route has the id or it is taken out.
   */
  byId(id: string): Subscription | undefined {
    const configured = this.byConfigId.get(id)
    if (configured !== undefined) return this.effective(configured)
    const stored = this.current()?.table('subscriptions').get(id)
    return stored === undefined ? undefined : toSubscription(stored)
  }

  /** A configuration route with its run-time change laid over it; undefined once it is taken out. */
  private effective(route: Subscription): Subscription | undefined {
    const override = this.current()?.table('route_overrides').get(route.id)
    if (override?.removed === true) return undefined
    return override?.patch === undefined ? route : applyRoutePatch(route, override.patch as RoutePatch)
  }
}
