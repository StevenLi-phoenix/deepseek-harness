/**
 * Who a turn's incoming input is from, how long the Session was quiet before it, and the notice the
 * model reads about that. Everything here reads durable message sources and Session times, never
 * message text, so the words of an incoming message cannot change what the notice says about it.
 */

import { UNTRUSTED_REQUEST_PREFIX } from '@deepseek-ai/dsh-fork-taint'
import { formatGap, formatStamp } from './format.ts'

/**
 * What arrived: a message from the owner, a message from someone else (`sender`), a bus or webhook
 * event, or a reminder the schedule service delivered.
 */
export type Arrival = 'owner' | 'sender' | 'event' | 'reminder'

/** The kind of input a message source carries; context the Host or a plugin adds has none. */
export type IncomingKind = 'message' | 'event' | 'reminder'

/** The two times a gap is measured from, folded from the Session log; null before the first one. */
export interface Activity {
  /** Time of the latest incoming message, event, or reminder. */
  readonly lastIncomingAt: number | null
  /** Time of the latest assistant message. */
  readonly lastReplyAt: number | null
}

/** A quiet spell long enough for a notice. */
export interface Gap {
  /** Milliseconds between the last activity and now. */
  readonly gapMs: number
  /** When the last activity was. */
  readonly lastAt: number
  /** Whether the last activity was the assistant's reply or an incoming input that got none. */
  readonly last: 'reply' | 'incoming'
}

/**
 * The input kind of one durable user-message source.
 * @param source - the message's `source`.
 * @returns `message` for a prompt (`user`), `event` for a webhook or bus batch (`webhook`) or monitor
 * output (`fork-tool-monitor`), `reminder` for a schedule delivery (`schedule`), or undefined for
 * injected context (instructions, snapshots, notices of other plugins, this plugin's own notices).
 */
export function incomingKind(source: { readonly kind: string }): IncomingKind | undefined {
  switch (source.kind) {
    case 'user': return 'message'
    case 'webhook':
    case 'fork-tool-monitor': return 'event'
    case 'schedule': return 'reminder'
    default: return undefined
  }
}

/**
 * Who an incoming input is from. A prompt is the owner's unless its source names a principal (a guest),
 * its request id carries fork-taint's untrusted prefix (another Session passing a message on), or the
 * Session's preset is one whose prompts carry other people's words (a channel bot such as `qqbot`).
 * @param source - the message's `source`.
 * @param agentPreset - the Session's preset, from its header.
 * @param senderPresets - presets whose prompts are on someone else's behalf.
 * @returns the arrival, or undefined for injected context.
 */
export function classifyArrival(
  source: { readonly kind: string; readonly rpcId?: unknown; readonly principal?: unknown },
  agentPreset: string | undefined,
  senderPresets: ReadonlySet<string>,
): Arrival | undefined {
  const kind = incomingKind(source)
  if (kind === undefined) return undefined
  if (kind !== 'message') return kind
  if (source.principal !== undefined) return 'sender'
  if (typeof source.rpcId === 'string' && source.rpcId.startsWith(UNTRUSTED_REQUEST_PREFIX)) return 'sender'
  if (agentPreset !== undefined && senderPresets.has(agentPreset)) return 'sender'
  return 'owner'
}

/**
 * The quiet spell before `now`, measured from the later of the last reply and the last incoming input.
 * @param now - Unix epoch milliseconds of the new input's turn.
 * @param activity - the Session's last times.
 * @param thresholdMs - shortest spell that counts.
 * @returns the gap, or undefined for a Session with no earlier activity or a shorter spell.
 */
export function measureGap(now: number, activity: Activity, thresholdMs: number): Gap | undefined {
  const reply = activity.lastReplyAt ?? -Infinity
  const incoming = activity.lastIncomingAt ?? -Infinity
  const lastAt = Math.max(reply, incoming)
  if (!Number.isFinite(lastAt) || now - lastAt < thresholdMs) return undefined
  return { gapMs: now - lastAt, lastAt, last: reply >= incoming ? 'reply' : 'incoming' }
}

const HEAD: Readonly<Record<Arrival, string>> = {
  owner: 'Time check: the owner sent the message below at',
  sender: 'Time check: the sender sent the message below at',
  event: 'Time check: this event arrived at',
  reminder: 'Time check: this reminder arrived at',
}

const MESSAGE_TAIL = ' Read the message on its own terms: it starts a new exchange unless it clearly refers back to something earlier.'
  + ' Things outside this conversation (files, processes, services, accounts, other people\'s messages) may have changed since then; check again before relying on what you saw earlier.'
const DELIVERY_TAIL = ' Treat it as arriving now, not as part of the last exchange: what it concerns may have changed since then, so check the current state before acting on it.'

const TAIL: Readonly<Record<Arrival, string>> = { owner: MESSAGE_TAIL, sender: MESSAGE_TAIL, event: DELIVERY_TAIL, reminder: DELIVERY_TAIL }

/**
 * The notice the model reads just before an input that ends a quiet spell.
 * @param arrival - who or what the input is.
 * @param now - Unix epoch milliseconds of its turn.
 * @param gap - the quiet spell before it.
 * @param timeZone - IANA zone for the times.
 * @returns the notice text.
 */
export function timeGapNotice(arrival: Arrival, now: number, gap: Gap, timeZone: string): string {
  const previous = gap.last === 'reply'
    ? `your own reply, at ${formatStamp(gap.lastAt, timeZone)}`
    : `an earlier input that got no reply, at ${formatStamp(gap.lastAt, timeZone)}`
  return `${HEAD[arrival]} ${formatStamp(now, timeZone)} (${timeZone}), after ${formatGap(gap.gapMs)} of silence in this Session.`
    + ` Before it, the last exchange here was ${previous}.${TAIL[arrival]}`
}

/**
 * The collapsed row's one-line account of a notice.
 * @param gap - the quiet spell.
 * @returns e.g. `Time check: 3 h 5 min since the last exchange`.
 */
export function timeGapSummary(gap: Gap): string {
  return `Time check: ${formatGap(gap.gapMs)} since the last exchange`
}
