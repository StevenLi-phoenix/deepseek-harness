/**
 * The wire protocol between DSH (`fork-qq` plugin) and the `qq-recorder` service. Both ends import these zod schemas and
 * parse every request, response, and stream element with them; the inferred types are the only types that cross the
 * process boundary (a stored row, a file path, or a SQLite type never does).
 *
 * Evolution is additive within a major version: new optional request fields, new response fields, new endpoints
 * (each tagged with the minor that introduced it in {@link FEATURE_MINOR}). Unknown request and response keys are
 * stripped on parse; enumerations that may grow are open ({@link openEnum}) and read as `'unknown'` on an old end. A
 * breaking change takes a new major and a `/v2` path. The frozen samples in `tests/protocol-fixtures/v1.0` must keep
 * parsing; a change that breaks them is not additive.
 */
import { z } from 'zod'

/** Protocol identity. Both ends send `X-Fork-Protocol: qq-recorder/<major>.<minor>` on every request and response. */
export const PROTOCOL = { name: 'qq-recorder', major: 1, minor: 0 } as const

/** Header carrying {@link PROTOCOL} as `qq-recorder/1.0`. */
export const PROTOCOL_HEADER = 'x-fork-protocol'

/** The header value an end with protocol `{major, minor}` sends. */
export function protocolTag(version: { major: number; minor: number } = PROTOCOL): string {
  return `${PROTOCOL.name}/${version.major}.${version.minor}`
}

/**
 * Parse a protocol header value.
 * @param value - the header, or undefined.
 * @returns the version, or undefined when it is missing or not `qq-recorder/<major>.<minor>`.
 */
export function parseProtocolTag(value: string | null | undefined): { major: number; minor: number } | undefined {
  const match = /^qq-recorder\/(\d{1,4})\.(\d{1,4})$/.exec(value ?? '')
  return match === null ? undefined : { major: Number(match[1]), minor: Number(match[2]) }
}

/**
 * The minor version that introduced each optional capability. A client talking to a recorder whose minor is lower
 * switches only that capability off. Add an entry with the minor that ships it; never renumber.
 */
export const FEATURE_MINOR: Record<string, number> = {
  /** `GET /v1/events`: push notices; without it the client polls `/v1/status`. */
  events: 0,
  /** `GET /v1/groups/{id}/members`: the names a group note must not contain, and the aliases that stand for @-mentions. */
  members: 0,
  /** `GET /v1/legacy/digest-state`: the one-time import of the digest state the plugin used to keep in `qq.db`. */
  legacyState: 0,
}

/** Paths of protocol v1. */
export const PATHS = {
  hello: '/v1/hello',
  status: '/v1/status',
  events: '/v1/events',
  groups: '/v1/groups',
  messages: '/v1/messages',
  search: '/v1/messages/search',
  lookup: '/v1/messages/lookup',
  config: '/v1/config',
  login: '/v1/login',
  loginRefresh: '/v1/login/refresh',
  legacy: '/v1/legacy/digest-state',
  members: (groupId: string): string => `/v1/groups/${encodeURIComponent(groupId)}/members`,
} as const

/** A string enumeration that may grow: a value this end does not know reads as `'unknown'`. */
export function openEnum<const T extends readonly [string, ...string[]]>(values: T): z.ZodType<T[number] | 'unknown', string> {
  return z.string().transform((value): T[number] | 'unknown' => ((values as readonly string[]).includes(value) ? value as T[number] : 'unknown'))
}

const epochMs = z.number().int().nonnegative()
const groupId = z.string().regex(/^[0-9]{3,20}$/)
const shortText = z.string().max(2000)
/** Opaque position of a message in the recorder's log; only ever handed back to the recorder. */
export const CursorDto = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/)
/** An opaque message cursor. */
export type Cursor = z.infer<typeof CursorDto>

/** `GET /v1/hello`: who is answering. */
export const HelloDto = z.object({
  protocol: z.object({ name: z.string(), major: z.number().int().nonnegative(), minor: z.number().int().nonnegative() }),
  /** Fingerprint of the recorder build. */
  build: z.string().max(64),
  startedAt: epochMs,
})
/** {@link HelloDto}. */
export type Hello = z.infer<typeof HelloDto>

/** The recorder's connection to the protocol end (NapCat's OneBot server). */
export const ConnectionDto = z.object({
  state: openEnum(['connected', 'reconnecting', 'waiting-token', 'waiting-config', 'starting'] as const),
  since: epochMs.nullable(),
  attempt: z.number().int().nonnegative(),
  lastError: z.string().max(500).nullable(),
  selfId: z.string().max(30).nullable(),
})
/** {@link ConnectionDto}. */
export type Connection = z.infer<typeof ConnectionDto>

