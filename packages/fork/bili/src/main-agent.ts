/**
 * Messages from the account's Session to the owner's main agent (`bili_tell_main_agent`): the
 * WeChat channel queues each one in the owner's chat Session as untrusted data. Bounded per local
 * day; only messages that were queued count, and the stored rows keep no text.
 */
// Type-only: the ctx.ownerNotifier contract.
import type { OwnerNotifier } from '@deepseek-ai/dsh-event-bus'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { errorText } from './client.ts'
import { BILI_AGENT_ORIGIN } from './dm.ts'
import { seqKey, type biliDomain } from './storage.ts'
import { MAIN_AGENT_MAX_CHARS, codePoints } from './text.ts'
import { dayKey } from './time.ts'
import type { WriteOutcome } from './writes.ts'

/** What the main-agent line needs of the account. */
export interface MainAgentHost {
  readonly ready: Promise<Domain<typeof biliDomain>>
  /** Storage work, one piece at a time. */
  serialize<T>(work: () => Promise<T>): Promise<T>
  /** IANA time zone of the daily limit. */
  readonly timeZone: string
  /** Messages allowed per day; 0 turns them off. */
  readonly perDay: number
  /** The WeChat notifier, read per use. */
  notifier(): Pick<OwnerNotifier, 'tellMainAgent'> | undefined
  logger: { info(message: string): void; warn(message: string): void }
}

/**
 * Send one message to the owner's main agent; the main agent answers the owner on WeChat in a turn of its own.
 * @param host - storage, the time zone, the daily limit, the notifier, and the logger.
 * @param text - at most {@link MAIN_AGENT_MAX_CHARS} characters.
 * @returns `sent` with what is left today, or `refused` with the reason.
 */
export async function tellMainAgent(host: MainAgentHost, text: string): Promise<WriteOutcome> {
  const message = text.trim()
  if (message === '') return { outcome: 'refused', detail: 'the message is empty' }
  const chars = codePoints(message)
  if (chars > MAIN_AGENT_MAX_CHARS) return { outcome: 'refused', detail: `the message is ${chars} characters; the limit is ${MAIN_AGENT_MAX_CHARS}` }
  return host.serialize(async (): Promise<WriteOutcome> => {
    const domain = await host.ready
    const now = Date.now()
    const day = dayKey(now, host.timeZone)
    const rows = [...domain.table('told').entries()].map(([, row]) => row)
    // Only today's messages count, so earlier days' rows go.
    for (const row of rows.filter(row => row.day !== day)) await domain.table('told').delete(seqKey(row.seq))
    const kept = rows.filter(row => row.day === day)
    const today = kept.length
    const perDay = host.perDay
    if (today >= perDay) return { outcome: 'refused', detail: `today's ${perDay} message(s) to the main agent are used up` }
    const notifier = host.notifier()
    if (notifier?.tellMainAgent === undefined) return { outcome: 'refused', detail: 'the owner\'s WeChat channel is not running, so the main agent cannot be reached' }
    let sessionId: string
    try {
      sessionId = await notifier.tellMainAgent({ text: message, from: BILI_AGENT_ORIGIN, origin: 'bili' })
    } catch (error: unknown) {
      host.logger.warn(`bili: the message to the main agent did not go out: ${errorText(error)}`)
      return { outcome: 'refused', detail: `the main agent could not take it: ${errorText(error)}` }
    }
    const seq = Math.max(0, ...kept.map(row => row.seq)) + 1
    await domain.table('told').put(seqKey(seq), { seq, day, at: now, chars, sessionId })
    host.logger.info(`bili: told the main agent ${chars} chars in chat Session ${sessionId} (${today + 1}/${perDay} today)`)
    const left = perDay - today - 1
    return { outcome: 'sent', detail: `the main agent got it and takes it up in a turn of its own; its answer goes to the owner on WeChat, not to you. ${left} left today.` }
  })
}
