/** The message flow's row in the sidebar's panel list. */

import type { ReactNode } from 'react'
import { IconBranchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the sidebar's SlotMap merge (the 'sidebar.panellist' entry).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Draw the icon.
 * @param props - the size the row asks for.
 * @returns the icon.
 */
export function FlowPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconBranchOutlineRegular size={size} />
}