/** `GET /v1/status`, and the payload of the `status` event. */
export const StatusDto = z.object({
  connection: ConnectionDto,
  outage: z.object({ disconnectedSince: epochMs.nullable(), botOfflineAt: epochMs.nullable() }),
  recordedGroups: z.number().int().nonnegative(),
  /** The `revision` of the configuration the recorder runs on; null before the first push. */
  configRevision: z.string().max(64).nullable(),
  counters: z.object({
    messages: z.number().int().nonnegative(),
    media: z.number().int().nonnegative(),
    voices: z.number().int().nonnegative(),
    dropped: z.number().int().nonnegative(),
    private: z.number().int().nonnegative(),
  }),
})
/** {@link StatusDto}. */
export type Status = z.infer<typeof StatusDto>

/** One group the account is in. */
export const GroupDto = z.object({
  groupId,
  name: z.string().max(200),
  memberCount: z.number().int().nonnegative().nullable(),
  recorded: z.boolean(),
  messages: z.number().int().nonnegative(),
  firstAt: epochMs.nullable(),
  lastAt: epochMs.nullable(),
  /** Messages the group showed while it was not on the list, since the recorder started: a count only. */
  unlistedSeen: z.number().int().nonnegative(),
})
/** {@link GroupDto}. */
export type Group = z.infer<typeof GroupDto>

/** One recorded message. */
export const MessageDto = z.object({
  cursor: CursorDto,
  groupId,
  messageId: z.string().max(40),
  at: epochMs,
  userId: z.string().max(30),
  nickname: z.string().max(200),
  card: z.string().max(200),
  role: z.string().max(30),
  text: z.string().max(20_000),
  replyTo: z.string().max(40).nullable(),
  kinds: z.string().max(200),
  recalled: z.boolean(),
})
/** {@link MessageDto}. */
export type Message = z.infer<typeof MessageDto>

/** `GET /v1/messages?after=`: a page of messages in log order, and where the next page starts. */
export const MessagePageDto = z.object({
  items: z.array(MessageDto).max(5000),
  /** Cursor to pass as `after` for the next page; null when the page is the last one. */
  nextCursor: CursorDto.nullable(),
})
/** {@link MessagePageDto}. */
export type MessagePage = z.infer<typeof MessagePageDto>

/** `GET /v1/messages` with a window. */
export const MessageListDto = z.array(MessageDto).max(1000)

/** `POST /v1/messages/search` request. */
export const SearchRequestDto = z.object({
  query: z.string().min(1).max(500),
  groupId: groupId.optional(),
  limit: z.number().int().min(1).max(200),
})
/** {@link SearchRequestDto}. */
export type SearchRequest = z.infer<typeof SearchRequestDto>

/** `POST /v1/messages/lookup` request: messages of one group by their OneBot message ids. */
export const LookupRequestDto = z.object({
  groupId,
  messageIds: z.array(z.string().max(40)).max(200),
})
/** {@link LookupRequestDto}. */
export type LookupRequest = z.infer<typeof LookupRequestDto>

/** One member of a group as the recorded messages showed them (a person can appear under several names). */
export const MemberDto = z.object({ userId: z.string().max(30), nickname: z.string().max(200), card: z.string().max(200) })
/** {@link MemberDto}. */
export type Member = z.infer<typeof MemberDto>

/** `GET /v1/groups/{id}/members`: every distinct (member, nickname, card) the group's recorded messages carry. */
export const MembersDto = z.array(MemberDto).max(20_000)

const BACKFILL_ENABLED = z.boolean()

/**
 * `PUT /v1/config`: what DSH pushes. DSH owns the settings; the recorder applies and persists them. `revision` is a
 * hash of the rest, chosen by the pusher, so the recorder can report which push it runs on.
 */
