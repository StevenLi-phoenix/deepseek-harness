/**
 * `up_*` tools: the creator account's reads and its two reply tools, mounted in the `up` preset; the channel notes
 * (`bili_channel_note`) and the Bilibili evidence verifier (`ctx.biliEvidence`) of its persistent Session.
 *
 * Everything goes through bili-svc (`http://127.0.0.1:8097`, bearer token `BILI_SVC_TOKEN_UP` from the
 * credential store). Reads return Bilibili content wrapped as untrusted data and cut to a fixed length. The
 * two reply tools post nothing themselves: bili-svc's Reply Gate decides, and the tool returns only `sent`,
 * `held`, or `blocked` with a ledger id, never a reason. Nothing here can send a different kind of write.
 *
 * @module @deepseek-ai/dsh-lsy-tool-up
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { BiliSvc, DEFAULT_BASE_URL, tokenReader, type Env } from './bili-svc.ts'
import { CommentCache, type BiliEvidence } from './evidence.ts'
import { OwnAccounts, createEvidence } from './evidence-service.ts'
import { mountNotes } from './notes-tool.ts'
import { sessionGate } from './session-gate.ts'
import { registerReadTools, registerReplyTools } from './tools.ts'

export { DEFAULT_BASE_URL, MAX_BLOCK_CHARS, READ_TIMEOUT_MS, REPLY_TIMEOUT_MS, TOKEN_ENV, untrusted, type Env } from './bili-svc.ts'
export {
  BiliEvidenceRefusedError, CommentCache, commentsOf, defaultSaltFile, loadSalt, ownMidsOf, parseComment, senderKey,
  type BiliEvidence, type BiliEvidenceCaller, type BiliEvidenceItem, type BiliEvidenceRefusal, type CachedComment,
} from './evidence.ts'
export { guardOf, type GuardPurpose, type GuardVerdict, type TextGuard } from './guard.ts'
export { ChannelNotes, defaultNotesFile, normalizeNote, renderNotesBlock, type ChannelNote, type NoteGate, type NoteLimits, type NoteOutcome } from './notes.ts'
export { PII_KINDS, piiKind, type PiiKind } from './pii.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    biliEvidence: BiliEvidence
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'lsy-tool-up': { kind: 'lsy-tool-up' } & ContextFormed
  }
}

/** Plugin name; also the source kind of the channel-notes block. */
export const name = 'lsy-tool-up'

/** Mounted inside an agent preset's scope, like other tool plugins. */
export const inject = ['tools', 'credentials']

/** Notes, evidence, and the Session they belong to. */
export interface Config {
  /** The bus subscription whose persistent Session may write notes and verify evidence; any other Session is refused. */
  subscription: string
  /** Calls per turn of `bili_channel_note`, and separately of `ctx.biliEvidence.evidenceOf`. */
  callsPerTurn: number
  /** The channel notes file and its limits. */
  notes: {
    /** Absolute path of the notes file; defaults to `<DSH_HOME>/lsy-tool-up/channel-notes.json`. */
    file?: string
    /** Notes kept. */
    maxEntries: number
    /** Longest note, in characters. */
    maxChars: number
  }
  /** The evidence verifier's sender-key salt, comment cache, and per-call id limit. */
  evidence: {
    /** Absolute path of the sender-key salt; defaults to `<DSH_HOME>/lsy-tool-up/evidence-salt`, created on first use. */
    saltFile?: string
    /** Comments remembered from the Session's reads, by rpid. */
    cacheSize: number
    /** Ids looked up per call; the rest are left out. */
    maxIds: number
  }
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  subscription: z.string().default('bili-digest'),
  callsPerTurn: z.natural().min(1).default(5),
  notes: z.object({
    file: z.string(),
    maxEntries: z.natural().min(1).default(30),
    maxChars: z.natural().min(1).default(40),
  }),
  evidence: z.object({
    saltFile: z.string(),
    cacheSize: z.natural().min(1).default(2000),
    maxIds: z.natural().min(1).default(20),
  }),
})

/**
 * Register the `up_*` tools and `bili_channel_note`, inject the channel notes, and provide `ctx.biliEvidence`.
 * @param ctx - the preset scope's context.
 * @param config - notes, evidence, and the persistent Session they belong to.
 */
export function apply(ctx: Context, config: Config): void {
  // The global fetch is looked up per call, so a test can stub it.
  const env: Env = { fetch: (...args) => fetch(...args), baseUrl: process.env['BILI_SVC_URL'] ?? DEFAULT_BASE_URL }
  const svc = new BiliSvc(env, tokenReader(ctx))
  const gate = sessionGate(ctx, config)
  const comments = new CommentCache(config.evidence.cacheSize)
  const own = new OwnAccounts()
  registerReadTools(ctx, svc, { comments, own })
  registerReplyTools(ctx, svc)
  mountNotes(ctx, config, gate)
  ctx.provide('biliEvidence', createEvidence({ ctx, config, svc, comments, own, gate }))
}
