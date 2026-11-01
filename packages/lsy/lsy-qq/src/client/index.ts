/**
 * QQ plugin, browser half: a Settings section ("QQ") over this package's Host route (`api/lsy.qq`). It shows whether
 * the QQ observer is connected, NapCat's login state, and, when a scan is needed, the login QR code, so a kicked-off
 * QQ account is recovered from the page with a phone. The section registers into `settings.section` like the
 * upstream pages, so it follows the settings shell's lifetime and appears after the built-in sections.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { QQ_REFRESH_ROUTE, QQ_ROUTE } from '../panel-view.ts'
import { QqLoader, createQqStore, parsePanel } from './qq.ts'
import { QqLoginSection, type QqLoginInjected } from './QqLogin.tsx'
import { de, en, es, fr, ja, pt, ru, zh } from './locales.ts'

export type { QqLoginInjected, QqLoginProps } from './QqLogin.tsx'
export type { QqKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'lsy.qq'

/** Settings navigation position: just after System status. */
const SECTION_ORDER = 45

/** Required services: the slot registry and locale. */
export const inject = ['slots', 'locale']

/**
 * Register the dictionaries and the Settings section over one shared store.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'lsy-qq: dictionaries')
  const t = ctx.locale.bind(NS)
  const store = createQqStore()
  const loader = new QqLoader(
    store,
    async () => {
      // Document-relative, so a served mount keeps working; the sign-in cookie rides along.
      const response = await fetch(QQ_ROUTE, { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return parsePanel(await response.json())
    },
    async () => {
      const response = await fetch(QQ_REFRESH_ROUTE, { method: 'POST', credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body: unknown = await response.json()
      return { ...parsePanel(body), refreshed: (body as { refreshed?: unknown }).refreshed === true }
    },
  )
  // Functions stable for the registration's lifetime, so the section's polling effect never restarts on re-render.
  const refresh = (): void => { void loader.refresh() }
  const renewCode = (): void => { void loader.renewCode() }
  const injected = (): QqLoginInjected => ({ hooks: { qq: store }, refresh, renewCode })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'lsy-qq', order: SECTION_ORDER, label: () => t('nav'), locale: NS, inject: injected,
  }, QqLoginSection))
}
