/**
 * Balance pill plugin, browser half: one `conversation.composer.dock` entry
 * after the activity and usage pills, showing the DeepSeek account balance
 * the Host reads for the Account settings page (`account.getBalance`).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge (the account namespace) into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ui-conversation SlotMap merge (the composer dock).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { AccountClientMetadata } from '@deepseek-ai/dsh-deepseek-account/types'
import { BalanceLoader, createBalanceStore } from './balance.ts'
import { BalancePill, type BalancePillInjected } from './BalancePill.tsx'
import { en, zh } from './locales.ts'

export type { BalancePillInjected, BalancePillProps } from './BalancePill.tsx'
export type { BalanceKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'lsy.balance'

/** Required services: the dock's slot registry, locale, and the account Remote. */
export const inject = ['slots', 'locale', 'remote', 'remote.account']

/**
 * Register the dictionaries and the dock entry over one shared store, so every
 * open composer shows the same reading from one request.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'lsy-balance: dictionaries')
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
  })
  const injected = (): BalancePillInjected => ({
    hooks: { balance: store },
    refresh: (maxAgeMs) => { void loader.refresh(maxAgeMs) },
  })
  // After ui-chat's activity (0) and usage (1) pills.
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock', id: 'balance', order: 2, locale: NS, inject: injected,
  }, BalancePill))
}
