/** Pure rules of the relay: the text of an assistant message, what a turn's end sends the owner, and the fallback note. */
import { failureDetail, isSilentReply, type LsyNote } from '@deepseek-ai/dsh-lsy-event-bus'

/** The fields of a `TurnEndReason` the rules read. */
export interface TurnEndFacts {
  /** `TurnEndReason.kind`, e.g. `completed`, `aborted`, or `error`. */
  readonly kind: string
  /** Present on `aborted`: the cancellation cause, `user` when the owner stopped the turn. */
  readonly reason?: { readonly kind: string } | undefined
  /** Present on `error`: the structured failure. */
  readonly error?: { readonly code: string; readonly message: string } | undefined
}

/** A turn's answer, as the relay hands it to the channel that claimed the Session. */
export interface RelayAnswer {
  /** Session whose turn ended. */
  readonly sessionId: string
  /** What the owner gets: the final assistant text, with a warning line under it when the turn did not complete. */
  readonly text: string
  /** `TurnEndReason.kind` of the turn. */
  readonly outcome: string
  /** One-line reason of a failed turn (`failureDetail`), when there is one. */
  readonly detail?: string | undefined
}

/** What the end of a turn sends the owner. */
export type RelayDecision =
  /** The owner stopped the turn (WeChat `/stop` or the Web UI's stop): they know, so nothing is sent. */
  | { readonly kind: 'stopped' }
  /** The final answer is exactly `NO_REPLY`. */
  | { readonly kind: 'silent' }
  /** A completed turn without assistant text. */
  | { readonly kind: 'empty' }
  /** Something to send. */
  | { readonly kind: 'answer'; readonly text: string; readonly outcome: string; readonly detail?: string }

/** Title of an answer a channel could not deliver, sent through the notifier instead. */
export const RELAY_FALLBACK_TITLE = '↪️ 这条回答没能从原渠道发出，改发这里'

/**
 * Concatenated text parts of one message content.
 * @param content - content parts of an assistant message.
 * @returns the joined, trimmed text, or undefined when it has none.
 */
export function contentText(content: readonly unknown[]): string | undefined {
  const text = content
    .filter((part): part is { type: 'text'; text: string } => typeof part === 'object' && part !== null
      && 'type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
    .trim()
  return text === '' ? undefined : text
}

/**
 * Whether the owner stopped the turn: it was aborted with cancellation cause `user`.
 * @param reason - how the turn ended.
 */
export function stoppedByOwner(reason: TurnEndFacts): boolean {
  return reason.kind === 'aborted' && reason.reason?.kind === 'user'
}

/**
 * The one rule set for every channel: what the end of a turn sends the owner.
 * @param text - the turn's latest assistant text, if any.
 * @param reason - how the turn ended.
 * @returns nothing (and why), or the message with the turn's outcome and failure reason.
 */
export function decideRelay(text: string | undefined, reason: TurnEndFacts): RelayDecision {
  if (stoppedByOwner(reason)) return { kind: 'stopped' }
  if (isSilentReply(text)) return { kind: 'silent' }
  const outcome = reason.kind
  if (outcome === 'completed') return text === undefined ? { kind: 'empty' } : { kind: 'answer', text, outcome }
  const detail = failureDetail(reason)
  const warning = detail === undefined ? `⚠️ 本轮未完成（${outcome}）` : `⚠️ 本轮未完成（${outcome}）\n原因：${detail}`
  return {
    kind: 'answer',
    text: text === undefined ? warning : `${text}\n\n${warning}`,
    outcome,
    ...(detail === undefined ? {} : { detail }),
  }
}

/**
 * The note an undelivered answer becomes when it goes to the notifier instead.
 * @param answer - the answer the channel could not deliver.
 * @param why - why it could not.
 * @param origin - the channel's fallback label: who sent it, as the owner's chat Session reads it.
 */
export function relayFallbackNote(answer: RelayAnswer, why: string, origin: string): LsyNote {
  return { title: RELAY_FALLBACK_TITLE, body: `${answer.text}\n\n原因：${why}`, origin }
}