export const RecorderConfigDto = z.object({
  revision: z.string().min(1).max(64),
  /** WebSocket address of the protocol end; must be on this machine or the tailnet. */
  url: z.string().max(300),
  /** Name of the environment variable (a declared secret of the recorder) holding the access token. */
  tokenEnv: z.string().regex(/^FORK_QQ_[A-Z0-9_]{1,40}$/),
  groups: z.array(groupId).max(500),
  media: z.object({
    images: z.boolean(),
    maxImageBytes: z.number().int().min(1024),
    maxTotalBytes: z.number().int().min(1024),
    retainDays: z.number().int().nonnegative(),
    hostSuffixes: z.array(z.string().max(100)).max(50),
    timeoutMs: z.number().int().min(1000),
  }),
  voice: z.object({ download: z.boolean(), maxBytes: z.number().int().min(1024) }),
  retention: z.object({ textDays: z.number().int().nonnegative() }),
  honorRecall: z.boolean(),
  backfill: z.object({
    enabled: BACKFILL_ENABLED,
    maxMessages: z.number().int().min(1),
    maxGroups: z.number().int().min(1),
    gapMs: z.number().int().nonnegative(),
    skipWithinMs: z.number().int().nonnegative(),
    minIntervalMs: z.number().int().nonnegative(),
  }),
  reconnectQuietMs: z.number().int().nonnegative(),
  login: z.object({ enabled: z.boolean(), url: z.string().max(300), timeoutMs: z.number().int().min(500) }),
})
/** {@link RecorderConfigDto}. */
export type RecorderConfig = z.infer<typeof RecorderConfigDto>

/** Answer to `PUT /v1/config`. */
export const ConfigAppliedDto = z.object({
  revision: z.string().max(64),
  /** Whether the change dropped the connection to the protocol end to make a new one. */
  reconnect: z.boolean(),
})
/** {@link ConfigAppliedDto}. */
export type ConfigApplied = z.infer<typeof ConfigAppliedDto>

/** NapCat's login as the login door reports it. `qrUrl` is sensitive: neither end logs it. */
export const LoginDto = z.object({
  door: openEnum(['ok', 'napcat-down', 'unreachable', 'unauthorized', 'invalid', 'disabled'] as const),
  state: openEnum(['online', 'offline', 'qr', 'scanned', 'logging-in', 'preparing', 'restarting', 'unknown'] as const).nullable(),
  uin: z.string().max(30).nullable(),
  nickname: z.string().max(100).nullable(),
  error: z.string().max(300).nullable(),
  qrUrl: z.string().max(700).nullable(),
})
/** {@link LoginDto}. */
export type Login = z.infer<typeof LoginDto>

/** Answer to `POST /v1/login/refresh`. */
export const RefreshDto = z.object({
  login: LoginDto,
  refreshed: z.boolean(),
  reason: openEnum(['logged-in', 'recently-logged-in', 'too-soon', 'napcat-refused', 'unreachable'] as const).nullable(),
})
/** {@link RefreshDto}. */
export type Refresh = z.infer<typeof RefreshDto>

/** One element of the `GET /v1/events` NDJSON stream. A type this end does not know is skipped. */
export const EventDto = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status'), status: StatusDto }),
  z.object({ type: z.literal('messages'), groupId, count: z.number().int().positive(), lastCursor: CursorDto }),
  z.object({ type: z.literal('bot-offline'), at: epochMs }),
  z.object({ type: z.literal('ping'), at: epochMs }),
])
/** {@link EventDto}. */
export type RecorderEvent = z.infer<typeof EventDto>

/** One digest the plugin made before the digest state left `qq.db`, for the one-time import. */
const LegacyDigestDto = z.object({
  groupId,
  fromCursor: CursorDto,
  toCursor: CursorDto,
  messageCount: z.number().int().nonnegative(),
  text: z.string().max(20_000),
  model: z.string().max(200),
  usage: z.string().max(2000).nullable(),
  rawPath: z.string().max(1000).nullable(),
  createdAt: epochMs,
})

/** `GET /v1/legacy/digest-state`: read-only, for the one-time import into the plugin's own storage. */
export const LegacyDigestStateDto = z.object({
  digests: z.array(LegacyDigestDto).max(100_000),
  notes: z.array(z.object({ groupId, text: shortText, createdAt: epochMs })).max(100_000),
  groupSessions: z.array(z.object({ groupId, sessionId: z.string().max(100), createdAt: epochMs, generation: z.number().int().positive() })).max(10_000),
  aliasSalt: z.string().max(100).nullable(),
  /** When the owner was last told of an outage, from the old `outage-notice.json`. */
  outageNoticeAt: epochMs.nullable(),
})
/** {@link LegacyDigestStateDto}. */
export type LegacyDigestState = z.infer<typeof LegacyDigestStateDto>

/** The body of every error answer. */
export const ErrorDto = z.object({ error: z.object({ code: z.string().max(60), message: z.string().max(500) }) })
/** {@link ErrorDto}. */
export type ErrorBody = z.infer<typeof ErrorDto>
