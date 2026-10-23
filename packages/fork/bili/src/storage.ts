/**
 * Durable account state outside the credential store: the signed-in account's
 * public facts, write pauses, the write ledger, the body-clock plans, the wake
 * log, inbox cursors, the journal, and the owner's interests text. Cookie
 * values and the refresh token live only in the credential record.
 */
import { z } from 'zod'
import type { DomainSpec, DomainTableSpec } from '@deepseek-ai/dsh-storage-domain'
import { ACCOUNT_STATES, PAUSE_SCOPES, WAKE_STATES, WRITE_ACTIONS, type WriteAction } from './view.ts'

export { WRITE_ACTIONS, type WriteAction } from './view.ts'

const accountSchema = z.object({
  state: z.enum(ACCOUNT_STATES),
  /** Bilibili user id of the signed-in account. */
  mid: z.number().int().positive(),
  uname: z.string(),
  /** Account level 0-6 from `nav`. */
  level: z.number().int().nonnegative(),
  /** When the QR login completed, in Unix epoch milliseconds. */
  loggedInAt: z.number(),
  /** When the cookies were last refreshed (or issued), in Unix epoch milliseconds. */
  refreshedAt: z.number(),
  /** When the cookies were last checked against `cookie/info`. */
  checkedAt: z.number().optional(),
  /** Why the state is `login-needed`. */
  reason: z.string().optional(),
  /** The login-needed notice went out for this state; cleared by the next login. */
  noticeSent: z.boolean().optional(),
}).strict()

const pauseSchema = z.object({
  scope: z.enum(PAUSE_SCOPES),
  /** Short machine reason, e.g. `HTTP 412`, `code -352`, `comment hidden`. */
  reason: z.string(),
  since: z.number(),
}).strict()

const readBackoffSchema = z.object({
  /** Reads resume at this time, in Unix epoch milliseconds. */
  until: z.number(),
  reason: z.string(),
}).strict()

/** Writes others can read: they pause together when a comment looks hidden. */
export const SPEECH_ACTIONS: ReadonlySet<WriteAction> = new Set(['comment', 'reply', 'dynamic'])

/** Ledger states: `reserved` before the request, then one of the others; `uncertain` is never retried. */
export const LEDGER_STATES = ['reserved', 'accepted', 'failed', 'uncertain'] as const
/** Post-send visibility of a comment or reply. */
export const VISIBILITY_STATES = ['pending', 'visible', 'hidden', 'unknown'] as const

const ledgerSchema = z.object({
  id: z.string().min(1),
  action: z.enum(WRITE_ACTIONS),
  /** What the write was about, e.g. `BV1xx`, `mid:200000001`, `rpid:123`. */
  target: z.string().min(1),
  /** Local day the write counts against. */
  day: z.string(),
  state: z.enum(LEDGER_STATES),
  reservedAt: z.number(),
  settledAt: z.number().optional(),
  /** Bilibili's answer or the local reason, one line. */
  detail: z.string().optional(),
  /** Text the account posted (comments, replies, dynamics, DMs); public or sent to the owner only. */
  text: z.string().optional(),
  /** Comment id (`rpid_str`), dynamic id, or DM `msg_key` of an accepted write. */
  receipt: z.string().optional(),
  /** Comment area of a comment or reply: area type (`1` for videos), `oid` (the video aid), and the root comment of a reply. */
  type: z.number().int().positive().optional(),
  oid: z.string().optional(),
  root: z.string().optional(),
  visibility: z.enum(VISIBILITY_STATES).optional(),
  /** When the visibility check runs. */
  visibilityDueAt: z.number().optional(),
}).strict()

const slotSchema = z.object({
  /** Earliest time of the next write, in Unix epoch milliseconds. */
  nextAt: z.number(),
}).strict()

const planSchema = z.object({
  day: z.string(),
  wakes: z.array(z.object({
    /** Index of the configured window. */
    window: z.number().int().nonnegative(),
    /** Planned time, in Unix epoch milliseconds; absent when the window is skipped today. */
    at: z.number().optional(),
    state: z.enum(WAKE_STATES),
  }).strict()),
}).strict()

const wakeSchema = z.object({
  at: z.number(),
  /** `clock` for a body-clock wake, `inbox` for new replies, mentions, or owner messages. */
  reason: z.enum(['clock', 'inbox']),
  sessionId: z.string(),
}).strict()

