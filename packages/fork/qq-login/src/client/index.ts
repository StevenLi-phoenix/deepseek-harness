/**
 * QQ plugin, browser half: a Settings section ("QQ") over this package's Host route (`api/qq`). It shows whether
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
import { QQ_REFRESH_ROUTE, QQ_ROUTE, type QqRefreshAnswer } from '../view.ts'
import { GROUP_ID, withGroup, withoutGroup, type GroupsSection } from './groups.ts'
import { QqLoader, createQqStore, parsePanel } from './qq.ts'
import { QqLoginSection, type QqLoginInjected } from './QqLogin.tsx'
import { de, en, es, fr, ja, pt, ru, zh } from './locales.ts'

export type { QqLoginInjected, QqLoginProps } from './QqLogin.tsx'
export type { QqKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'qq'

/** The settings namespace: the profile entry id of the QQ observer, whose volatile `groups` the whitelist card edits. */
const GROUPS_NAMESPACE = 'qq'

/** Settings navigation position: just after System status. */
const SECTION_ORDER = 45

/** Required services: the slot registry and locale. */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Register the dictionaries and the Settings section over one shared store.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'qq: dictionaries')
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
      const fields = body as { refreshed?: unknown; reason?: unknown }
      return { ...parsePanel(body), refreshed: fields.refreshed === true, reason: typeof fields.reason === 'string' ? fields.reason as QqRefreshAnswer['reason'] : null }
    },
  )
  // Functions stable for the registration's lifetime, so the section's polling effect never restarts on re-render.
  const refresh = (): void => { void loader.refresh() }
  const renewCode = (): void => { void loader.renewCode() }
  const form = ctx.configForms.get<GroupsSection>(GROUPS_NAMESPACE)
  // Read-modify-write against the form's latest accepted list. The form fences the write by revision, so a list
  // changed elsewhere is refused, not overwritten.
  const writeGroups = async (change: (current: string[]) => string[]): Promise<boolean> => {
    const current = form.getSnapshot().value?.groups
    if (current === undefined) return false
    const accepted = await form.set('groups', change(current))
    if (accepted) void loader.refresh()
    return accepted
  }
  const addGroup = (id: string): Promise<boolean> => (
    GROUP_ID.test(id) ? writeGroups(current => withGroup(current, id)) : Promise.resolve(false)
  )
  const removeGroup = (id: string): Promise<boolean> => writeGroups(current => withoutGroup(current, id))
  const injected = (): QqLoginInjected => ({ hooks: { qq: store, groupsForm: form }, refresh, renewCode, addGroup, removeGroup })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'qq', order: SECTION_ORDER, label: () => t('nav'), locale: NS, inject: injected,
  }, QqLoginSection))
}
