/**
 * Notice delivery: a monitor's output returns to the Session that started it as a user message, waking an idle agent and
 * loading an unloaded one on its first notice. The owner's main agent takes only summaries from other Sessions, so its
 * monitors publish an event instead, which the notification desk filters. The sweep asks the same question the other way
 * round: does the Session still exist.
 */

import { randomUUID } from 'node:crypto'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { errorText } from './error-text.ts'
import { noticeText, type MonitorNotice, type MonitorView } from './monitor.ts'

/** The part of an agent that delivery drives. */
export type DeliveryAgent = Pick<Agent, 'status' | 'followup' | 'inject'>

/** The context services delivery reads; the preset scope's `Context` provides all of them. */
export interface DeliveryContext {
  readonly logger: Pick<Context['logger'], 'info' | 'warn'>
  /** Only the `agents` service is read: the loaded agent of a Session, if any. */
  readonly get: (name: 'agents') => { get: (id: SessionId) => DeliveryAgent | undefined } | undefined
  readonly sessionPersistence: {
    /** The stored header of a Session, or undefined when persistence has none. */
    readonly stat: (id: SessionId) => Promise<{ readonly header: { readonly origin?: string } } | undefined>
  }
  readonly sessionController: {
    /** Loads the Session's agent, or answers with an error whose `code` is `session/not-found` when it is gone. */
    readonly resolveAgent: (
      id: SessionId,
    ) => Promise<{ readonly error: { readonly code: string; readonly message?: string } } | { readonly agent: DeliveryAgent }>
  }
}

/** Source kind of monitor notices, and the plugin's name. */
export const SOURCE_KIND = 'fork-tool-monitor'

/** One notice as an event on the bus. */
export interface MonitorEvent {
  readonly source: 'monitor'
  readonly kind: 'monitor.output' | 'monitor.ended'
  readonly key: string
  readonly subject: string
  readonly title: string
  readonly text: string
}

/** Where the notices of the owner's main agent go instead of its Session. */
export interface MonitorDesk {
  /** Whether this Session is the owner's main agent. */
  readonly isMainAgent: (owner: string) => boolean
  /** Publish on the event bus; rejects when the bus cannot take it. */
  readonly publish: (event: MonitorEvent) => Promise<unknown>
}

/** The delivery functions the registry, the store, and the sweep call. */
export interface Delivery {
  /** Whether a Session whose agent is not loaded still takes notices; rejects when persistence cannot tell. */
  readonly reachable: (owner: string) => Promise<boolean>
  /** The registry's delivery: at once for a loaded agent, queued per owner otherwise; false only when the Session is gone. */
  readonly deliver: (owner: string, monitor: MonitorView, notice: MonitorNotice) => boolean | Promise<boolean>
  /** A loaded agent is alive; otherwise Session persistence decides, and a failed lookup is no answer. */
  readonly alive: (owner: string) => Promise<boolean>
}

/**
 * Build the delivery functions.
 * @param ctx - the preset scope's context, or anything that serves the services listed in {@link DeliveryContext}.
 * @param stopped - whether disposal has begun: nothing is delivered or swept after that.
 * @param desk - where the main agent's notices go; without it every notice goes to its Session.
 * @returns the functions.
 */
