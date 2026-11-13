/**
 * Gmail accounts, browser half: a Settings section ("邮箱") over this package's Host route (`api/gmail`). The
 * section registers into `settings.section` like the upstream pages, so it follows the settings shell's lifetime and
 * appears after the built-in sections. A sign-in opens Google's page in this tab; Google returns to the Host's
 * `/gmail.oauth` page, outside the app.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { GMAIL_ROUTE, type GmailAction } from '../view.ts'
import { GmailLoader, RouteError, createGmailStore, parseAnswer } from './gmail.ts'
import { GmailSection, type GmailInjected } from './GmailSection.tsx'
import { de, en, es, fr, ja, pt, ru, zh } from './locales.ts'

export type { GmailInjected, GmailProps } from './GmailSection.tsx'
export type { GmailKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'gmail'

/** Settings navigation position: after 课程 DDL (47) and before 勿扰 (53). */
const SECTION_ORDER = 48

/** Required services: the slot registry and locale. */
export const inject = ['slots', 'locale']

/**
 * One request to the route; the sign-in cookie rides along.
 * @param init - the POST, or nothing for the status.
 * @returns the parsed body of a success.
 */
async function call(init?: RequestInit): Promise<unknown> {
  // Document-relative, so a served mount keeps working.
  const response = await fetch(GMAIL_ROUTE, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body: unknown = await response.json().catch(() => null)
  if (response.ok) return body
  const error = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : null
  // A 400 is a refusal whose words are meant for the owner; other failures are explained in the DSH log.
  if (response.status === 400 && error !== null) throw new RouteError('refused', error)
  throw new RouteError('failed', `HTTP ${response.status}`)
}

/**
 * Register the dictionaries and the Settings section over one shared store.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'gmail-settings: dictionaries')
  const t = ctx.locale.bind(NS)
  const store = createGmailStore()
  const loader = new GmailLoader(
    store,
    // The status read answers `{ status }` like an action does, without a sign-in page.
    async () => parseAnswer(await call()).status,
    async action => parseAnswer(await call({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) })),
    (url) => { window.location.assign(url) },
  )
  // One function each for the registration's lifetime, so the section's polling effect never restarts on re-render.
  const refresh = (): void => { void loader.refresh() }
  const act = (action: GmailAction, control?: string): Promise<boolean> => loader.act(action, control)
  const copy = async (text: string): Promise<void> => { await navigator.clipboard.writeText(text) }
  const injected = (): GmailInjected => ({ hooks: { gmail: store }, refresh, act, copy, origin: window.location.origin })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'gmail', order: SECTION_ORDER, label: () => t('nav'), locale: NS, inject: injected,
  }, GmailSection))
}
