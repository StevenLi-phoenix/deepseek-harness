/** Sessions with an open turn, for the turn facts the Gmail tools read. */

import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

/** A user message source. */
export type Source = Parameters<typeof createUserMessage>[0]['source']

/** The owner's own prompt. */
export const OWNER: Source = { kind: 'user', rpcId: '5b3c0b3e-0000-4000-8000-000000000001' } as never

/** A scheduled prompt. */
export const SCHEDULE: Source = { kind: 'schedule' } as never

/**
 * A Session whose open turn holds the given messages and tool calls.
 * @param messages - source and text of each user message.
 * @param tools - names of tools called in the turn.
 * @param id - the Session id.
 * @param header - the Session header, for a working directory or a parent.
 * @returns the Session.
 */
export function openTurn(messages: ReadonlyArray<readonly [Source, string]>, tools: readonly string[] = [], id = 'chat', header?: Parameters<typeof Session.create>[2]): Session {
  const session = Session.create(SessionId(id), undefined, header)
  session.append('turn/start', { turn: 1 })
  for (const [source, text] of messages) session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source }), { surfaceOp: 'append' })
  for (const name of tools) session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId(`${name}-1`), name, arguments: '{}' })
  return session
}
