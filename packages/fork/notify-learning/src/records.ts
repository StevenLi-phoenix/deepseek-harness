/**
 * The learner's files: the proactive messages still open for the owner's reaction, the rules and the clues
 * learned from the reactions, and one history line per change. Every file is read through these schemas, so a
 * hand edit that breaks one stops the learner and the rules block instead of being dropped.
 */

import { z } from 'zod'

/** How a kind of proactive message reaches the owner: as usual, in one short sentence, or not at all. */
export const DECISIONS = ['tell', 'brief', 'silent'] as const

/** One of {@link DECISIONS}. */
export type Decision = typeof DECISIONS[number]

const stamp = z.iso.datetime({ offset: true })

const replySchema = z.object({
  /** When the owner's turn ended. */
  at: stamp,
  /** The owner's words in that turn. */
  owner: z.string(),
  /** The agent's answer to them. */
  agent: z.string(),
}).strict()

const exchangeSchema = z.object({
  /** `x` and eight hex digits. */
  id: z.string().regex(/^x[0-9a-f]{8}$/u),
  /** The chat Session the message came from. */
  session: z.string(),
  /** When the turn that sent it ended. */
  at: stamp,
  /** What started that turn, as turn-taint labels it (`peer:note`, `event`, `scheduled`, `monitor`, …). */
  trigger: z.string(),
  /** What the owner received. */
  sent: z.string(),
  /** The owner's turns after it, oldest first. */
  replies: z.array(replySchema),
}).strict()

/** One quoted reaction of the owner's that supports a clue or a rule. */
const evidenceSchema = z.object({
  /** The exchange it came from. */
  exchange: z.string(),
  /** When that proactive message was sent. */
  at: stamp,
  /** The owner's words, verbatim. */
  quote: z.string(),
}).strict()

const clueSchema = z.object({
  kind: z.string(),
  decision: z.enum(DECISIONS),
  evidence: z.array(evidenceSchema),
}).strict()

const ruleSchema = z.object({
  /** `r` and six hex digits. */
  id: z.string().regex(/^r[0-9a-f]{6}$/u),
  kind: z.string(),
  decision: z.enum(DECISIONS),
  evidence: z.array(evidenceSchema),
  /** When the rule was learned. */
  since: stamp,
}).strict()

/** `exchanges.json`. */
export const exchangesFileSchema = z.object({ version: z.literal(1), exchanges: z.array(exchangeSchema) }).strict()

/** `rules.json`. */
export const stateFileSchema = z.object({
  version: z.literal(1),
  /** Raised by every change to the rules; the rules block names it. */
  revision: z.number().int().nonnegative(),
  rules: z.array(ruleSchema),
  clues: z.array(clueSchema),
  /** Local day (`YYYY-MM-DD`) of the last nightly pass that finished. */
  lastRunDay: z.string().optional(),
  /** Failed passes of one local day, so a broken route is retried a few times, not every check. */
  attempts: z.object({ day: z.string(), count: z.number().int().nonnegative(), at: stamp }).strict().optional(),
}).strict()

/** One line of `history.jsonl`. */
export const historySchema = z.object({
  at: stamp,
  revision: z.number().int().nonnegative(),
  /** `nightly` for the pass, `owner` for a rule the owner had deleted. */
  by: z.enum(['nightly', 'owner']),
  added: z.array(ruleSchema),
  removed: z.array(ruleSchema),
  /** The route that answered a nightly pass, `provider/model`. */
  model: z.string().optional(),
}).strict()

/** The owner's turn after a proactive message. */
export type Reply = z.infer<typeof replySchema>
/** A proactive message and the owner's turns after it. */
export type Exchange = z.infer<typeof exchangeSchema>
/** A quoted reaction behind a clue or a rule. */
export type Evidence = z.infer<typeof evidenceSchema>
/** Reactions of one kind and decision that are not yet enough for a rule. */
export type Clue = z.infer<typeof clueSchema>
/** A learned rule. */
export type Rule = z.infer<typeof ruleSchema>
/** The rules, the clues, and the pass bookkeeping. */
export type LearnState = z.infer<typeof stateFileSchema>
/** One change to the rules. */
export type HistoryRecord = z.infer<typeof historySchema>

/** The state before anything was learned. */
export const EMPTY_STATE: LearnState = { version: 1, revision: 0, rules: [], clues: [] }
