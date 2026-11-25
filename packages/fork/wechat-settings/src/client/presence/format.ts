/** Pure presentation helpers of the quiet-hours section: times and durations. */
import type { PresenceKey } from './locales.ts'

export { agoText } from '../ago.ts'
export { dateTime, stampTime } from '@deepseek-ai/dsh-settings-kit/client'

/** The section's `t`, narrowed to this namespace. */
export type Translate = (key: PresenceKey, params?: Record<string, string | number>) => string
