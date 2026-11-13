/**
 * Outer-shape checks of the Host answers. The Host half of this package wrote the bodies, so their fields are this
 * package's own contract.
 */

import type { AgentsView, FlowActivityView, OverviewView, SubscriptionsView } from '../views.ts'

function fields(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
}

/**
 * Validate an overview answer.
 * @param body - the parsed JSON body.
 * @returns the overview.
 * @throws when the body is not an overview answer.
 */
export function parseOverview(body: unknown): OverviewView {
  const { cards, checkedAt } = fields(body)
  if (!Array.isArray(cards) || typeof checkedAt !== 'number') throw new Error('unexpected overview answer')
  return body as OverviewView
}

/**
 * Validate a flow activity answer; `routes` and `changes` default to empty lists.
 * @param body - the parsed JSON body.
 * @returns the message flow's activity.
 * @throws when the body is not an activity answer.
 */
export function parseFlowActivity(body: unknown): FlowActivityView {
  const { windows, recent, checkedAt } = fields(body)
  if (typeof windows !== 'object' || windows === null || !Array.isArray(recent) || typeof checkedAt !== 'number') {
    throw new Error('unexpected flow answer')
  }
  // A Host from before run-time routes answers without them.
  const view = body as Partial<FlowActivityView> & Omit<FlowActivityView, 'routes' | 'changes'>
  return { ...view, routes: view.routes ?? [], changes: view.changes ?? [] }
}

/**
 * Validate a subscriptions answer; `archive` defaults to null.
 * @param body - the parsed JSON body.
 * @returns the subscriptions view.
 * @throws when the body is not a subscriptions answer.
 */
export function parseSubscriptions(body: unknown): SubscriptionsView {
  const { subscriptions, schedules, defaults, checkedAt, archive } = fields(body)
  if (typeof checkedAt !== 'number' || typeof defaults !== 'object' || defaults === null) throw new Error('unexpected subscriptions answer')
  for (const list of [subscriptions, schedules]) if (list !== null && !Array.isArray(list)) throw new Error('unexpected subscriptions answer')
  if (archive !== undefined && archive !== null && typeof archive !== 'object') throw new Error('unexpected subscriptions answer')
  // A Host from before the auto-archive answers without the field.
  return archive === undefined ? { ...(body as SubscriptionsView), archive: null } : body as SubscriptionsView
}

/**
 * Validate an agents answer.
 * @param body - the parsed JSON body.
 * @returns the Claude Code and voice view.
 * @throws when the body is not an agents answer.
 */
export function parseAgents(body: unknown): AgentsView {
  const { cc, voice, checkedAt } = fields(body)
  if (typeof checkedAt !== 'number' || cc === undefined || voice === undefined) throw new Error('unexpected agents answer')
  return body as AgentsView
}
