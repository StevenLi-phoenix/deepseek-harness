/**
 * Identifiers and helpers of bus deliveries: the webhook kind and rule id the bus dispatches under, the
 * `persistent` table key of a subscription's Session, and the project (Workspace) its Sessions run in.
 */

import { mkdir } from 'node:fs/promises'
import { errorText, type BusLogger } from './log.ts'

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

/** {@link ensureProject} once per path for the life of the bus; a failed attempt is forgotten, so a later call tries again. */
export class ProjectDirectories {
  private readonly known = new Map<string, Promise<void>>()

  /**
   * @param registry - reads `ctx.workspaceRegistry` when a path is first ensured.
   * @param logger - log sink.
   */
  constructor(private readonly registry: () => ProjectRegistry | undefined, private readonly logger: BusLogger) {}

  /**
   * Ensure a project directory, or join the attempt already made for its path.
   * @param path - absolute directory.
   * @param name - title of a new project.
   * @returns resolves once the directory exists and is a project; a registry failure is logged, not thrown.
   */
  ensure(path: string, name: string): Promise<void> {
    const known = this.known.get(path)
    if (known !== undefined) return known
    const work = ensureProject(this.registry(), path, name).then(
      (outcome) => { this.logger.info(`event-bus: project ${JSON.stringify(name)} at ${path}: ${outcome}`) },
      (error: unknown) => {
        this.known.delete(path)
        this.logger.warn(`event-bus: project ${JSON.stringify(name)} at ${path} not ensured: ${errorText(error)}`)
      },
    )
    this.known.set(path, work)
    return work
  }
}