export function createDelivery(ctx: DeliveryContext, stopped: () => boolean, desk?: MonitorDesk): Delivery {
  /** Notices of owners whose agent is loading, in order. */
  const pending = new Map<string, Promise<boolean>>()

  const send = (agent: DeliveryAgent, owner: string, monitor: MonitorView, notice: MonitorNotice): void => {
    const message = createUserMessage({
      content: [{ type: 'text', text: noticeText(monitor, notice) }],
      source: {
        kind: SOURCE_KIND,
        form: 'notice',
        summary: notice.kind === 'ended' ? `monitor ${monitor.id} ended` : `monitor ${monitor.id}: ${String(notice.lines.length + notice.dropped)} line(s)`,
      },
    })
    // Same delivery as background-job completions: an idle agent is woken, a busy one reads it next step.
    if (agent.status === 'idle') agent.followup(message)
    else agent.inject(message)
    ctx.logger.info('monitor %s → session %s: %s', monitor.id, owner, notice.kind === 'ended' ? `ended (${notice.reason})` : `${String(notice.lines.length + notice.dropped)} line(s)`)
  }

  const toDesk = async (target: MonitorDesk, monitor: MonitorView, notice: MonitorNotice): Promise<boolean> => {
    const ended = notice.kind === 'ended'
    try {
      await target.publish({
        source: 'monitor',
        kind: ended ? 'monitor.ended' : 'monitor.output',
        key: `${monitor.id}:${randomUUID()}`,
        subject: monitor.id,
        title: `Monitor ${monitor.id} (${monitor.description}): ${ended ? `ended, ${notice.reason}` : `${String(notice.lines.length + notice.dropped)} line(s)`}`,
        text: noticeText(monitor, notice),
      })
      ctx.logger.info('monitor %s → notification desk: %s', monitor.id, notice.kind)
    } catch (error: unknown) {
      // Never into the main agent's Session instead: the monitor keeps running and the next notice tries again.
      ctx.logger.warn('monitor %s: the event bus did not take a notice, dropped it: %s', monitor.id, errorText(error))
    }
    return true
  }

  const loadedAgent = (owner: string): DeliveryAgent | undefined => ctx.get('agents')?.get(owner as SessionId)

  /**
   * Whether a Session whose agent is not loaded still takes notices: Session
   * persistence has it, and it is not a subagent's, which only its parent's
   * subagent runtime resumes. Rejects when persistence cannot tell.
   */
  const reachable = async (owner: string): Promise<boolean> => {
    const stored = await ctx.sessionPersistence.stat(owner as SessionId)
    return stored !== undefined && stored.header.origin !== 'subagent'
  }

  /** Load the owner's agent if needed and send; false only when the Session is definitely gone. */
  const resolveAndSend = async (owner: string, monitor: MonitorView, notice: MonitorNotice): Promise<boolean> => {
    try {
      if (stopped()) return true
      let agent = loadedAgent(owner)
      if (agent === undefined) {
        if (!await reachable(owner)) return false
        const resolved = await ctx.sessionController.resolveAgent(owner as SessionId)
        if ('error' in resolved) {
          if (resolved.error.code === 'session/not-found') return false
          const { error } = resolved
          throw error instanceof Error ? error : new Error(error.message ?? error.code)
        }
        agent = resolved.agent
      }
      if (!stopped()) send(agent, owner, monitor, notice)
    } catch (error: unknown) {
      // Busy, held by another writer, or failing to resume: the Session exists, so the monitor keeps running.
      ctx.logger.warn('monitor %s: session %s cannot take a notice now, dropped it: %s', monitor.id, owner, errorText(error))
    }
    return true
  }

  const deliver = (owner: string, monitor: MonitorView, notice: MonitorNotice): boolean | Promise<boolean> => {
    if (desk?.isMainAgent(owner) === true) return toDesk(desk, monitor, notice)
    const agent = loadedAgent(owner)
    if (agent !== undefined && !pending.has(owner)) {
      send(agent, owner, monitor, notice)
      return true
    }
    // After a restart the owner's agent loads on its first notice; later notices wait their turn.
    const queued = (pending.get(owner) ?? Promise.resolve(true)).then(() => resolveAndSend(owner, monitor, notice))
    pending.set(owner, queued)
    void queued.then(() => { if (pending.get(owner) === queued) pending.delete(owner) })
    return queued
  }

  /** A loaded agent is alive; otherwise Session persistence decides, and a failed lookup is no answer. */
  const alive = async (owner: string): Promise<boolean> => {
    if (stopped() || loadedAgent(owner) !== undefined) return true
    try {
      return await reachable(owner)
    } catch (error: unknown) {
      ctx.logger.warn('monitor sweep: cannot tell whether session %s exists: %s', owner, errorText(error))
      return true
    }
  }

  return { reachable, deliver, alive }
}
