/**
 * System status plugin, browser half: a Settings section ("System status",
 * 系统状态) over this package's Host route (`api/lsy.sysmon`). The section
 * registers into `settings.section` like the upstream pages, so it follows the
 * settings shell's lifetime and appears after the built-in sections.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SYSMON_ROUTE } from '../snapshot.ts'
import { SysmonLoader, createSysmonStore, parseSnapshot } from './sysmon.ts'
import { SystemStatusSection, type SystemStatusInjected } from './SystemStatus.tsx'
import { en, zh } from './locales.ts'

export type { SystemStatusInjected, SystemStatusProps } from './SystemStatus.tsx'
export type { SysmonKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'lsy.sysmon'

/** Settings navigation position: after Account, General, Models, Plugins, and Agent presets. */
const SECTION_ORDER = 40

/** Required services: the slot registry and locale. */
export const inject = ['slots', 'locale']

/**
 * Register the dictionaries and the Settings section over one shared store.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'lsy-sysmon: dictionaries')
  const t = ctx.locale.bind(NS)
  const store = createSysmonStore()
  const loader = new SysmonLoader(store, async () => {
    // Document-relative, so a served mount keeps working; the sign-in cookie rides along.
    const response = await fetch(SYSMON_ROUTE, { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return parseSnapshot(await response.json())
  })
  // One function for the registration's lifetime, so the section's polling effect never restarts on re-render.
  const refresh = (): void => { void loader.refresh() }
  const injected = (): SystemStatusInjected => ({ hooks: { sysmon: store }, refresh })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'lsy-sysmon', order: SECTION_ORDER, label: () => t('nav'), locale: NS, inject: injected,
  }, SystemStatusSection))
}
