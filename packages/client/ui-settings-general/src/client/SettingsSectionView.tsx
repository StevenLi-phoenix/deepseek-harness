/** The `settings.section.view` Factory: one settings page entry, wherever a surface shows it. */
import type { ReactNode } from 'react'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the Factory and `settings.section` declarations.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

/**
 * Render the requested entry with the caller's leave action and section switch.
 * @param props - the caller's entry id, its leave action, and the optional section switch, plus the declared child render share.
 * @returns the entry, or nothing when no entry has that id.
 */
export function SettingsSectionView({ id, close, select, renderSlot }: FactoryComponentPropsOf<'settings.section.view'>): ReactNode {
  return renderSlot('settings.section', { close, ...select === undefined ? {} : { select } }, { only: id })
}
