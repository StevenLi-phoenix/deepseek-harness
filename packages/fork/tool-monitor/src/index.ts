/**
 * `monitor_start`, `monitor_stop`, `monitor_list`: the agent watches anything a
 * shell command can print — a log tail, a polling loop — and each new stdout
 * line comes back to the same Session, waking it when idle, as Claude Code's
 * Monitor does. Each running monitor is stored, and a host restart starts it
 * again under the same id; the registry, not the model, enforces batching,
 * budgets, and deadlines.
 *
 * @module @deepseek-ai/dsh-tool-monitor
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { createDelivery, SOURCE_KIND, type MonitorEvent } from './delivery.ts'
import { mountHandover } from './handover.ts'
import { DEFAULT_LIMITS, MonitorRegistry } from './monitor.ts'
import { MonitorStorage } from './persistence.ts'
import { registerMonitorTools } from './tools.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Notices of a background monitor; the event bus uses the kind to report the turn they wake.
     * @persistenceAttribution
     */
    'tool-monitor': { kind: 'tool-monitor' } & ContextFormed
  }
}

export { DEFAULT_LIMITS, MonitorRefused, MonitorRegistry, noticeText, type Deliver, type MonitorLimits, type MonitorNotice, type MonitorView, type RestoreRequest } from './monitor.ts'
export { monitorDomain, type MonitorRecord } from './storage.ts'

/** Plugin name; also the source kind of monitor notices. */
export const name = SOURCE_KIND


/**
 * Mounted inside an agent preset's scope, like other tool plugins. A preset's
 * plugins load when the Host registers the preset, not with its first Agent, so
 * stored monitors start again at host start. Sessions resume lazily after a
 * restart: delivery resolves an owner whose agent is not loaded through the
 * Session controller, and Session persistence tells a gone Session from an
 * unloaded one.
 */
export const inject = ['tools', 'storageDomain', 'sessionController', 'sessionPersistence']

/** How often monitors of vanished Sessions are stopped. */
const SWEEP_MS = 60_000

/**
 * Register the monitor tools, and start the stored monitors again.
 * @param ctx - the preset scope's context.
 */
export function apply(ctx: Context): void {
  /** Set once disposal begins: nothing is delivered, swept, or restored after that. */
  let stopping = false
  const stopped = (): boolean => stopping

  // Both services are optional: a process without a chat channel has no main agent, and its monitors answer their Sessions.
  const optional = ctx as unknown as {
    get(name: 'ownerNotifier'): { ownsSession?(sessionId: string): boolean } | undefined
    get(name: 'eventBus'): { publish(event: MonitorEvent): Promise<unknown> } | undefined
  }
  const delivery = createDelivery(ctx, stopped, {
    isMainAgent: owner => optional.get('ownerNotifier')?.ownsSession?.(owner) === true,
    publish: (event) => {
      const bus = optional.get('eventBus')
      return bus === undefined ? Promise.reject(new Error('the event bus is not running')) : bus.publish(event)
    },
  })
  const storage = new MonitorStorage(ctx, { reachable: delivery.reachable, stopped })
  const registry = new MonitorRegistry(delivery.deliver, DEFAULT_LIMITS, Date.now, (monitor, reason) => {
    ctx.logger.info('monitor %s ended: %s', monitor.id, reason)
    storage.forget(monitor.id)
  })
  storage.restoreInto(registry)

  ctx.effect(() => {
    const sweep = setInterval(() => { void registry.sweep(delivery.alive) }, SWEEP_MS)
    sweep.unref()
    return async () => {
      stopping = true
      clearInterval(sweep)
      // Kills every process group; the records stay, so the next host start runs them again.
      registry.dispose()
      await storage.close()
    }
  }, 'tool-monitor: stop monitors')

  mountHandover(ctx, registry, storage)
  registerMonitorTools(ctx, registry, storage)
}
