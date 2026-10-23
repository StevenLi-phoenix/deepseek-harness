/**
 * Account-page extension slot: the seat through which a plugin adds UI under
 * the DeepSeek account card, such as the balances of other providers, without
 * editing the Account section.
 *
 * TYPE HOME RATIONALE: the Account section declares this slot at runtime, and
 * a plugin registering an extension already depends on this package for the
 * declaration. The types therefore live with their declarer.
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Ordered extension area after the account's balance card. Without a
     * registrant the area renders nothing.
     */
    'settings.account.balances': { kind: 'list'; scope: 'root'; owner: AccountBalancesOwnerProps }
  }
}

/** Owner share of the balances area (the section supplies nothing). */
export interface AccountBalancesOwnerProps {
  /** Marker field: owner props are intentionally empty. */
  children?: never
}
