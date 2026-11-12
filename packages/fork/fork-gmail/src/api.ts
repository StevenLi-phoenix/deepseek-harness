/**
 * The Gmail REST API (`gmail/v1/users/me`) for one account. Each call takes a fresh access token from the service;
 * a 401 drops it and retries once with a new one. A 429 is retried after a pause; a 5xx or a broken connection is
 * retried only for calls that are safe to repeat, so a send is never sent twice. A new message or draft goes up as
 * `multipart/related` (JSON metadata plus the `message/rfc822` text) to the upload endpoint. Errors carry Google's
 * reason, cut short, and never a token.
 */

import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { gmailMessageSchema, type GmailMessage } from './message.ts'

/** API base of the signed-in user. */
export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'
/** Upload base of the signed-in user. */
export const GMAIL_UPLOAD = 'https://gmail.googleapis.com/upload/gmail/v1/users/me'

/** Why a Gmail call failed. */
export type GmailApiFailure = 'auth' | 'not-found' | 'rate' | 'http' | 'network' | 'timeout' | 'invalid'

/** A failed Gmail call; the message is safe to log and to show to the model. */
export class GmailApiError extends Error {
  /**
   * @param failure - the failure class.
   * @param message - what went wrong.
   * @param status - the HTTP status, when Google answered.
   */
  constructor(readonly failure: GmailApiFailure, message: string, readonly status?: number) {
    super(message)
    this.name = 'GmailApiError'
  }
}

/** What the client needs. */
export interface GmailApiOptions {
  /** Per-call timeout in milliseconds. */
  readonly timeoutMs: number
  /** A valid access token; `fresh` asks for a new one after a 401. */
  readonly accessToken: (fresh: boolean) => Promise<string>
  /** Fetch implementation; tests replace it. */
  readonly fetch?: typeof fetch | undefined
  /** Pause between retries; tests replace it. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined
  /** Pauses before each retry of a 429 or a repeatable failure. */
  readonly retryDelaysMs?: readonly number[] | undefined
}

/** One request. */
interface RequestSpec {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** Path under the API (or upload) base, starting with `/`. */
  readonly path: string
  readonly query?: Readonly<Record<string, string | number | readonly string[] | undefined>> | undefined
  /** JSON body. */
  readonly json?: unknown
  /** A message upload: metadata and the RFC 5322 text. */
  readonly upload?: { readonly metadata: unknown; readonly message: string } | undefined
  /** Safe to repeat after a 5xx or a broken connection. */
  readonly repeatable: boolean
}

/** Longest Google error text carried into a message. */
const MAX_ERROR_CHARS = 300
/** Default pauses before retries. */
const RETRY_DELAYS_MS: readonly number[] = [1000, 3000]

