/**
 * Browser helpers the fork's Settings sections share. The package root carries the types only; the helpers are the
 * `./client` subpath, which each section's bundle inlines.
 *
 * @module @deepseek-ai/dsh-settings-kit
 */

export type {
  DurationKey, MinutesAgoKey, PageVisibility, SectionClasses, StatusKey, StatusLine, StatusTone, StatusWording,
} from './client.ts'
