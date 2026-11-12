/**
 * Durable state of the account's DSH side: the owner-message cursor and queue, the journal,
 * today's messages to the owner's main agent, the owner's main account as set in Settings, and
 * the Sessions this plugin created, the hot comments and words for `ctx.biliHot`, and the daily
 * shares (plan, outcome, and what was sent) with the owner's on/off switch for them. No session, cookie, ledger, cap, or pause
 * lives here: bili-svc owns all of them.
 *
 * Tables of the retired scouting, sign-in, and write guard (`account`, `pause`, `backoff`, `ledger`,
 * `slots`, `plans`, `wakes`, `targets`, `taste`, `finds`, `trends`, `seen`, `progress`, `verify`,
 * `settings`, `device`) are no longer declared, so stored rows of them are not loaded and the
 * backend drops them on its next write.
 */
import { z } from 'zod'
import type { DomainSpec, DomainTableSpec } from '@deepseek-ai/dsh-storage-domain'

const inboxSchema = z.object({
  /** Ids already handed to the Session (or baselined), newest last; bounded. */
  seen: z.array(z.string()),
}).strict()

const pendingSchema = z.object({
  /** Only `dm` (a message from the owner's account) is queued; `reply` and `at` rows are older data, dropped at start. */
  kind: z.enum(['reply', 'at', 'dm']),
  /** Stable item id within `kind`. */
  id: z.string(),
  at: z.number(),
  /** Untrusted item fields for the prompt, already bounded. */
  item: z.record(z.string(), z.union([z.string(), z.number()])),
}).strict()

const journalSchema = z.object({
  seq: z.number().int().positive(),
  day: z.string(),
  at: z.number(),
  text: z.string(),
}).strict()

const toldSchema = z.object({
  seq: z.number().int().positive(),
  day: z.string(),
  at: z.number(),
  /** Code points of the message; the text itself lives in both Sessions' logs. */
  chars: z.number().int().positive(),
  /** The main agent's chat Session the message was queued in. */
  sessionId: z.string().min(1),
}).strict()

const ownerSchema = z.object({
  /** The owner's main account (UID). */
  mid: z.number(),
  updatedAt: z.number(),
}).strict()

const sessionSchema = z.object({
  sessionId: z.string().min(1),
  createdAt: z.number(),
}).strict()

const hotCommentSchema = z.object({
  /** A public comment's text, without any name or `@`. */
  text: z.string(),
  likes: z.number().int().nonnegative(),
  bvid: z.string(),
  /** When it was last read, Unix epoch milliseconds. */
  at: z.number(),
}).strict()

const hotWordSchema = z.object({
  /** When the word was last on the hot-search list, Unix epoch milliseconds. */
  at: z.number(),
}).strict()

const shareSchema = z.object({
  /** Local day (`timeZone`) the share belongs to. */
  day: z.string(),
  /** `plan`: the day's share at a random time in the window; `manual`: the owner pressed 现在发一条. */
  reason: z.enum(['plan', 'manual']),
  /** When it is due, Unix epoch milliseconds. */
  planAt: z.number(),
  /** When the Session was prompted; unset while it waits. */
  firedAt: z.number().optional(),
  sessionId: z.string().optional(),
  /** Unset while planned or while its turn runs. */
  outcome: z.enum(['sent', 'wechat', 'silent', 'missed', 'failed']).optional(),
  /** One line of why, for the log and Settings. */
  detail: z.string().optional(),
  /** What reached the owner (Bilibili or WeChat), bounded; the account's own words. */
  text: z.string().optional(),
  settledAt: z.number().optional(),
}).strict()

const sharePrefsSchema = z.object({
  /** The owner's switch in Settings; it wins over the configuration. */
  enabled: z.boolean(),
  updatedAt: z.number(),
}).strict()

/** Owner-message ids already handed over. */
export type InboxRecord = z.infer<typeof inboxSchema>
/** One owner message waiting for its turn. */
export type PendingRecord = z.infer<typeof pendingSchema>
/** One journal entry. */
export type JournalRecord = z.infer<typeof journalSchema>
/** One message the account's Session sent the owner's main agent today; the daily limit counts these. */
export type ToldRecord = z.infer<typeof toldSchema>
/** The owner's main account, as set in Settings. */
export type OwnerRecord = z.infer<typeof ownerSchema>
/** A hot comment read under a video (`ctx.biliHot`); no UID or nickname. */
export type HotCommentRecord = z.infer<typeof hotCommentSchema>
/** A hot-search word (`ctx.biliHot`). */
export type HotWordRecord = z.infer<typeof hotWordSchema>
/** A Session this plugin created. */
export type SessionRecord = z.infer<typeof sessionSchema>
/** One daily share: its plan, and how it went. */
export type ShareRecord = z.infer<typeof shareSchema>
/** The owner's on/off switch of the daily share. */
export type SharePrefsRecord = z.infer<typeof sharePrefsSchema>

/**
 * Account storage. `inbox` by kind (`dm`); `pending` by `<kind>:<id>`; `journal` and `told` (today's
 * only) by zero-padded `seq`; `owner` by `main`; `sessions` by Session id, and `current` names the live one;
 * `hot_comments` by rpid and `hot_words` by word (`ctx.biliHot`, bounded and expiring); `share_days` by
 * day for the planned share and `<day>~m<at>` for a manual one (the latest 30 kept), `share_prefs` by `main`.
 */
export const biliDomain = {
  name: 'bili',
  version: 1,
  tables: {
    inbox: table<InboxRecord>(inboxSchema),
    pending: table<PendingRecord>(pendingSchema),
    journal: table<JournalRecord>(journalSchema),
    told: table<ToldRecord>(toldSchema),
    owner: table<OwnerRecord>(ownerSchema),
    sessions: table<SessionRecord>(sessionSchema),
    current: table<SessionRecord>(sessionSchema),
    hot_comments: table<HotCommentRecord>(hotCommentSchema),
    hot_words: table<HotWordRecord>(hotWordSchema),
    share_days: table<ShareRecord>(shareSchema),
    share_prefs: table<SharePrefsRecord>(sharePrefsSchema),
  },
} as const satisfies DomainSpec

/**
 * One table spec, as `domainTable()` builds it. This package has a browser
 * half, so its Host half takes no runtime export from another workspace
 * package unless the dependency policy classifies it; the spec is a literal.
 */
function table<V>(schema: z.ZodType<V>): DomainTableSpec<string, V> {
  return { valueSchema: schema }
}

/**
 * Storage key of a sequence number; zero-padded so keys sort like numbers.
 * @param seq - non-negative integer sequence number.
 * @returns the key, 15 digits wide.
 */
export function seqKey(seq: number): string {
  return String(seq).padStart(15, '0')
}