const inboxSchema = z.object({
  /** Ids already handed to the Session (or baselined), newest last; bounded. */
  seen: z.array(z.string()),
}).strict()

const pendingSchema = z.object({
  kind: z.enum(['reply', 'at', 'dm']),
  /** Stable item id within `kind`. */
  id: z.string(),
  at: z.number(),
  /** Untrusted item fields for the prompt, already bounded. */
  item: z.record(z.string(), z.union([z.string(), z.number()])),
}).strict()

const targetSchema = z.object({
  /** Comment area id (`oid`, the video aid for videos) and area type (`1` for videos, `17` or `11` for dynamics). */
  oid: z.string().min(1),
  type: z.number().int().positive(),
  /** Root comment of the thread, and the comment answered (the target itself). */
  root: z.string().min(1),
  /** Who wrote it, and when the inbox saw it. */
  mid: z.number().int().nonnegative(),
  at: z.number(),
}).strict()

const journalSchema = z.object({
  seq: z.number().int().positive(),
  day: z.string(),
  at: z.number(),
  text: z.string(),
}).strict()

const settingSchema = z.object({
  text: z.string(),
  updatedAt: z.number(),
}).strict()

const sessionSchema = z.object({
  sessionId: z.string().min(1),
  createdAt: z.number(),
}).strict()

/** Public facts of the signed-in account and its login state. */
export type AccountRecord = z.infer<typeof accountSchema>
/** A write pause; present while writes are paused. */
export type PauseRecord = z.infer<typeof pauseSchema>
/** Reads waiting out a risk signal. */
export type ReadBackoffRecord = z.infer<typeof readBackoffSchema>
/** One write as the ledger keeps it. */
export type LedgerRecord = z.infer<typeof ledgerSchema>
/** The next write slot. */
export type SlotRecord = z.infer<typeof slotSchema>
/** One day's planned wakes. */
export type PlanRecord = z.infer<typeof planSchema>
/** One wake that prompted the Session. */
export type WakeRecord = z.infer<typeof wakeSchema>
/** Inbox items already handed over, per kind. */
export type InboxRecord = z.infer<typeof inboxSchema>
/** One inbox item waiting for a wake. */
export type PendingRecord = z.infer<typeof pendingSchema>
/** A comment someone wrote to the account (a reply or a mention) that it may answer. */
export type TargetRecord = z.infer<typeof targetSchema>
/** One journal entry. */
export type JournalRecord = z.infer<typeof journalSchema>
/** One owner-edited text setting. */
export type SettingRecord = z.infer<typeof settingSchema>
/** A Session this plugin created. */
export type SessionRecord = z.infer<typeof sessionSchema>

/**
 * Account storage. `account` is keyed `current`; `pause` by scope key `writes`;
 * `backoff` by `reads`; `ledger` by write id; `slots` by `write`; `plans` by day;
 * `wakes` by zero-padded time; `inbox` by kind; `pending` by `<kind>:<id>`;
 * `targets` by comment id (`rpid`); `journal` by zero-padded `seq`; `settings` by name (`interests`); `sessions`
 * by Session id, and `current` names the live one.
 */
export const biliDomain = {
  name: 'bili',
  version: 1,
  tables: {
    account: table<AccountRecord>(accountSchema),
    pause: table<PauseRecord>(pauseSchema),
    backoff: table<ReadBackoffRecord>(readBackoffSchema),
    ledger: table<LedgerRecord>(ledgerSchema),
    slots: table<SlotRecord>(slotSchema),
    plans: table<PlanRecord>(planSchema),
    wakes: table<WakeRecord>(wakeSchema),
    inbox: table<InboxRecord>(inboxSchema),
    pending: table<PendingRecord>(pendingSchema),
    targets: table<TargetRecord>(targetSchema),
    journal: table<JournalRecord>(journalSchema),
    settings: table<SettingRecord>(settingSchema),
    sessions: table<SessionRecord>(sessionSchema),
    current: table<SessionRecord>(sessionSchema),
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

/** Storage key of a sequence number; zero-padded so keys sort like numbers. */
export function seqKey(seq: number): string {
  return String(seq).padStart(15, '0')
}
