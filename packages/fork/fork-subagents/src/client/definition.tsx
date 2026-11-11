/**
 * What the `fork-subagents` Sidebar type is: a page (no address), offered on the guide, one per pane.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { T } from './model.ts'

/** The tab kind this package owns. */
export const PANEL_KIND = 'fork-subagents'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const PANEL_ID = '@deepseek-ai/dsh-fork-subagents'

/**
 * Guide artwork: one agent above two it started, in the guide's fixed palette style.
 * @param props - canvas size and layout class supplied by the guide.
 * @returns an ornamental SVG hidden from assistive technology.
 */
export function GuideArtworkSubagents({ size = 36, className }: { size?: number | undefined; className?: string | undefined }) {
  return (
    <svg width={size} height={size} className={className} aria-hidden="true" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M18 14.5V18.5M18 18.5H11V22M18 18.5H25V22" stroke="#9AA4B2" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="18" cy="10" r="4.5" fill="#7C8CF8" />
      <circle cx="11" cy="26.5" r="4.5" fill="#57C08A" />
      <circle cx="25" cy="26.5" r="4.5" stroke="#57C08A" strokeWidth="1.8" />
    </svg>
  )
}

/**
 * The type's registry definition.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @returns the definition to register.
 */
export function panelDefinition(t: T): SidebarRightTabDefinition {
  return {
    id: PANEL_ID,
    kind: PANEL_KIND,
    priority: 'extension',
    title: () => t('type.label'),
    guide: [{
      id: 'subagents',
      order: 40,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
      icon: GuideArtworkSubagents,
    }],
  }
}
