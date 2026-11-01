/**
 * The "All settings" card as a reusable Component Factory: any Settings section renders it for one or more plugin
 * entry ids with `renderFactorySlot('settings.plugin-config', { entries: ['lsy-qq'] })`. The sections keep no
 * runtime tie to this package: where it is not loaded the factory is unregistered and the call renders nothing.
 *
 * TYPE HOME RATIONALE: this package declares and registers the factory, and a section that renders it already
 * depends on this package for the declaration, so the types live with their declarer.
 */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ConfigOp } from '../view.ts'
import type { ConfigState } from './store.ts'
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** What a section passes when it renders the card. */
export interface PluginConfigInput {
  /** Plugin entry ids (`id` in the profile patch) whose every Config field the card lists. Ids the Host does not run show nothing. */
  readonly entries: readonly string[]
}

/** The card's injected face. */
export interface PluginConfigInjected {
  hooks: {
    /** Every entry's last description and phase. */
    pluginConfig: ObservableSnapshot<ConfigState>
    /** The active UI locale, for schema descriptions. */
    locale: ObservableSnapshot<{ readonly active: string }>
  }
  /** Read the entries; a read in progress is not repeated. */
  load: (ids: readonly string[]) => void
  /** Save one entry's staged edits; resolves to whether they are in force and the plugin answers again. */
  save: (id: string, revision: string, ops: readonly ConfigOp[]) => Promise<boolean>
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    /** The "All settings" card: every Config field of the named plugin entries, with one explicit save. */
    'settings.plugin-config': {
      scope: 'root'
      props: PluginConfigInput
      locale: 'lsy.config'
      inject: PluginConfigInjected
    }
  }
}
