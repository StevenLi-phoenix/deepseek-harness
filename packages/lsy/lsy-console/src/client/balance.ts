/**
 * The "model route and balance" card is the browser's: the balance route (`api/lsy.balance`, lsy-balance's) already resolves
 * the provider keys on the Host, so this section reads its readings and summarizes them, and links to the Account page where
 * the full card lives.
 */

import { requestJson } from './resource.ts'
import type { ServiceCard } from '../views.ts'

/** The slice of a balance reading this summary uses. */
export interface BalanceSummary {
  readonly ready: number
  readonly failed: number
  /** Highest share used across quota windows, 0-100, or null without any. */
  readonly highest: number | null
}

/** Route lsy-balance registers, document-relative. */
export const BALANCE_ROUTE = 'api/lsy.balance'

/**
 * Check a balance answer and summarize it.
 * @param body - the parsed JSON body.
 * @returns the counts.
 * @throws when the body is not a balance answer.
 */
export function parseBalance(body: unknown): BalanceSummary {
  const readings = typeof body === 'object' && body !== null ? (body as { readings?: unknown }).readings : undefined
  if (!Array.isArray(readings)) throw new Error('unexpected balance answer')
  let ready = 0
  let failed = 0
  let highest: number | null = null
  for (const reading of readings as { status?: unknown; windows?: unknown }[]) {
    if (reading.status === 'failed') failed += 1
    else if (reading.status === 'ready') ready += 1
    if (Array.isArray(reading.windows)) {
      for (const window of reading.windows as { percent?: unknown }[]) {
        if (typeof window.percent === 'number') highest = Math.max(highest ?? 0, window.percent)
      }
    }
  }
  return { ready, failed, highest }
}

/** Read the balance route. */
export function readBalance(): Promise<BalanceSummary> {
  return requestJson<unknown>(BALANCE_ROUTE).then(parseBalance)
}

/**
 * The overview card for a balance summary.
 * @param summary - counts, or null before the first answer.
 * @param failed - the read itself failed.
 * @returns the card.
 */
export function balanceCard(summary: BalanceSummary | null, failed: boolean): ServiceCard {
  if (summary === null) return { id: 'llm', tone: failed ? 'down' : 'off', state: failed ? 'error' : 'loading', facts: {} }
  const facts = { ready: summary.ready, failed: summary.failed, percent: summary.highest === null ? null : Math.round(summary.highest) }
  if (summary.failed > 0) return { id: 'llm', tone: 'warn', state: 'warn', facts }
  if (summary.ready === 0) return { id: 'llm', tone: 'off', state: 'off', facts }
  return { id: 'llm', tone: 'ok', state: 'ok', facts }
}
