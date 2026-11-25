/**
 * Browser helpers the fork's Settings sections share: polling while the page is visible, a read shared while in
 * flight, time and duration text, the status line, and the card, header, and pending markup. Plain functions and
 * components with no state of their own; the `./client` subpath is the Client compiler's output, which each section's
 * bundle inlines.
 *
 * @module @deepseek-ai/dsh-settings-kit/client
 */

export { shareInFlight } from './in-flight.ts'
export { Card, PendingSection, StatusHeader, type SectionClasses } from './parts.tsx'
export { startPolling, type PageVisibility } from './polling.ts'
export { statusLine, type StatusKey, type StatusLine, type StatusTone, type StatusWording } from './status.ts'
export { dateTime, formatDuration, minutesAgo, stampTime, type DurationKey, type MinutesAgoKey } from './time-text.ts'
