/**
 * Plugin configuration, browser half: the reusable "All settings" card. It registers the Component Factory
 * `settings.plugin-config`, which any Settings section renders for the plugin entries it owns:
 *
 *     props.renderFactorySlot('settings.plugin-config', { entries: ['fork-qq'] })
 *
 * The card lists every Config field of each entry (read from this package's Host route `api/fork.config`), shows the
 * layer that set each value, stages edits, and saves them in one write after a review. A section that renders the
 * factory needs only the type-only import of this package's `/client` entry; without this package the factory is
 * unregistered and the call renders nothing.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { CONFIG_ROUTE, type ConfigDescribe, type ConfigSaveRequest, type ConfigSaveResult } from '../view.ts'
import { PluginConfigCard } from './PluginConfigCard.tsx'
import { de, en, es, fr, ja, pt, ru, zh } from './locales.ts'
import type { PluginConfigInjected } from './slot-contract.ts'
import { ConfigLoader, createConfigStore, type ConfigTransport } from './store.ts'

export type { PluginConfigInjected, PluginConfigInput } from './slot-contract.ts'
export type { PluginConfigCardProps } from './PluginConfigCard.tsx'
export type { ConfigKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'fork.config'

/** Required services: the slot registry and locale. */
export const inject = ['slots', 'locale']

/**
 * The Host routes over `fetch`; document-relative, so a served mount keeps working, and the sign-in cookie rides along.
 * @returns the transport the loader uses.
 */
function httpTransport(): ConfigTransport {
  return {
    read: async (ids, exclude) => {
      const query = `entries=${encodeURIComponent(ids.join(','))}${exclude.length === 0 ? '' : `&exclude=${encodeURIComponent(exclude.join(','))}`}`
      const response = await fetch(`${CONFIG_ROUTE}?${query}`, { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json() as ConfigDescribe
    },
    write: async (request: ConfigSaveRequest) => {
      const response = await fetch(CONFIG_ROUTE, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
      })
      // A refusal carries its reason in the body; only an answer without one is a transport failure.
      const body = await response.json().catch((_notJson: unknown) => undefined) as ConfigSaveResult | undefined
      if (body === undefined) throw new Error(`HTTP ${response.status}`)
      return body
    },
  }
}

/**
 * Register the dictionaries and the card's factory over one shared store.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'fork-config: dictionaries')
  const store = createConfigStore()
  const loader = new ConfigLoader(store, httpTransport())
  // Functions stable for the registration's lifetime, so the card's effect never restarts on re-render.
  const load: PluginConfigInjected['load'] = (ids, exclude) => { void loader.load(ids, exclude) }
  const save: PluginConfigInjected['save'] = (id, exclude, revision, ops) => loader.save(id, exclude, revision, ops)
  const injected = (): PluginConfigInjected => ({ hooks: { pluginConfig: store, locale: ctx.locale }, load, save })
  ctx.effect(
    () => ctx.slots.registerFactory({ name: 'settings.plugin-config', scope: 'root', locale: NS, inject: injected }, PluginConfigCard),
    'fork-config: settings.plugin-config factory',
  )
}
