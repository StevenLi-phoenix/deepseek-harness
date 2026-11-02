/** A conversation that continues in a new Session (WeChat /new) takes its running monitors along. */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: ctx.lsyEventBus, whose Session handover moves a conversation's monitors to its new Session.
import type {} from '@deepseek-ai/dsh-lsy-event-bus'
import type { MonitorRegistry } from './monitor.ts'
import type { MonitorStorage } from './persistence.ts'

/**
 * Register the monitors with the event bus's Session handover; the tools work without the bus.
 * @param ctx - the preset scope's context.
 * @param registry - the monitors.
 * @param storage - the store, which learns the new owner.
 */
export function mountHandover(ctx: Context, registry: MonitorRegistry, storage: MonitorStorage): void {
  ctx.inject(['lsyEventBus'], (scoped) => {
    scoped.effect(() => scoped.lsyEventBus.registerHandover('monitor', (from, to) => {
      const moved = registry.transfer(from, to)
      for (const monitor of moved) {
        ctx.logger.info('monitor %s moved from session %s to %s', monitor.id, [...from].join(', '), to)
        storage.moveTo(monitor.id, to)
      }
      return moved.map(monitor => ({ id: monitor.id, label: monitor.description }))
    }), 'lsy-tool-monitor: session handover')
  })
}
