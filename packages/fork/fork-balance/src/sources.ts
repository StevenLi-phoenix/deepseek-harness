/**
 * Host-side balance queries for API-key providers. Keys never leave the Host:
 * each query sends its key to the provider's own origin and returns a reading
 * without it. Failure reasons are fixed phrases, never a response body or URL.
 */

import type { ProviderReading, QuotaWindow, WalletLine } from './readings.ts'

/** Providers with a balance or quota endpoint. */
export type BalanceSourceKind = 'deepseek' | 'openrouter' | 'opencode-go'

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
  { kind: 'openrouter', keyRef: 'OPENROUTER_API_KEY', label: 'OpenRouter' },
  { kind: 'deepseek', keyRef: 'DEEPSEEK_API_KEY', label: 'DeepSeek API' },
  { kind: 'opencode-go', keyRef: 'OPENCODE_GO_API_KEY', label: 'OpenCode Go' },
]

/** Transport and deadline of one query. */
export interface ReadOptions {
  fetch?: typeof fetch
  timeoutMs: number
}

const ENDPOINT: Record<BalanceSourceKind, string> = {
  'deepseek': 'https://api.deepseek.com/user/balance',
  'openrouter': 'https://openrouter.ai/api/v1/key',
  'opencode-go': 'https://opencode.ai/inference/go/v1/usage',
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

/** `{ data: { limit, limit_remaining, usage, ... } }` */
function parseOpenRouter(body: unknown): { remaining: number | null; limit: number | null; used: number } {
  const data = isRecord(body) ? body['data'] : undefined
  if (!isRecord(data)) throw new ShapeError()
  return { remaining: nullableFinite(data['limit_remaining']), limit: nullableFinite(data['limit']), used: finite(data['usage']) }
}

/** `{ usage: { <window>: { status, percent, resetsAt } } }` */
function parseOpencode(body: unknown): QuotaWindow[] {
  const usage = isRecord(body) ? body['usage'] : undefined
  if (!isRecord(usage)) throw new ShapeError()
  return Object.entries(usage).map(([name, window]) => {
    if (!isRecord(window)) throw new ShapeError()
    const resetsAt = window['resetsAt']
    return { name, percent: finite(window['percent']), resetsAt: typeof resetsAt === 'string' ? resetsAt : null }
  })
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
      headers: { accept: 'application/json', authorization: `Bearer ${key}`, ...source.kind === 'opencode-go' ? { 'x-api-key': key } : {} },
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
      case 'openrouter':
        return { ...base, status: 'ready', kind: 'credit', currency: 'USD', ...parseOpenRouter(body) }
      case 'opencode-go':
        return { ...base, status: 'ready', kind: 'quota', windows: parseOpencode(body) }
    }
  } catch (error) {
    if (!(error instanceof ShapeError)) throw error
    return { ...base, status: 'failed', reason: 'unexpected response' }
  }
}
