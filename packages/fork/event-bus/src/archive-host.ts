/** The auto-archive sweep's view of the Host, and the Sessions the bus itself keeps out of the sweep. */

import type { SessionId } from '@deepseek-ai/dsh-session'
import { logModifiedAt, type ArchiveHost, type SessionRow } from './archive.ts'
import type { HostServices } from './host.ts'
import type { RouteSet } from './routes.ts'
import type { TurnObserver } from './turns.ts'
import type { PersistentSessionView } from './types.ts'

/** What the sweep reads of the Host and of the bus. */
export interface ArchiveHostDeps {
  host: Pick<HostServices, 'sessionController' | 'sessionPersistence' | 'workspaceRegistry'>
  turns: Pick<TurnObserver, 'runningSessionIds'>
  /** The bus's persistent Sessions (`EventBus.persistentSessions()`). */
  persistentSessions(): readonly PersistentSessionView[]
  routes: Pick<RouteSet, 'stored'>
}

/**
 * The Host access of the bus's auto-archive sweep.
 * @param deps - Host services and the bus state that keeps Sessions.
 * @returns the sweep's Host; every member reads its sources when it is called.
 */
export function archiveHost(deps: ArchiveHostDeps): ArchiveHost {
  const { host } = deps
  return {
    now: () => Date.now(),
    archivedIds: () => new Set(host.workspaceRegistry()?.archivedSessionIds ?? []),
    pinnedIds: () => new Set(host.workspaceRegistry()?.pinnedSessionIds ?? []),
    list: async (signal): Promise<readonly SessionRow[]> => {
      const controller = host.sessionController()
      if (controller === undefined) throw new Error('no sessionController service is mounted')
      const { items } = await controller.list({}, signal)
      const persistence = host.sessionPersistence()
      const rows: SessionRow[] = []
      for (const item of items) {
        const title = item.projections?.values.title
        // Without the list-metadata projection, updatedAt is the creation time and tells nothing about use: read the log's
        // last write instead, and when that is unavailable too the Session is never archived.
        const known = item.projections?.values.sessionListMetadata !== undefined
        const written = known ? undefined : await logModifiedAt(persistence, item.sessionId)
        rows.push({
          id: item.sessionId,
          updatedAt: written === undefined ? item.updatedAt : Math.max(item.updatedAt, written),
          running: item.running,
          subagent: item.origin === 'subagent',
          activityUnknown: !known && written === undefined,
          ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
          ...(typeof title === 'string' && title !== '' ? { title } : {}),
        })
      }
      return rows
    },
    archive: async (id) => {
      const registry = host.workspaceRegistry()
      if (registry === undefined) throw new Error('no workspaceRegistry service is mounted')
      await registry.archiveSession(id as SessionId)
    },
    builtinProtected: () => {
      const kept = new Map<string, string>()
      for (const id of deps.turns.runningSessionIds()) kept.set(id, 'running')
      for (const view of deps.persistentSessions()) kept.set(view.sessionId, 'persistent')
      for (const record of deps.routes.stored()) if (record.createdBy !== undefined) kept.set(record.createdBy, 'subscription')
      return kept
    },
  }
}
