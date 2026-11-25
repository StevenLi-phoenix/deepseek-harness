/** The optional Host services the bus reads; each one is looked up when it is used, so a service mounted later is found. */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: ctx.sessionController, ctx.workspaceRegistry, ctx.schedule, and ctx.webhookRuntime.
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-webhook'
import type {} from '@deepseek-ai/dsh-workspace'
import type { LogLocator } from './archive.ts'
import type { OwnerNotifier } from './types.ts'

/**
 * What the bus reads of `ctx.ownerRelay` (`@deepseek-ai/dsh-owner-relay`). That package depends on
 * this one (`failureDetail`, `isSilentReply`, `OwnerNotifier`), so the bus reads the service through
 * this shape instead of importing it.
 */
interface OwnerRelayView {
  /** The channel that relays a Session's turns itself, or undefined. */
  ownerOf(sessionId: string): string | undefined
}

/** The Host services the bus reads, each undefined while it is not mounted. */
export interface HostServices {
  /** `ctx.ownerNotifier`. */
  notifier(): OwnerNotifier | undefined
  /** `ctx.webhookRuntime`, which starts the Sessions of `session` batches. */
  webhookRuntime(): Context['webhookRuntime'] | undefined
  /** `ctx.workspaceRegistry`: projects, archived and pinned Sessions. */
  workspaceRegistry(): Context['workspaceRegistry'] | undefined
  /** `ctx.sessionController`: Session listing and live Agents. */
  sessionController(): Context['sessionController'] | undefined
  /** `ctx.schedule`, which names the task behind a reminder turn. */
  schedule(): Context['schedule'] | undefined
  /** `ctx.sessionPersistence`, read for the last write of a Session log. */
  sessionPersistence(): LogLocator | undefined
  /** The relay channel that claimed a Session, read from `ctx.ownerRelay` when it is mounted. */
  relayOwner(sessionId: string): string | undefined
}

/**
 * The Host services of the bus's own context.
 * @param ctx - the bus's context.
 * @returns lookups that read `ctx` on every call.
 */
export function hostServices(ctx: Context): HostServices {
  return {
    notifier: () => ctx.get('ownerNotifier'),
    webhookRuntime: () => ctx.get('webhookRuntime'),
    workspaceRegistry: () => ctx.get('workspaceRegistry'),
    sessionController: () => ctx.get('sessionController'),
    schedule: () => ctx.get('schedule'),
    sessionPersistence: () => (ctx.get.bind(ctx) as (name: string) => unknown)('sessionPersistence') as LogLocator | undefined,
    relayOwner: (sessionId) => {
      const relay = (ctx.get as (name: string) => unknown)('ownerRelay') as Partial<OwnerRelayView> | undefined
      return relay?.ownerOf?.(sessionId)
    },
  }
}
