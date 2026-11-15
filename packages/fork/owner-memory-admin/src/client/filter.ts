/**
 * The entries card's list state: which filter is on, which entries the owner has selected, and what a bulk
 * action sends. Pure functions, so the page's filter and selection rules are testable without a DOM.
 */

import type { Category, EntryView, MemoryAction, SuggestionView } from '../view.ts'

/** Which list the card shows: every entry, or the groups that say nearly the same thing. */
export type ListMode = 'all' | 'duplicates'

/** What the card is filtering by. */
export interface ListFilter {
  /** The Host's search terms: whitespace-separated, all required, an id matches itself. */
  readonly q: string
  readonly category: Category | 'all'
  readonly mode: ListMode
}

/** Nothing filtered and every entry shown. */
export const DEFAULT_FILTER: ListFilter = { q: '', category: 'all', mode: 'all' }

/**
 * The filter with some fields changed.
 * @param filter - the filter now.
 * @param patch - the fields to change.
 * @returns the new filter.
 */
export function withFilter(filter: ListFilter, patch: Partial<ListFilter>): ListFilter {
  return { ...filter, ...patch }
}

/**
 * Whether the filter hides anything; a filter that hides nothing shows the whole file.
 * @param filter - the filter.
 * @returns true when a search or a category is on.
 */
export function isFiltered(filter: ListFilter): boolean {
  return filter.q.trim() !== '' || filter.category !== 'all'
}

/**
 * The terms of a search, lower-cased and deduplicated.
 * @param q - the search box's text.
 * @returns the terms; empty for an empty search.
 */
export function termsOf(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/\s+/u).filter(term => term.length > 0))]
}

/**
 * Whether one entry answers the search terms and the category, the way the Host's list does.
 * @param entry - one entry.
 * @param filter - the filter.
 * @returns true when every term is in the text or is the id, and the category matches.
 */
export function entryMatches(entry: EntryView, filter: ListFilter): boolean {
  if (filter.category !== 'all' && entry.category !== filter.category) return false
  const text = entry.text.toLowerCase()
  return termsOf(filter.q).every(term => text.includes(term) || entry.id === term)
}

/** One member of a duplicate group, as the filter needs it. */
type GroupMember = { readonly id: string; readonly category: Category; readonly text: string }

/** A duplicate group, as the filter needs it. */
type FilterableGroup = { readonly ids: readonly string[]; readonly members: readonly GroupMember[] }

/**
 * Whether a group of near-duplicates answers the filter: its category when one is asked for, and its members'
 * text for every term, so searching a topic narrows the groups too.
 * @param group - one group from the Host.
 * @param filter - the filter.
 * @returns true when the group is shown.
 */
export function groupMatches(group: FilterableGroup, filter: ListFilter): boolean {
  if (filter.category !== 'all' && !group.members.some(member => member.category === filter.category)) return false
  const text = group.members.map(member => member.text.toLowerCase()).join('\n')
  const ids = new Set(group.members.map(member => member.id))
  return termsOf(filter.q).every(term => text.includes(term) || ids.has(term))
}

/**
 * Stable key of a suggestion or group, so the page can dismiss one without losing the others.
 * @param kind - `merge` for a duplicate group, `stale` for a single entry.
 * @param ids - the entries it is about.
 * @returns the key.
 */
export function dismissKey(kind: 'merge' | 'stale', ids: readonly string[]): string {
  return `${kind}:${kind === 'merge' ? ids.toSorted().join('-') : ids.join('-')}`
}

/**
 * The suggestion's key, as the Host built it; the page dismisses by this.
 * @param suggestion - one suggestion.
 * @returns its key.
 */
export function suggestionKey(suggestion: SuggestionView): string {
  return suggestion.kind === 'merge' ? dismissKey('merge', suggestion.ids) : dismissKey('stale', suggestion.ids)
}

/**
 * A selection with one id added or taken out.
 * @param selected - the selected ids.
 * @param id - the id to toggle.
 * @returns the new selection.
 */
export function toggleSelection(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter(current => current !== id) : [...selected, id]
}

/**
 * The selection after a select-all box: every shown id when not all are selected, nothing when they all are.
 * @param selected - the selected ids.
 * @param ids - the ids on screen.
 * @returns the new selection.
 */
export function selectAll(selected: readonly string[], ids: readonly string[]): string[] {
  const all = ids.length > 0 && ids.every(id => selected.includes(id))
  return all ? selected.filter(id => !ids.includes(id)) : [...new Set([...selected, ...ids])]
}

/**
 * The selection, without ids that are no longer shown.
 * @param selected - the selected ids.
 * @param ids - the ids the list now shows.
 * @returns the pruned selection.
 */
export function keepShown(selected: readonly string[], ids: readonly string[]): string[] {
  return selected.filter(id => ids.includes(id))
}

/**
 * The body of a merge the owner asked for, which the Host answers with a preview.
 * @param ids - the entries to merge.
 * @returns the action to post.
 */
export function mergePayload(ids: readonly string[]): MemoryAction {
  return { action: 'merge', ids: [...ids] }
}

/**
 * The body that applies a previewed merge with the owner's wording and category.
 * @param preview - the Host's preview.
 * @param text - the owner's merged text.
 * @param category - the owner's category, when they changed it.
 * @returns the action to post.
 */
export function mergeApplyPayload(
  preview: { readonly ids: readonly string[]; readonly keep: string; readonly category: Category; readonly token: string },
  text: string,
  category?: Category,
): MemoryAction {
  return {
    action: 'merge',
    ids: [...preview.ids],
    keep: preview.keep,
    category: category ?? preview.category,
    text,
    confirm: preview.token,
  }
}

/**
 * The body of a bulk category change.
 * @param ids - the entries to move.
 * @param category - where to move them.
 * @returns the action to post.
 */
export function reclassifyPayload(ids: readonly string[], category: Category): MemoryAction {
  return { action: 'reclassify', ids: [...ids], category }
}
