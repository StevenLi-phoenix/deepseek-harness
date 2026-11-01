/** What every card of the Bilibili section receives. */
import type { BiliAction, BiliView } from '../view.ts'
import type { BiliState } from './bili.ts'
import type { Translate } from './format.ts'

/** Shared props of the account, gate, and ledger cards. */
export interface CardProps {
  readonly view: BiliView
  /** The current instant, read once per render. */
  readonly now: number
  readonly t: Translate
  /** The action in flight, if any: every control is disabled meanwhile. */
  readonly busy: BiliState['busy']
  /** Post one action. */
  readonly act: (action: BiliAction) => void
}
