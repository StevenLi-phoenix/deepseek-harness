/**
 * `ctx.biliEvidence`: the verifier the persistent Session's collectors ask which comments are real. It reads comment threads from
 * bili-svc on a cache miss, drops the creator's own accounts, and hands back sender keys instead of user ids.
 */

import type { Context } from '@deepseek-ai/cordis'
import { BiliSvc } from './bili-svc.ts'
import {
  BiliEvidenceRefusedError, commentsOf, defaultSaltFile, loadSalt, ownMidsOf, senderKey,
  type BiliEvidence, type BiliEvidenceItem, type CommentCache,
} from './evidence.ts'
import type { SessionGate } from './session-gate.ts'
import { errorText } from './values.ts'

/** How long the creator's own account ids from `/v1/status` are trusted before they are read again. */
const OWN_MIDS_TTL_MS = 10 * 60_000

/** The creator's own account ids, learned from `/v1/status`. */
export class OwnAccounts {
  private mids = new Set<number>()
  private at = 0

  /**
   * Take the ids out of a `/v1/status` answer; an answer without any leaves what was known.
   * @param body - the answer's body.
   */
  learn(body: unknown): void {
    const mids = ownMidsOf(body)
    if (mids.length === 0) return
    this.mids = new Set(mids)
    this.at = Date.now()
  }

  /**
   * Check whether the ids are recent enough to trust.
   * @returns whether the ids were read within the TTL.
   */
  fresh(): boolean {
    return this.at > 0 && Date.now() - this.at < OWN_MIDS_TTL_MS
  }

  /**
   * Check whether any ids were ever read.
   * @returns whether the ids have ever been read, however long ago.
   */
  known(): boolean {
    return this.at > 0
  }

  /**
   * Whether an id is one of the creator's own.
   * @param mid - the account id.
   * @returns true for the creator's own.
   */
  has(mid: number): boolean {
    return this.mids.has(mid)
  }
}

/** What the verifier works with. */
export interface EvidenceDeps {
  ctx: Context
  /** Where the salt and the per-call id limit are set. */
  config: { evidence: { saltFile?: string; maxIds: number }; callsPerTurn: number }
  svc: BiliSvc
  /** The rpid cache the reads fill. */
  comments: CommentCache
  own: OwnAccounts
  gate: SessionGate
}

/**
 * Build the verifier.
 * @param deps - the context, configuration, bili-svc client, caches, and gate.
 * @returns `ctx.biliEvidence`.
 */
export function createEvidence(deps: EvidenceDeps): BiliEvidence {
  const { ctx, config, svc, comments, own, gate } = deps
  let salt: Promise<string> | undefined
  /** Make sure the creator's own ids are known; false when bili-svc cannot say, so nothing can be kept. */
  const ownKnown = async (): Promise<boolean> => {
    if (own.fresh()) return true
    try {
      const answer = await svc.get('/v1/status')
      if (answer.status === 200) own.learn(answer.body)
    } catch (error: unknown) {
      ctx.logger.warn(`lsy-tool-up: /v1/status for the evidence check failed: ${errorText(error)}`)
    }
    return own.known()
  }
  return {
    async evidenceOf(ids, caller): Promise<BiliEvidenceItem[]> {
      const refused = gate.refusal(caller.sessionId)
      if (refused !== undefined) {
        ctx.logger.info(`lsy-tool-up: evidence refused for Session ${caller.sessionId}: ${refused}`)
        throw new BiliEvidenceRefusedError('not_persistent_session', refused)
      }
      if (!gate.take(caller.sessionId, 'evidence')) {
        ctx.logger.info(`lsy-tool-up: evidence refused for Session ${caller.sessionId}: ${config.callsPerTurn} calls this turn already`)
        throw new BiliEvidenceRefusedError('turn_cap', `at most ${config.callsPerTurn} evidence calls per turn`)
      }
      const wanted = [...new Set(ids.filter(id => /^[1-9]\d{0,18}$/.test(id)))].slice(0, config.evidence.maxIds).map(Number)
      salt ??= loadSalt(config.evidence.saltFile ?? defaultSaltFile())
      const key = await salt
      const known = await ownKnown()
      const found: BiliEvidenceItem[] = []
      let read = 0
      for (const rpid of wanted) {
        if (comments.get(rpid) === undefined) {
          read += 1
          try {
            const answer = await svc.get(`/v1/comments/${rpid}/thread`)
            if (answer.status === 200) comments.put(commentsOf(answer.body))
          } catch (error: unknown) {
            ctx.logger.warn(`lsy-tool-up: evidence read of comment ${rpid} failed: ${errorText(error)}`)
          }
        }
        const comment = comments.get(rpid)
        if (comment === undefined || !known || own.has(comment.mid)) continue
        found.push({ id: String(rpid), senderKey: senderKey(key, comment.mid), at: comment.ctime * 1000, text: comment.text })
      }
      ctx.logger.info(`lsy-tool-up: evidence for Session ${caller.sessionId}: ${ids.length} id(s) asked, ${found.length} verified, ${read} read from bili-svc${known ? '' : ', none kept because the creator\'s own accounts are unknown'}`)
      return found
    },
  }
}
