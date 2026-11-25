/**
 * Items held per Session until its turn ends, so one turn's notices go out as one message: the `./turn-queue` subpath,
 * which this plugin's audit notices and `owner-memory`'s memory notices use.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'

/** How a turn queue waits and how its cleanup is named. */
export interface TurnQueueOptions {
  /** How long a Session's items wait for its turn to end before they go anyway, in milliseconds. */
  readonly lingerMs: number
  /** Label of the effect that drops waiting items when the scope is disposed. */
  readonly label: string
}

/**
 * Hold items per Session and hand a Session's items over once, in order, when its turn ends or `lingerMs` after the
 * first one, whichever comes first. Items still waiting when `ctx` is disposed are dropped with their timers.
 * @param ctx - the scope whose `session/event` listener and cleanup carry the queue.
 * @param options - the wait and the cleanup label.
 * @param flush - receives one Session's items; it contains its own failures, since nothing awaits it.
 * @returns the function that queues one item for a Session.
 */
export function turnQueue<T>(
  ctx: Context,
  options: TurnQueueOptions,
  flush: (sessionId: string, items: T[]) => Promise<void>,
): (sessionId: string, item: T) => void {
  const queued = new Map<string, { items: T[]; timer: ReturnType<typeof setTimeout> }>()

  const release = (sessionId: string): void => {
    const entry = queued.get(sessionId)
    /* v8 ignore next -- release deletes the entry and clears its timer together. */
    if (entry === undefined) return
    queued.delete(sessionId)
    clearTimeout(entry.timer)
    void flush(sessionId, entry.items)
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end' && queued.has(session.id)) release(session.id)
  })
  ctx.effect(() => () => {
    for (const entry of queued.values()) clearTimeout(entry.timer)
    queued.clear()
  }, options.label)

  return (sessionId, item) => {
    const existing = queued.get(sessionId)
    if (existing !== undefined) {
      existing.items.push(item)
      return
    }
    const timer = setTimeout(() => { release(sessionId) }, options.lingerMs)
    timer.unref()
    queued.set(sessionId, { items: [item], timer })
  }
}
