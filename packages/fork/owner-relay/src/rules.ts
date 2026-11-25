/** Pure rules of the relay: the text of an assistant message, what a turn's end sends the owner, and the fallback note. */
import { type OwnerNote } from '@deepseek-ai/dsh-event-bus'
import { failureDetail, isSilentReply } from '@deepseek-ai/dsh-event-bus/prompt'

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
  /** The turn's separate assistant messages, in order, when it wrote more than one (`text` is them joined). */
  readonly parts?: readonly string[] | undefined
}

/** What the end of a turn sends the owner. */
export type RelayDecision =
  /** The owner stopped the turn (WeChat `/stop` or the Web UI's stop): they know, so nothing is sent. */
  | { readonly kind: 'stopped' }
  /** The final answer, or its last line, is exactly `NO_REPLY`. */
  | { readonly kind: 'silent' }
  /** A completed turn without assistant text. */
  | { readonly kind: 'empty' }
  /** Something to send. */
  | { readonly kind: 'answer'; readonly text: string; readonly outcome: string; readonly detail?: string; readonly parts?: readonly string[] }

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
 * @returns true when the turn was aborted by the user.
 */
export function stoppedByOwner(reason: TurnEndFacts): boolean {
  return reason.kind === 'aborted' && reason.reason?.kind === 'user'
}

/**
 * The one rule set for every channel: what the end of a turn sends the owner.
 * Every assistant message of the turn that has text reaches the owner, in order (`text` joins them with a blank line,
 * `parts` keeps them apart for a channel that sends one message each); a message that answers `NO_REPLY` is left
 * out, so a report followed by `NO_REPLY` still goes out.
 * @param texts - the turn's assistant message texts, oldest first.
 * @param reason - how the turn ended.
 * @returns nothing (and why), or the message with the turn's outcome and failure reason.
 */
export function decideRelay(texts: readonly string[], reason: TurnEndFacts): RelayDecision {
  if (stoppedByOwner(reason)) return { kind: 'stopped' }
  const parts = texts.filter(part => !isSilentReply(part))
  if (texts.length > 0 && parts.length === 0) return { kind: 'silent' }
  const text = parts.length === 0 ? undefined : parts.join('\n\n')
  const outcome = reason.kind
  if (outcome === 'completed') {
    return text === undefined ? { kind: 'empty' } : { kind: 'answer', text, outcome, ...(parts.length > 1 ? { parts } : {}) }
  }
  const detail = failureDetail(reason)
  const warning = detail === undefined ? `⚠️ 本轮未完成（${outcome}）` : `⚠️ 本轮未完成（${outcome}）\n原因：${detail}`
  // The warning goes under the last message, so a channel that sends the messages one by one adds no extra one.
  const sent = parts.length === 0 ? [warning] : [...parts.slice(0, -1), `${parts.at(-1)}\n\n${warning}`]
  return {
    kind: 'answer',
    text: sent.join('\n\n'),
    outcome,
    ...(detail === undefined ? {} : { detail }),
    ...(sent.length > 1 ? { parts: sent } : {}),
  }
}

/**
 * The note an undelivered answer becomes when it goes to the notifier instead.
 * @param answer - the answer the channel could not deliver.
 * @param why - why it could not.
 * @param origin - the channel's fallback label: who sent it, as the owner's chat Session reads it.
 * @returns a note with the answer text and the reason.
 */
export function relayFallbackNote(answer: RelayAnswer, why: string, origin: string): OwnerNote {
  return { title: RELAY_FALLBACK_TITLE, body: `${answer.text}\n\n原因：${why}`, origin }
}
