/** Pure subscription matching and loop suppression. */
import type { LsyEventInput, Subscription, SuppressConfig } from './types.ts'

/**
 * Compile a whole-string, case-insensitive glob where `*` matches any run of characters.
 * @param pattern - glob; every other character is literal.
 * @returns anchored regular expression.
 */
export function globToRegExp(pattern: string): RegExp {
  const body = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${body}$`, 'i')
}

/** True when the list is empty or one of its globs matches. */
function anyGlob(patterns: readonly string[], value: string): boolean {
  return patterns.length === 0 || patterns.some(pattern => globToRegExp(pattern).test(value))
}

/**
 * Decide whether a subscription selects an event.
 * @param subscription - selector lists; an empty list matches everything.
 * @param event - published event.
 * @returns true when every non-empty selector list matches.
 */
export function matchesSubscription(subscription: Subscription, event: LsyEventInput): boolean {
  return anyGlob(subscription.sources, event.source)
    && anyGlob(subscription.kinds, event.kind)
    && anyGlob(subscription.subjects, event.subject)
}

/**
 * Explain why an event was caused by the agent itself, if it was.
 * @param config - agent identities and output markers.
 * @param event - published event.
 * @returns `actor:<login>` or `marker:<marker>`, or undefined when the event is external.
 */
export function suppressionReason(config: SuppressConfig, event: LsyEventInput): string | undefined {
  const actor = event.actor?.trim().toLowerCase()
  if (actor) {
    for (const candidate of config.actors) {
      const normalized = candidate.trim().toLowerCase()
      if (normalized !== '' && normalized === actor) return `actor:${actor}`
    }
  }
  const haystack = `${event.title}\n${event.text ?? ''}`
  for (const marker of config.markers) {
    if (marker.trim() !== '' && haystack.includes(marker)) return `marker:${marker}`
  }
  return undefined
}
