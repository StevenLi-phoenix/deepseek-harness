/**
 * The monitor store behind the registry: what starts again after a host restart. Writes run one after another in call
 * order, once the stored monitors are restored; a store that is held elsewhere or fails to open leaves the monitors
 * working but not restored.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { errorText } from './error-text.ts'
import type { MonitorRegistry } from './monitor.ts'
import { monitorDomain, type MonitorRecord } from './storage.ts'

type MonitorDomain = Domain<typeof monitorDomain>

/** What restoring asks of the delivery side. */
interface RestoreDeps {
  readonly reachable: (owner: string) => Promise<boolean>
  readonly stopped: () => boolean
}

/** Start every stored monitor again, silently: same id, command, directory, and deadline, a freshly scrubbed environment. */
async function restore(ctx: Context, domain: MonitorDomain, registry: MonitorRegistry, { reachable, stopped }: RestoreDeps): Promise<void> {
  const table = domain.table('monitors')
  for (const [id, record] of [...table.entries()]) {
    let dropped: string | undefined
    if (record.deadline !== undefined && record.deadline <= Date.now()) dropped = 'its deadline passed'
    else {
      try {
        if (!await reachable(record.owner)) dropped = 'its session is gone'
      } catch (error: unknown) {
        // Only a definite answer drops a monitor; delivery and the sweep ask again.
        ctx.logger.warn('monitor %s: cannot tell whether session %s exists, restoring it: %s', id, record.owner, errorText(error))
      }
    }
    if (stopped()) return
    if (dropped === undefined) {
      try {
        registry.restore({
          id,
          owner: record.owner,
          command: record.command,
          description: record.description,
          cwd: record.cwd,
          startedAt: record.startedAt,
          ...record.deadline === undefined ? {} : { deadline: record.deadline },
          // Same scrubbing as the bash tool, read again now: nothing of the environment is stored.
          env: scrubbedParentEnv(),
        })
        const left = record.deadline === undefined ? 0 : Math.ceil((record.deadline - Date.now()) / 60_000)
        ctx.logger.info('monitor %s restored for session %s: %s (%s)', id, record.owner, record.description,
          record.deadline === undefined ? 'persistent' : `${String(left)} minute${left === 1 ? '' : 's'} left`)
        continue
      } catch (error: unknown) {
        dropped = errorText(error)
      }
    }
    ctx.logger.info('monitor %s of session %s dropped: %s', id, record.owner, dropped)
    try {
      await table.delete(id)
    } catch (error: unknown) {
      ctx.logger.warn('monitor store: could not forget monitor %s: %s', id, errorText(error))
    }
  }
}

/** The monitor domain, opened once and written in order. */
export class MonitorStorage {
  /** Undefined when another instance of this plugin holds the store, or it failed to open. */
  private readonly opened: Promise<MonitorDomain | undefined>
  /** Resolves once the stored monitors are running again; before `restoreInto` it is the open store. */
  private ready: Promise<MonitorDomain | undefined>
  /** Writes in call order, once the stored monitors are restored. */
  private writes: Promise<unknown> = Promise.resolve()

  constructor(private readonly ctx: Context, private readonly deps: RestoreDeps) {
    this.opened = ctx.storageDomain.open(monitorDomain).then(domain => domain, (error: unknown) => {
      if ((error as { code?: unknown }).code === 'already-open') {
        ctx.logger.warn('monitor store is held by another fork-tool-monitor instance; monitors started through this preset are not restored after a host restart')
      } else {
        ctx.logger.warn('monitor store did not open, so monitors are not restored after a host restart: %s', errorText(error))
      }
      return undefined
    })
    this.ready = this.opened
  }

  /**
   * Start every stored monitor again in the registry, then let the queued writes through.
   * @param registry - the registry to start them in.
   */
  restoreInto(registry: MonitorRegistry): void {
    this.ready = this.opened.then(async (domain) => {
      if (domain === undefined) return undefined
      try {
        await restore(this.ctx, domain, registry, this.deps)
      } catch (error: unknown) {
        this.ctx.logger.warn('monitor store: restoring stopped early: %s', errorText(error))
      }
      return domain
    })
  }

  /** Store a monitor that just started. */
  save(id: string, record: MonitorRecord): void {
    this.write(`save monitor ${id}`, domain => domain.table('monitors').put(id, record))
  }

  /** Forget a monitor that ended. */
  forget(id: string): void {
    this.write(`forget monitor ${id}`, domain => domain.table('monitors').delete(id))
  }

  /** Point a monitor at the Session its conversation moved to. */
  moveTo(id: string, owner: string): void {
    this.write(`move monitor ${id}`, async (domain) => {
      const table = domain.table('monitors')
      const record = table.get(id)
      if (record !== undefined) await table.put(id, { ...record, owner })
    })
  }

  /** Finish the queued writes and close the store; the records stay for the next host start. */
  async close(): Promise<void> {
    const domain = await this.ready
    await this.writes
    await domain?.close()
  }

  private write(what: string, operation: (domain: MonitorDomain) => Promise<unknown>): void {
    this.writes = this.writes.then(async () => {
      const domain = await this.ready
      if (domain !== undefined) await operation(domain)
    }).catch((error: unknown) => { this.ctx.logger.warn('monitor store: could not %s: %s', what, errorText(error)) })
  }
}
