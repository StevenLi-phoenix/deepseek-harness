/**
 * WeChat channel plugin, browser half: a Settings section ("WeChat", 微信) over this package's
 * Host route (`api/wechat`). The section registers into `settings.section` like the upstream
 * pages, so it follows the settings shell's lifetime and appears after the built-in sections.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { WECHAT_ROUTE, type WechatAction } from '../../wechat-view.ts'
import { WechatLoader, WechatRefused, createWechatStore, parseAnswer } from './wechat.ts'
import { WechatSection, type WechatInjected } from './WechatSection.tsx'
import { de, en, es, fr, ja, pt, ru, zh } from './locales.ts'

export type { WechatInjected, WechatProps } from './WechatSection.tsx'
export type { WechatKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'wechat'

/** Settings navigation position: after System status (40) and the Bilibili account (45). */
const SECTION_ORDER = 52

/** One request to the route; the sign-in cookie rides along. */
async function request(action?: WechatAction) {
  // Document-relative, so a served mount keeps working.
  const init: RequestInit = action === undefined
    ? { credentials: 'same-origin', cache: 'no-store' }
    : { credentials: 'same-origin', cache: 'no-store', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) }
  const response = await fetch(WECHAT_ROUTE, init)
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: unknown }
    throw new WechatRefused(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`, response.status)
  }
  return parseAnswer(await response.json())
}

/**
 * Register the dictionaries and the Settings section over one shared store.
 * @param ctx - client root context with the slot registry and locale.
 */
export function registerWechat(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'wechat: dictionaries')
  const t = ctx.locale.bind(NS)
  const store = createWechatStore()
  const loader = new WechatLoader(store, () => request(), action => request(action))
  // Stable functions for the registration's lifetime, so the section's polling effects never restart on re-render.
  const injected: WechatInjected = {
    hooks: { wechat: store },
    refresh: () => { void loader.refresh() },
    startLogin: () => { void loader.startLogin() },
    pollLogin: () => { void loader.pollLogin() },
    submitCode: (code) => { void loader.submitCode(code) },
    cancelLogin: () => { void loader.cancelLogin() },
    dismissLogin: () => { loader.dismissLogin() },
    unbind: () => { void loader.unbind() },
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'wechat', order: SECTION_ORDER, label: () => t('nav'), locale: NS, inject: () => injected,
  }, WechatSection))
}
