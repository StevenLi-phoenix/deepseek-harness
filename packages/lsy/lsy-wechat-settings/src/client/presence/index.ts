/**
 * Quiet-hours plugin, browser half: a Settings section ("Quiet hours", 勿扰) over this package's
 * Host route (`api/lsy.presence`). The section registers into `settings.section` like the upstream
 * pages, so it follows the settings shell's lifetime and appears after the built-in sections.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { PRESENCE_ROUTE, type PresenceAction } from '../../presence-view.ts'
import { PresenceLoader, createPresenceStore, parseAnswer } from './presence.ts'
import { PresenceSection, type PresenceInjected } from './PresenceSection.tsx'
import { de, en, es, fr, ja, pt, ru, zh } from './locales.ts'

export type { PresenceInjected, PresenceProps } from './PresenceSection.tsx'
export type { PresenceKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'lsy.presence'

/** Settings navigation position: right after the WeChat section (52). */
const SECTION_ORDER = 53

/** One request to the route; the sign-in cookie rides along. */
async function request(action?: PresenceAction) {
  // Document-relative, so a served mount keeps working.
  const init: RequestInit = action === undefined
    ? { credentials: 'same-origin', cache: 'no-store' }
    : { credentials: 'same-origin', cache: 'no-store', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) }
  const response = await fetch(PRESENCE_ROUTE, init)
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: unknown }
    throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`)
  }
  return parseAnswer(await response.json())
}

/**
 * Register the dictionaries and the Settings section over one shared store.
 * @param ctx - client root context with the slot registry and locale.
 */
export function registerPresence(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'lsy-presence: dictionaries')
  const t = ctx.locale.bind(NS)
  const store = createPresenceStore()
  const loader = new PresenceLoader(store, () => request(), action => request(action))
  // Stable functions for the registration's lifetime, so the section's polling effect never restarts on re-render.
  const injected: PresenceInjected = {
    hooks: { presence: store },
    refresh: () => { void loader.refresh() },
    act: (action) => { void loader.act(action) },
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'lsy-presence', order: SECTION_ORDER, label: () => t('nav'), locale: NS, inject: () => injected,
  }, PresenceSection))
}
