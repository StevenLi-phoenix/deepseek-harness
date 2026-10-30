/**
 * Provider balances plugin, browser half: one entry in the Account settings
 * page's `settings.account.balances` area, under the DeepSeek account card,
 * listing the provider-key readings of this package's Host route
 * (`api/lsy.balance`). The account balance (`account.getBalance`) is read
 * only to leave out a DeepSeek API key that belongs to the same account.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge (the account namespace) into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the Account page's SlotMap merge (the balances area).
import type {} from '@deepseek-ai/dsh-client-ui-settings-account/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { AccountClientMetadata } from '@deepseek-ai/dsh-deepseek-account/types'
import { BALANCE_ROUTE, type BalanceRouteBody, type ProviderReading } from '../readings.ts'
import { BalanceLoader, createBalanceStore } from './balance.ts'
import { ProviderBalances, type ProviderBalancesInjected } from './ProviderBalances.tsx'
import { de, en, es, fr, ja, pt, ru, zh } from './locales.ts'

export type { ProviderBalancesInjected, ProviderBalancesProps } from './ProviderBalances.tsx'
export type { BalanceKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'lsy.balance'

/** Required services: the slot registry, locale, and the account Remote. */
export const inject = ['slots', 'locale', 'remote', 'remote.account']

/**
 * Register the dictionaries and the Account page entry over one shared store.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'lsy-balance: dictionaries')
  const store = createBalanceStore()
  const loader = new BalanceLoader(store, async () => {
    const version = process.env.DSH_CLIENT_VERSION
    if (version === undefined || version === '') throw new Error('this client build carries no DSH_CLIENT_VERSION')
    const client: AccountClientMetadata = {
      version,
      locale: ctx.locale.getSnapshot().active,
      // Date.getTimezoneOffset reports minutes west of UTC; Platform wants seconds east.
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    }
    const result = await ctx.remote.account.getBalance(client)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }, async (fresh): Promise<readonly ProviderReading[]> => {
    // Document-relative, so a served mount keeps working; the sign-in cookie rides along.
    const response = await fetch(fresh ? `${BALANCE_ROUTE}?fresh=1` : BALANCE_ROUTE, { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body: unknown = await response.json()
    const readings = typeof body === 'object' && body !== null ? (body as Partial<BalanceRouteBody>).readings : undefined
    if (!Array.isArray(readings)) throw new Error('unexpected balance route answer')
    // The Host half of this package wrote the body; its shape is this package's own contract.
    return readings as readonly ProviderReading[]
  })
  const injected = (): ProviderBalancesInjected => ({
    hooks: { balance: store },
    refresh: (maxAgeMs) => { void loader.refresh(maxAgeMs) },
  })
  ctx.slots.inject('settings.account.balances', () => ctx.slots.register({
    name: 'settings.account.balances', id: 'lsy-provider-balances', order: 0, locale: NS, inject: injected,
  }, ProviderBalances))
}
