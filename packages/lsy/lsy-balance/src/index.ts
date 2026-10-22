/**
 * Balance pill plugin, node half: `GET /api/lsy.balance` answers the balance
 * or quota of every configured provider key (OpenRouter, the DeepSeek API,
 * OpenCode Go) for the browser half. Keys are resolved through the
 * credentials service and never leave the Host; the route sits under `/api`,
 * so the connection's sign-in check guards it. Answers are cached so open
 * pills and their timers cost one round of provider requests per minute.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import { BALANCE_PATH, type BalanceRouteBody, type ProviderReading } from './readings.ts'
import { DEFAULT_SOURCES, readSource, type BalanceSource } from './sources.ts'

/** Plugin configuration. */
export interface Config {
  /** Providers to query; a source whose key reference is unset is skipped. */
  sources: BalanceSource[]
  /** How long an answer is served from cache, in milliseconds. */
  cacheMs: number
  /** Deadline of one provider request, in milliseconds. */
  timeoutMs: number
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  sources: z.array(z.object({
    kind: z.union(['deepseek', 'openrouter', 'opencode-go'] as const),
    keyRef: z.string(),
    label: z.string(),
  })).default(DEFAULT_SOURCES.map(source => ({ ...source }))),
  cacheMs: z.natural().default(60_000),
  timeoutMs: z.natural().min(1000).default(15_000),
})

/** Required Host services. */
export const inject = ['credentials', 'connection']

/** A click may bypass the cache, but not more often than this. */
const MIN_FRESH_MS = 10_000

/** The slice of the connection service this plugin uses. */
interface BalanceConnection {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly 'GET'[]
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/**
 * Register the balance route.
 * @param ctx - Host context with the credentials and connection services.
 * @param config - resolved configuration.
 */
export function apply(ctx: Context, config: Config): void {
  let cached: { at: number; readings: readonly ProviderReading[] } | undefined
  let inFlight: Promise<readonly ProviderReading[]> | undefined
  /** Last logged presence of each key reference, so a missing key is logged once, not every minute. */
  const present = new Map<string, boolean>()

  const readAll = async (): Promise<readonly ProviderReading[]> => {
    const readings = await Promise.all(config.sources.map(async (source): Promise<ProviderReading | undefined> => {
      let key: string | undefined
      try {
        key = (await ctx.credentials.resolve(source.keyRef as CredentialRef))?.value
      } catch {
        return { source: source.kind, label: source.label, status: 'failed', reason: 'credential unavailable' }
      }
      if (present.get(source.keyRef) !== (key !== undefined)) {
        present.set(source.keyRef, key !== undefined)
        if (key === undefined) ctx.logger.info(`lsy-balance: ${source.keyRef} is not set; ${source.label} is not shown`)
      }
      if (key === undefined) return undefined
      const reading = await readSource(source, key, { timeoutMs: config.timeoutMs })
      if (reading.status === 'failed') ctx.logger.warn(`lsy-balance: ${source.label} balance read failed: ${reading.reason}`)
      return reading
    }))
    return readings.filter(reading => reading !== undefined)
  }

  const read = (fresh: boolean): Promise<readonly ProviderReading[]> => {
    const age = cached === undefined ? Infinity : Date.now() - cached.at
    if (cached !== undefined && age < (fresh ? MIN_FRESH_MS : config.cacheMs)) return Promise.resolve(cached.readings)
    inFlight ??= readAll()
      .then((readings) => { cached = { at: Date.now(), readings }; return readings })
      .finally(() => { inFlight = undefined })
    return inFlight
  }

  const connection = Reflect.get(ctx, 'connection') as BalanceConnection
  ctx.effect(() => connection.fetch.register({
    path: BALANCE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const fresh = new URL(request.url).searchParams.get('fresh') === '1'
      const body: BalanceRouteBody = { readings: await read(fresh) }
      return Response.json(body, { headers: { 'cache-control': 'no-store' } })
    },
  }), 'lsy-balance: /api/lsy.balance')
}
