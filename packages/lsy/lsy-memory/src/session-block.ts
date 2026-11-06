/**
 * The pre-step injection both modes share: a block of text that enters a root Session once, right after the claimed
 * prompt, as workspace instructions do. The block is an ordinary sourced `user/message`, so it replays and resumes with
 * the Session; once compaction shadows it, the next step adds a fresh one.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'

/** Source kind of the injected message, and the plugin's name. */
export const SOURCE_KIND = 'lsy-memory'

/**
 * Whether the memory message is part of what the model currently sees.
 * @param session - the Session to look in.
 * @returns whether a `lsy-memory` message is on its surface.
 */
export function memoryVisible(session: Session): boolean {
  for (const seq of session.surface.nodes) {
    // oxlint-disable-next-line typescript/no-deprecated -- Same Session history read as agent-instructions.
    const event = session.eventAt(seq)
    if (event?.type === 'user/message' && event.data.source.kind === SOURCE_KIND) return true
  }
  return false
}

/**
 * Put the block `load` returns in front of each root Session that does not show one. Subagents work for the root agent,
 * which already has the block; an empty first step owns no request, so the block waits for the next one.
 * @param ctx - the preset scope's context.
 * @param load - the block's text for a Session, or `undefined` for none; it logs its own failures.
 */
export function injectBlock(ctx: Context, load: (session: Session) => Promise<string | undefined>): void {
  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted
      || agent.session.header.origin === 'subagent'
      || (step === 1 && decision.messages.length === 0)
      || memoryVisible(agent.session)) return decision
    const text = await load(agent.session)
    if (text === undefined) return decision
    const block = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: SOURCE_KIND, form: 'instructions' },
    })
    // Right after the claimed batch: the prompt comes first.
    const lastClaimed = decision.messages.findLastIndex(message => messages.includes(message))
    return { ...decision, messages: decision.messages.toSpliced(lastClaimed + 1, 0, block) }
  })
}
