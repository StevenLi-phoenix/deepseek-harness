/**
 * The facts of the turn a Gmail tool runs in, read from the Session log by `fork-taint`: whether the owner started it
 * alone with no strangers' words read in it, its origin label, and the owner's own words. The model supplies none of
 * them.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TurnFacts } from '@deepseek-ai/dsh-fork-gmail'
import { describeOrigin, ownerWords, turnOrigin } from '@deepseek-ai/dsh-fork-taint'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'

/**
 * Read the turn's facts.
 * @param ctx - the preset scope's context, for the Session registry (a subagent inherits its parent's origin).
 * @param session - the calling Agent's Session; undefined outside any Agent.
 * @returns the facts; outside an Agent the turn is not clean and holds no owner words.
 */
export function turnFacts(ctx: Context, session: Session | undefined): TurnFacts {
  if (session === undefined) return { clean: false, origin: 'unknown', ownerText: [] }
  const sessions = ctx.get('sessions')
  const origin = turnOrigin(session, { parent: id => sessions?.get(id as SessionId) })
  return {
    clean: origin.clean,
    origin: describeOrigin(origin),
    ownerText: origin.owner ? ownerWords(session) : [],
    sessionId: session.header.id,
  }
}
