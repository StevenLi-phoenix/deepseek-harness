/**
 * Bilibili account plugin, browser half: a Settings section ("Bilibili
 * account", B站账号) over this package's Host route (`api/bili`). The section
 * registers into `settings.section` like the upstream pages, so it follows the
 * settings shell's lifetime and appears after the built-in sections.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { BILI_ROUTE, type BiliAction, type BiliView } from '../view.ts'
import { BiliLoader, createBiliStore, parseView } from './bili.ts'
import { BiliAccountSection, type BiliAccountInjected } from './BiliAccount.tsx'
import { de, en, es, fr, ja, pt, ru, zh } from './locales.ts'

export type { BiliAccountInjected, BiliAccountProps } from './BiliAccount.tsx'
export type { BiliKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'bili'

/** Settings navigation position: after System status. */
const SECTION_ORDER = 45

/** Required services: the slot registry and locale. */
export const inject = ['slots', 'locale']

/** One request to the route; the sign-in cookie rides along. */
async function request(init?: RequestInit): Promise<BiliView> {
  // Document-relative, so a served mount keeps working.
  const response = await fetch(BILI_ROUTE, { credentials: 'same-origin', cache: 'no-store', ...init })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: unknown }
    throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`)
  }
  return parseView(await response.json())
}

/**
 * Register the dictionaries and the Settings section over one shared store.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'bili: dictionaries')
  const t = ctx.locale.bind(NS)
  const store = createBiliStore()
  const loader = new BiliLoader(store, () => request(), action => request({
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action),
  }))
  // Stable functions for the registration's lifetime, so the section's polling effect never restarts on re-render.
  const refresh = (): void => { void loader.refresh() }
  const act = (action: BiliAction): void => { void loader.act(action) }
  const injected = (): BiliAccountInjected => ({ hooks: { bili: store }, refresh, act })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'bili', order: SECTION_ORDER, label: () => t('nav'), locale: NS, inject: injected,
  }, BiliAccountSection))
}
