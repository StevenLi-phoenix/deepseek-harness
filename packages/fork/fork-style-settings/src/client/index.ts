/**
 * Speaking style plugin, browser half: a Settings section ("说话风格", id `fork-style`) over this package's Host routes
 * (`api/fork.style`, `api/fork.style.edit`, `api/fork.style.collect`). The owner sees DSH's persona card and its history,
 * the traits, memes, and tone samples the agents share, edits the card, rolls it back, deletes bad items with one tap,
 * keeps pending ones when review is required, reads the meme miner's last run, watches the stock-line trend, and edits
 * the plugin's configuration in the All settings card at the foot. The section registers into `settings.section` like
 * the upstream pages.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { STYLE_COLLECT_ROUTE, STYLE_EDIT_ROUTE, STYLE_ROUTE } from '../view.ts'
import { StyleLoader, createStyleStore, parseEditAnswer, parsePanel } from './style.ts'
import { StyleSection, type StyleSectionInjected } from './StyleSection.tsx'
import { de, en, es, fr, ja, pt, ru, zh } from './locales.ts'

export type { StyleSectionInjected, StyleSectionProps } from './StyleSection.tsx'
export type { StyleKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'fork.style'

/** Settings navigation position: after QQ. */
const SECTION_ORDER = 47

/** Required services: the slot registry and locale. */
export const inject = ['slots', 'locale']

/**
 * Register the dictionaries and the Settings section over one shared store.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'fork-style: dictionaries')
  const t = ctx.locale.bind(NS)
  const store = createStyleStore()
  // Document-relative, so a served mount keeps working; the sign-in cookie rides along.
  const call = async (route: string, init?: { method: 'POST'; body?: string }): Promise<unknown> => {
    const response = await fetch(route, { credentials: 'same-origin', cache: 'no-store', ...init, ...init?.body === undefined ? {} : { headers: { 'content-type': 'application/json' } } })
    // An edit the Host refused still answers JSON with the panel; only a body that is not JSON is a transport failure.
    return await response.json()
  }
  const loader = new StyleLoader(store, {
    read: async () => parsePanel(await call(STYLE_ROUTE)),
    edit: async edit => parseEditAnswer(await call(STYLE_EDIT_ROUTE, { method: 'POST', body: JSON.stringify(edit) })),
    collect: async () => parsePanel(await call(STYLE_COLLECT_ROUTE, { method: 'POST' })),
  })
  // Functions stable for the registration's lifetime, so the section's polling effect never restarts on re-render.
  const refresh = (): void => { void loader.refresh() }
  const edit = (change: Parameters<StyleLoader['edit']>[0]): Promise<boolean> => loader.edit(change)
  const collect = (): void => { void loader.collect() }
  const injected = (): StyleSectionInjected => ({ hooks: { style: store }, refresh, edit, collect })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'fork-style', order: SECTION_ORDER, label: () => t('nav'), locale: NS, inject: injected,
  }, StyleSection))
}
