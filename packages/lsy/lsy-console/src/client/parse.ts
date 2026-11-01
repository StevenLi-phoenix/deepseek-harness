/**
 * Outer-shape checks of the Host answers. The Host half of this package wrote the bodies, so their fields are this
 * package's own contract.
 */

import type { AgentsView, OverviewView, SubscriptionsView } from '../views.ts'

function fields(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
}

/**
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
 * @param body - the parsed JSON body.
 * @returns the subscriptions view.
 * @throws when the body is not a subscriptions answer.
 */
export function parseSubscriptions(body: unknown): SubscriptionsView {
  const { subscriptions, schedules, defaults, checkedAt } = fields(body)
  if (typeof checkedAt !== 'number' || typeof defaults !== 'object' || defaults === null) throw new Error('unexpected subscriptions answer')
  for (const list of [subscriptions, schedules]) if (list !== null && !Array.isArray(list)) throw new Error('unexpected subscriptions answer')
  return body as SubscriptionsView
}

/**
 * @param body - the parsed JSON body.
 * @returns the Claude Code and voice view.
 * @throws when the body is not an agents answer.
 */
export function parseAgents(body: unknown): AgentsView {
  const { cc, voice, checkedAt } = fields(body)
  if (typeof checkedAt !== 'number' || cc === undefined || voice === undefined) throw new Error('unexpected agents answer')
  return body as AgentsView
}