const googleErrorSchema = z.object({
  error: z.object({
    code: z.number().optional(),
    message: z.string().optional(),
    status: z.string().optional(),
    errors: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
})

const profileSchema = z.object({
  emailAddress: z.string().min(3), messagesTotal: z.number().optional(), threadsTotal: z.number().optional(),
})
const sendAsSchema = z.object({
  sendAs: z.array(z.object({ sendAsEmail: z.string(), displayName: z.string().optional(), isPrimary: z.boolean().optional() })).optional(),
})
const threadListSchema = z.object({
  threads: z.array(z.object({ id: z.string(), snippet: z.string().optional() })).optional(),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().optional(),
})
const threadSchema = z.object({ id: z.string(), messages: z.array(gmailMessageSchema).optional() })
const attachmentSchema = z.object({ size: z.number().optional(), data: z.string() })
const sentSchema = z.object({ id: z.string(), threadId: z.string(), labelIds: z.array(z.string()).optional() })
const draftSchema = z.object({ id: z.string(), message: gmailMessageSchema.partial({ threadId: true }).optional() })
const rawDraftSchema = z.object({ id: z.string(), message: z.object({ raw: z.string() }) })
const labelListSchema = z.object({
  labels: z.array(z.object({ id: z.string(), name: z.string(), type: z.string().optional() })).optional(),
})

/** The account's address and counts. */
export type GmailProfile = z.infer<typeof profileSchema>
/** One page of `threads.list`. */
export type ThreadList = z.infer<typeof threadListSchema>
/** A thread with its messages. */
export type GmailThread = z.infer<typeof threadSchema>
/** A sent message's ids. */
export type SentMessage = z.infer<typeof sentSchema>
/** A draft resource. */
export type GmailDraft = z.infer<typeof draftSchema>
/** One label. */
export type GmailLabel = NonNullable<z.infer<typeof labelListSchema>['labels']>[number]

/** Google's reason for an error answer, cut short. */
function googleReason(body: unknown, status: number): { text: string; reason: string } {
  const parsed = googleErrorSchema.safeParse(body)
  if (!parsed.success) return { text: `HTTP ${status}`, reason: '' }
  const reason = parsed.data.error.errors?.[0]?.reason ?? parsed.data.error.status ?? ''
  const message = (parsed.data.error.message ?? '').slice(0, MAX_ERROR_CHARS)
  return { text: `HTTP ${status}${reason === '' ? '' : ` ${reason}`}${message === '' ? '' : `: ${message}`}`, reason }
}

/** Whether a 403 is Google's rate limit rather than a refusal. */
function isRateReason(reason: string): boolean {
  return reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || reason === 'RESOURCE_EXHAUSTED'
}

/** The Gmail API of one account. */
export class GmailApi {
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly delays: readonly number[]

  /** @param options - timeout, token source, and test seams. */
  constructor(private readonly options: GmailApiOptions) {
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args))
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.delays = options.retryDelaysMs ?? RETRY_DELAYS_MS
  }

  /** Build the URL of a request. */
  private url(spec: RequestSpec): string {
    const url = new URL(`${spec.upload === undefined ? GMAIL_API : GMAIL_UPLOAD}${spec.path}`)
    if (spec.upload !== undefined) url.searchParams.set('uploadType', 'multipart')
    for (const [name, value] of Object.entries(spec.query ?? {})) {
      if (value === undefined) continue
      if (typeof value === 'object') for (const item of value) url.searchParams.append(name, item)
      else url.searchParams.set(name, String(value))
    }
    return url.toString()
  }

  /** The body and content type of a request. */
  private static body(spec: RequestSpec): { body?: string; type?: string } {
    if (spec.upload !== undefined) {
      const boundary = `fork-gmail-${randomBytes(12).toString('hex')}`
      const body = [
        `--${boundary}`,
        'Content-Type: application/json; charset=UTF-8',
        '',
        JSON.stringify(spec.upload.metadata),
        `--${boundary}`,
        'Content-Type: message/rfc822',
        '',
        spec.upload.message,
        `--${boundary}--`,
        '',
      ].join('\r\n')
      return { body, type: `multipart/related; boundary=${boundary}` }
    }
    if (spec.json !== undefined) return { body: JSON.stringify(spec.json), type: 'application/json' }
    return {}
  }

  /**
   * Run one request with the token, retry, and error rules.
   * @param spec - the request.
   * @returns the parsed JSON answer (undefined for an empty answer).
   */
  private async request(spec: RequestSpec): Promise<unknown> {
    const url = this.url(spec)
    const { body, type } = GmailApi.body(spec)
    let freshToken = false
    let retries = 0
    for (;;) {
      const token = await this.options.accessToken(freshToken)
      const timeout = AbortSignal.timeout(this.options.timeoutMs)
      let response: Response
      try {
        response = await this.fetchImpl(url, {
          method: spec.method,
          headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...type === undefined ? {} : { 'content-type': type } },
          ...body === undefined ? {} : { body },
          signal: timeout,
        })
      } catch (error: unknown) {
        const failure: GmailApiFailure = timeout.aborted ? 'timeout' : 'network'
        const delay = spec.repeatable ? this.delays[retries] : undefined
        if (delay !== undefined) {
          retries++
          await this.sleep(delay)
          continue
        }
        throw new GmailApiError(failure, failure === 'timeout'
          ? `Gmail did not answer within ${this.options.timeoutMs} ms`
          : `Gmail could not be reached (${error instanceof Error ? error.message : String(error)})`)
      }
      const text = await response.text()
      let parsed: unknown
      try {
        parsed = text === '' ? undefined : JSON.parse(text)
      } catch {
        parsed = undefined
      }
      if (response.ok) return parsed
      const { text: detail, reason } = googleReason(parsed, response.status)
      if (response.status === 401 && !freshToken) {
        freshToken = true
        continue
      }
      const rate = response.status === 429 || (response.status === 403 && isRateReason(reason))
      const delay = rate || (response.status >= 500 && spec.repeatable) ? this.delays[retries] : undefined
      if (delay !== undefined) {
        retries++
        await this.sleep(delay)
        continue
      }
      const failure: GmailApiFailure = rate ? 'rate' : response.status === 401 || response.status === 403 ? 'auth' : response.status === 404 ? 'not-found' : 'http'
      throw new GmailApiError(failure, `Gmail ${spec.method} ${spec.path.split('?')[0]} failed with ${detail}`, response.status)
    }
  }

  /** Parse an answer or fail as `invalid`. */
  private static parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw new GmailApiError('invalid', `Gmail answered ${what} in an unexpected shape`)
    return parsed.data
  }

  /**
   * The account's address.
   * @returns the profile.
   */
  async profile(): Promise<GmailProfile> {
    return GmailApi.parse(profileSchema, await this.request({ method: 'GET', path: '/profile', repeatable: true }), 'the profile')
  }

  /**
   * The display name of the primary send-as address.
   * @returns the name, or an empty string.
   */
  async displayName(): Promise<string> {
    const list = GmailApi.parse(sendAsSchema, await this.request({ method: 'GET', path: '/settings/sendAs', repeatable: true }), 'the send-as list')
    return list.sendAs?.find(entry => entry.isPrimary === true)?.displayName ?? ''
  }

  /**
   * One page of threads matching a Gmail search.
   * @param query - Gmail search syntax.
   * @param maxResults - threads per page.
   * @param pageToken - the previous page's token.
   * @returns the thread ids and the next page token.
   */
  async listThreads(query: string, maxResults: number, pageToken?: string): Promise<ThreadList> {
    return GmailApi.parse(threadListSchema, await this.request({
      method: 'GET', path: '/threads', query: { q: query, maxResults, pageToken }, repeatable: true,
    }), 'the thread list')
  }

  /**
   * One thread.
   * @param id - thread id.
   * @param format - `metadata` for headers only, `full` for bodies.
   * @returns the thread.
   */
  async thread(id: string, format: 'metadata' | 'full'): Promise<GmailThread> {
    return GmailApi.parse(threadSchema, await this.request({
      method: 'GET', path: `/threads/${encodeURIComponent(id)}`,
      query: { format, ...format === 'metadata' ? { metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'] } : {} },
      repeatable: true,
    }), 'the thread')
  }

  /**
   * One message.
   * @param id - message id.
   * @param format - `metadata` for headers only, `full` for the body.
   * @returns the message.
   */
  async message(id: string, format: 'metadata' | 'full'): Promise<GmailMessage> {
    return GmailApi.parse(gmailMessageSchema, await this.request({
      method: 'GET', path: `/messages/${encodeURIComponent(id)}`, query: { format }, repeatable: true,
    }), 'the message')
  }

  /**
   * The bytes of one attachment.
   * @param messageId - message id.
   * @param attachmentId - Gmail's attachment id from the same read of the message.
   * @returns the bytes.
   */
  async attachment(messageId: string, attachmentId: string): Promise<Uint8Array> {
    const answer = GmailApi.parse(attachmentSchema, await this.request({
      method: 'GET', path: `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, repeatable: true,
    }), 'the attachment')
    return Buffer.from(answer.data, 'base64url')
  }

  /**
   * Send a composed message.
   * @param raw - the RFC 5322 text.
   * @param threadId - the thread it answers.
   * @returns the sent message's ids.
   */
  async send(raw: string, threadId?: string): Promise<SentMessage> {
    return GmailApi.parse(sentSchema, await this.request({
      method: 'POST', path: '/messages/send', upload: { metadata: threadId === undefined ? {} : { threadId }, message: raw }, repeatable: false,
    }), 'the sent message')
  }

  /**
   * Create a draft.
   * @param raw - the RFC 5322 text.
   * @param threadId - the thread it answers.
   * @returns the draft.
   */
  async createDraft(raw: string, threadId?: string): Promise<GmailDraft> {
    return GmailApi.parse(draftSchema, await this.request({
      method: 'POST', path: '/drafts', upload: { metadata: { message: threadId === undefined ? {} : { threadId } }, message: raw }, repeatable: false,
    }), 'the draft')
  }

  /**
   * Replace a draft's message.
   * @param id - draft id.
   * @param raw - the RFC 5322 text.
   * @param threadId - the thread it answers.
   * @returns the draft.
   */
  async updateDraft(id: string, raw: string, threadId?: string): Promise<GmailDraft> {
    return GmailApi.parse(draftSchema, await this.request({
      method: 'PUT', path: `/drafts/${encodeURIComponent(id)}`,
      upload: { metadata: { id, message: threadId === undefined ? {} : { threadId } }, message: raw }, repeatable: true,
    }), 'the draft')
  }

  /**
   * One draft with its message.
   * @param id - draft id.
   * @returns the draft (`format=full`).
   */
  async draft(id: string): Promise<GmailDraft> {
    return GmailApi.parse(draftSchema, await this.request({
      method: 'GET', path: `/drafts/${encodeURIComponent(id)}`, query: { format: 'full' }, repeatable: true,
    }), 'the draft')
  }

  /**
   * One draft's RFC 5322 text, exactly as `drafts.send` would send it (its `Bcc` header included).
   * @param id - draft id.
   * @returns the text.
   */
  async draftRaw(id: string): Promise<string> {
    const answer = GmailApi.parse(rawDraftSchema, await this.request({
      method: 'GET', path: `/drafts/${encodeURIComponent(id)}`, query: { format: 'raw' }, repeatable: true,
    }), 'the draft')
    return Buffer.from(answer.message.raw, 'base64url').toString('latin1')
  }

  /**
   * Send a draft.
   * @param id - draft id.
   * @returns the sent message's ids.
   */
  async sendDraft(id: string): Promise<SentMessage> {
    return GmailApi.parse(sentSchema, await this.request({ method: 'POST', path: '/drafts/send', json: { id }, repeatable: false }), 'the sent message')
  }

  /**
   * Delete a draft.
   * @param id - draft id.
   */
  async deleteDraft(id: string): Promise<void> {
    await this.request({ method: 'DELETE', path: `/drafts/${encodeURIComponent(id)}`, repeatable: true })
  }

  /**
   * Add and remove labels on a thread.
   * @param id - thread id.
   * @param add - label ids to add.
   * @param remove - label ids to remove.
   */
  async modifyThread(id: string, add: readonly string[], remove: readonly string[]): Promise<void> {
    await this.request({ method: 'POST', path: `/threads/${encodeURIComponent(id)}/modify`, json: { addLabelIds: add, removeLabelIds: remove }, repeatable: true })
  }

  /**
   * Move a thread to the trash, or out of it.
   * @param id - thread id.
   * @param back - true to untrash.
   */
  async trashThread(id: string, back: boolean): Promise<void> {
    await this.request({ method: 'POST', path: `/threads/${encodeURIComponent(id)}/${back ? 'untrash' : 'trash'}`, repeatable: true })
  }

  /**
   * The account's labels.
   * @returns every label.
   */
  async labels(): Promise<GmailLabel[]> {
    return GmailApi.parse(labelListSchema, await this.request({ method: 'GET', path: '/labels', repeatable: true }), 'the label list').labels ?? []
  }
}
