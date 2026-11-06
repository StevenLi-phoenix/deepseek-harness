/**
 * The whitelist card's pure parts: which groups are recorded, which are offered, and the next `groups` list for an
 * add or a remove. The list itself lives in the `lsy-qq` plugin entry's config and is written through the
 * plugin-settings form; names and counts come from the Host panel.
 */

import type { QqGroup } from '../view.ts'

/** A QQ group number: digits only. */
export const GROUP_ID = /^[0-9]{3,20}$/

/** How many candidates show before "show more". */
export const CANDIDATES_SHOWN = 8

/** The `groups` field of the `lsy-qq` settings section. */
export interface GroupsSection {
  groups: string[]
}

/** One row of the whitelist or of the candidates. */
export interface GroupRow {
  readonly groupId: string
  /** The group's name, or its number while the account has not reported it. */
  readonly name: string
  readonly memberCount: number | null
  /** Messages dropped since the observer started; 0 for a recorded group. */
  readonly seen: number
}

/**
 * Validate a typed group number.
 * @param text - what the owner typed.
 * @returns the trimmed group number, or null when it is not one.
 */
export function parseGroupId(text: string): string | null {
  const id = text.trim()
  return GROUP_ID.test(id) ? id : null
}

/**
 * Add a group number to the whitelist.
 * @param current - the list now.
 * @param id - a group number to add.
 * @returns the list with the group last; the same list when it is already there.
 */
export function withGroup(current: readonly string[], id: string): string[] {
  return current.includes(id) ? [...current] : [...current, id]
}

/**
 * Remove a group number from the whitelist.
 * @param current - the list now.
 * @param id - a group number to remove.
 * @returns the list without it.
 */
export function withoutGroup(current: readonly string[], id: string): string[] {
  return current.filter(entry => entry !== id)
}

function rowOf(groupId: string, known: ReadonlyMap<string, QqGroup>): GroupRow {
  const group = known.get(groupId)
  return { groupId, name: group?.name ?? groupId, memberCount: group?.memberCount ?? null, seen: group?.seen ?? 0 }
}

/**
 * Build the rows of the recorded-groups list.
 * @param listed - the group numbers on the list now (from the settings form).
 * @param groups - the Host panel's groups, for names.
 * @returns one row per listed group, in list order.
 */
export function whitelistRows(listed: readonly string[], groups: readonly QqGroup[]): GroupRow[] {
  const known = new Map(groups.map(group => [group.groupId, group]))
  return listed.map(id => rowOf(id, known))
}

/**
 * Build the rows of the groups the account is in but the list does not record.
 * @param listed - the group numbers on the list now.
 * @param groups - the Host panel's groups.
 * @returns the account's other groups, the busiest first, then by name.
 */
export function candidateRows(listed: readonly string[], groups: readonly QqGroup[]): GroupRow[] {
  const on = new Set(listed)
  const known = new Map(groups.map(group => [group.groupId, group]))
  return groups
    .filter(group => !on.has(group.groupId))
    .map(group => rowOf(group.groupId, known))
    .sort((a, b) => b.seen - a.seen || a.name.localeCompare(b.name))
}
