/**
 * Host-side balance queries for API-key providers. Keys never leave the Host:
 * each query sends its key to the provider's own origin and returns a reading
 * without it. Failure reasons are fixed phrases, never a response body or URL.
 */

import type { KeyLimit, ProviderReading, QuotaWindow, WalletLine } from './readings.ts'

/** Providers with a balance or quota endpoint. */
export type BalanceSourceKind = 'deepseek' | 'opencode-go'

/** One configured balance source. */
export interface BalanceSource {
  /** Which provider endpoint to query. */
  kind: BalanceSourceKind
  /** Credential reference holding the provider key (the Models page's `apiKeyEnv`). */
  keyRef: string
  /** Name shown on the provider's row. */
  label: string
}

/** Sources queried when the configuration names none; a source whose key is unset is skipped. */
export const DEFAULT_SOURCES: readonly BalanceSource[] = [
  { kind: 'deepseek', keyRef: 'DEEPSEEK_API_KEY', label: 'DeepSeek API' },
  // OpenCode Go is read through llmgateway with the gateway key DSH's model route uses.
  { kind: 'opencode-go', keyRef: 'LLMGW_DSH_API_KEY', label: 'OpenCode Go' },
]

/** Transport and deadline of one query. */
export interface ReadOptions {
  fetch?: typeof fetch
  timeoutMs: number
}

const ENDPOINT: Record<BalanceSourceKind, string> = {
  'deepseek': 'https://api.deepseek.com/user/balance',
  'opencode-go': 'https://api.lishuyu.app/llm/api/upstream/opencode-go/quota',
}

/** A response that does not have the documented shape. */
class ShapeError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decimal(value: unknown): string {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) throw new ShapeError()
  return value
}

function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ShapeError()
  return value
}

function nullableFinite(value: unknown): number | null {
  return value === null || value === undefined ? null : finite(value)
}

/** `{ is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }` */
function parseDeepSeek(body: unknown): WalletLine[] {
  if (!isRecord(body) || !Array.isArray(body['balance_infos'])) throw new ShapeError()
  return body['balance_infos'].map((row: unknown) => {
    if (!isRecord(row) || (row['currency'] !== 'CNY' && row['currency'] !== 'USD')) throw new ShapeError()
    return {
      currency: row['currency'],
      total: decimal(row['total_balance']),
      toppedUp: decimal(row['topped_up_balance']),
      granted: decimal(row['granted_balance']),
    }
  })
}

/**
 * `{ usage: { <window>: { status, percent, resetsAt } }, key?: { limit_usd, period: { kind }, spend_usd, remaining_usd } }`:
 * the window fields are OpenCode's own, the `key` block is the gateway's.
 */
function parseOpencode(body: unknown): { windows: QuotaWindow[]; key?: KeyLimit } {
  if (!isRecord(body)) throw new ShapeError()
  const usage = body['usage']
  if (!isRecord(usage)) throw new ShapeError()
  const windows = Object.entries(usage).map(([name, window]) => {
    if (!isRecord(window)) throw new ShapeError()
    const resetsAt = window['resetsAt']
    return { name, percent: finite(window['percent']), resetsAt: typeof resetsAt === 'string' ? resetsAt : null }
  })
  const key = body['key']
  if (key === undefined || key === null) return { windows }
  if (!isRecord(key)) throw new ShapeError()
  const period = key['period']
  const kind = isRecord(period) ? period['kind'] : undefined
  if (typeof kind !== 'string') throw new ShapeError()
  return {
    windows,
    key: { period: kind, limitUsd: nullableFinite(key['limit_usd']), spendUsd: finite(key['spend_usd']), remainingUsd: nullableFinite(key['remaining_usd']) },
  }
}

/**
 * Query one provider with its key.
 * @param source - the configured source.
 * @param key - the provider key, sent only to that provider's endpoint.
 * @param options - transport and deadline.
 * @returns a ready reading, or a failed one with a fixed reason.
 */
export async function readSource(source: BalanceSource, key: string, options: ReadOptions): Promise<ProviderReading> {
  const base = { source: source.kind, label: source.label }
  let body: unknown
  try {
    const response = await (options.fetch ?? fetch)(ENDPOINT[source.kind], {
      headers: { accept: 'application/json', authorization: `Bearer ${key}` },
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs),
    })
    if (!response.ok) {
      await response.body?.cancel()
      return { ...base, status: 'failed', reason: `HTTP ${response.status}` }
    }
    body = await response.json()
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    return { ...base, status: 'failed', reason: timedOut ? 'timed out' : error instanceof SyntaxError ? 'unexpected response' : 'request failed' }
  }
  try {
    switch (source.kind) {
      case 'deepseek':
        return { ...base, status: 'ready', kind: 'wallets', wallets: parseDeepSeek(body) }
      case 'opencode-go':
        return { ...base, status: 'ready', kind: 'quota', ...parseOpencode(body) }
    }
  } catch (error) {
    if (!(error instanceof ShapeError)) throw error
    return { ...base, status: 'failed', reason: 'unexpected response' }
  }
}
