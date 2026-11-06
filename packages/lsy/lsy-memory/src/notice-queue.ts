/**
 * Owner notices about protected memory writes: queued per Session until its turn ends (so one turn's changes merge into
 * one message), capped per day, and sent through the `lsyNotifier` service when one is mounted.
 */

import type { Context } from '@deepseek-ai/cordis'
import { memoryNotice, type NoticeItem } from './notice.ts'

/** Seconds a turn's notices wait for the turn to end before they go anyway. */
export const NOTICE_LINGER_MS = 5 * 60_000

/** Notice settings from the plugin configuration. */
export interface NoticeOptions {
  /** Whether notices go out at all. */
  readonly notify: boolean
  /** Notices the owner gets in a day. */
  readonly noticesPerDay: number
}

/** Queue one change for the Session's turn notice; a no-op when notices are off or the call has no Session. */
export type Enqueue = (sessionId: string | undefined, item: NoticeItem) => void

/**
 * Mount the notice queue: the turn-end flush and the cleanup of waiting timers.
 * @param ctx - the preset scope's context.
 * @param options - `notify` turns notices on; `noticesPerDay` caps those sent per day.
 * @returns the enqueue function the tools call.
 */
export function mountNotices(ctx: Context, options: NoticeOptions): Enqueue {
  const { notify, noticesPerDay } = options
  /** Notices queued per Session until its turn ends, and how many went out today. */
  const queued = new Map<string, { items: NoticeItem[]; timer: ReturnType<typeof setTimeout> }>()
  let sentToday = { day: '', count: 0 }

  const flush = async (sessionId: string): Promise<void> => {
    const entry = queued.get(sessionId)
    if (entry === undefined) return
    queued.delete(sessionId)
    clearTimeout(entry.timer)
    const day = new Date().toDateString()
    if (sentToday.day !== day) sentToday = { day, count: 0 }
    if (sentToday.count >= noticesPerDay) {
      ctx.logger.info('memory notice skipped for session %s: %d notices already went out today (%d change(s) are in the history)', sessionId, sentToday.count, entry.items.length)
      return
    }
    const notifier = ctx.get('lsyNotifier')
    if (notifier === undefined) {
      ctx.logger.info('memory notice for session %s has no channel: %d change(s) are in the history', sessionId, entry.items.length)
      return
    }
    sentToday.count += 1
    const note = memoryNotice(entry.items)
    try {
      await notifier.send({ title: note.title, ...note.body === undefined ? {} : { body: note.body }, safety: true, origin: 'the memory tool of your own Session (a notice to the owner about memory it wrote)' })
      ctx.logger.info('memory notice sent for session %s: %d change(s), %d held', sessionId, entry.items.length, entry.items.filter(item => item.kind === 'held').length)
    } catch (error: unknown) {
      ctx.logger.warn('memory notice for session %s failed: %s', sessionId, error instanceof Error ? error.message : String(error))
    }
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end' && queued.has(session.id)) void flush(session.id)
  })
  ctx.effect(() => () => {
    for (const entry of queued.values()) clearTimeout(entry.timer)
    queued.clear()
  }, 'lsy-memory: drop queued notices')

  return (sessionId, item) => {
    if (!notify || sessionId === undefined) return
    const existing = queued.get(sessionId)
    if (existing !== undefined) {
      existing.items.push(item)
      return
    }
    const timer = setTimeout(() => { void flush(sessionId) }, NOTICE_LINGER_MS)
    timer.unref()
    queued.set(sessionId, { items: [item], timer })
  }
}
