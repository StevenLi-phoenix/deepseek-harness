/** The 浏览器接管 entry in the sidebar's panel list; the sidebar owns the row, label, and selected state. */

import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the sidebar's SlotMap merge (the 'sidebar.panellist' entry).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Draw a browser window with a pointer inside it, at the size the sidebar asks for.
 * @param props - the sidebar's icon share: the requested edge and whether the panel is selected.
 * @returns the icon element.
 */
export function BrowserTakeoverIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2.5 7.5H17.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M9.5 10.2L14.2 12.2L12.2 12.9L11.4 15L9.5 10.2Z" fill="currentColor" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  )
}
