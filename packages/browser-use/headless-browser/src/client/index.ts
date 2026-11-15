/**
 * Take-over page, browser half: 浏览器接管 as a page of the Web UI, so the
 * owner reaches the live browser by clicking a navigation row instead of
 * typing a URL below the site root. The page draws the same `/headless-browser/live`
 * stream the standalone page draws and sends the same control and input
 * messages; the Host routes and that standalone page are untouched.
 *
 * - `main` page `browser-takeover`: the live frame, the holder, the page URL,
 *   the viewer count, and the 接管 / 交回 buttons.
 * - `sidebar.panellist` entry `browser-takeover`: the row that selects the page.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the slot registry's merge (the 'main' and 'sidebar.panellist' entries).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { BrowserTakeoverIcon } from './BrowserTakeoverIcon.tsx'
import { BrowserTakeoverPage } from './BrowserTakeoverPage.tsx'
import { de, en, es, fr, ja, pt, ru, zh } from './locales.ts'

export type { BrowserTakeoverPageProps, BrowserTakeoverViewProps } from './BrowserTakeoverPage.tsx'
export type { HeadlessBrowserKey } from './locales.ts'

/** Dictionary namespace owned by this plugin's browser half. */
const NS = 'headless-browser'

/** The page's main-panel key, and the id of the sidebar row that selects it. */
export const PANEL_ID = 'browser-takeover' as MainPanelId

/** Sidebar position after Plugins (0) and Automations (10), matching the fork's own pages. */
const PANEL_ORDER = 30

/** Required services: the slot registry and the locale. */
export const inject = ['slots', 'locale']

/**
 * Register the dictionaries, the page, and its navigation row.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'headless-browser: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL_ID, locale: NS,
  }, BrowserTakeoverPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: () => t('nav.page'), locale: NS,
  }, BrowserTakeoverIcon))
}
