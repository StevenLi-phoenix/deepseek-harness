/**
 * Identifiers and helpers of bus deliveries: the webhook kind and rule id the bus dispatches under, the
 * `persistent` table key of a subscription's Session, and the project (Workspace) its Sessions run in.
 */

import { mkdir } from 'node:fs/promises'

/** Webhook provider kind of every delivery this bus dispatches. */
export const BUS_EVENT_KIND = 'bus-event'
/** Id of the webhook rule that turns bus deliveries into Session requests. */
export const BUS_EVENT_RULE_ID = 'event-bus'

/**
 * The `persistent` table key of a subscription's Session: the subscription id, or `<id>|<subject>` for `key: subject`.
 * @param subscription - subscription id.
 * @param subject - the events' subject, for `key: subject`.
 * @returns the table key.
 */
export function persistentKey(subscription: string, subject?: string): string {
  return subject === undefined ? subscription : `${subscription}|${subject}`
}

/** What {@link ensureProject} needs of `ctx.workspaceRegistry`. */
export interface ProjectRegistry {
  resolveByPath(path: string): Promise<{ readonly path: string; readonly title: string } | undefined>
  create(path: string, title?: string): Promise<{ readonly path: string; readonly title: string }>
}

/**
 * Make sure a directory exists and is a Web UI project (Workspace), so the Sessions that run there are grouped under it.
 * An existing project keeps its title (the owner may have renamed it); a new one is titled `name`.
 * @param registry - `ctx.workspaceRegistry`, or undefined to only create the directory.
 * @param path - absolute directory.
 * @param name - title of a new project.
 * @returns `created`, `existing`, or `directory-only` when no registry is mounted.
 */
export async function ensureProject(registry: ProjectRegistry | undefined, path: string, name: string): Promise<'created' | 'existing' | 'directory-only'> {
  await mkdir(path, { recursive: true })
  if (registry === undefined) return 'directory-only'
  if (await registry.resolveByPath(path) !== undefined) return 'existing'
  await registry.create(path, name)
  return 'created'
}
