/** Session handover: move what earlier Sessions own to the Session a conversation continues in (WeChat `/new`). */

import { errorText, type BusLogger } from './log.ts'
import type { SubscriptionStore } from './subscriptions.ts'
import type { SessionHandoverMover, SessionHandoverReport } from './types.ts'

/** What a handover reads and calls. */
export interface SessionHandoverDeps {
  subscriptions: Pick<SubscriptionStore, 'reassignCreators'>
  logger: BusLogger
}

/** Holds the registered movers; the bus's own run-time subscriptions always move first. */
export class SessionHandover {
  /** Handover movers in registration order. */
  private readonly movers: Array<{ kind: string; move: SessionHandoverMover }> = []

  /** @param deps - the subscription store and the log sink. */
  constructor(private readonly deps: SessionHandoverDeps) {}

  /**
   * Register a mover that runs on every handover.
   * @param kind - binding kind reported with what the mover moved.
   * @param move - the mover.
   * @returns the disposer.
   */
  register(kind: string, move: SessionHandoverMover): () => void {
    const entry = { kind, move }
    this.movers.push(entry)
    return () => {
      const index = this.movers.indexOf(entry)
      if (index >= 0) this.movers.splice(index, 1)
    }
  }

  /**
   * Move every binding of some Sessions to another Session; a failing mover is logged and reported, and the others still run.
   * @param from - Sessions whose bindings move; `to` itself is ignored.
   * @param to - Session that takes them over.
   * @returns what moved, by kind (kinds that moved nothing are left out), and which movers failed.
   */
  async handOver(from: readonly string[], to: string): Promise<SessionHandoverReport> {
    const sources: ReadonlySet<string> = new Set(from.filter(id => id !== to))
    if (sources.size === 0) return { moved: [], failed: [] }
    const moved: Array<SessionHandoverReport['moved'][number]> = []
    const failed: Array<SessionHandoverReport['failed'][number]> = []
    const subscriptions = await this.deps.subscriptions.reassignCreators(sources, to)
    if (subscriptions.length > 0) moved.push({ kind: 'subscription', items: subscriptions })
    for (const { kind, move } of [...this.movers]) {
      try {
        const items = await move(sources, to)
        if (items.length > 0) moved.push({ kind, items: [...items] })
      } catch (error: unknown) {
        this.deps.logger.warn(`event-bus: handover mover ${kind} failed: ${errorText(error)}`)
        failed.push({ kind, error: errorText(error) })
      }
    }
    this.deps.logger.info(`event-bus: handed Session(s) ${[...sources].join(', ')} over to ${to}: ${moved.length === 0 ? 'nothing to move' : moved.map(part => `${part.items.length} ${part.kind}`).join(', ')}${failed.length === 0 ? '' : `; ${failed.length} mover(s) failed`}`)
    return { moved, failed }
  }
}
