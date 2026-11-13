/**
 * Service fixture for `ctx.gmail`: an in-memory credential store, a fake Google (OAuth token and revocation
 * endpoints plus the Gmail REST API, per mailbox) behind a stubbed global `fetch`, and a mounted Context with Timer,
 * Storage, a memory backend, the domain facility, and a recording notifier.
 */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import type { CredentialInfo, CredentialRecord, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import type { OwnerNote } from '@deepseek-ai/dsh-event-bus'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import Gmail, { Config, GMAIL_SCOPE, type AccountView, type GmailPart, type SendPolicy, type TurnFacts } from '../src/index.ts'
import { gmailDomain } from '../src/storage.ts'

/** 2026-11-12 09:00 New York. */
export const START = Date.parse('2026-11-12T09:00:00-05:00')
export const HOUR = 3_600_000
export const ORIGIN = 'https://dsh.example'
export const CLIENT_ID = 'client-1.apps.googleusercontent.com'
export const CLIENT_SECRET = 'GOCSPX-client-secret-value'
export const CLIENT_ID_REF = 'GMAIL_CLIENT_ID'
export const CLIENT_SECRET_REF = 'GMAIL_CLIENT_SECRET'

/** A clean owner turn whose owner text is the given lines. */
export function ownerTurn(...ownerText: string[]): TurnFacts {
  return { clean: true, origin: 'owner', ownerText, sessionId: 'session-1' }
}

/** A turn that read strangers' words. */
export const TAINTED: TurnFacts = { clean: false, origin: 'owner+gmail_read', ownerText: ['answer that mail'] }

// ── credentials ────────────────────────────────────────────────────────────────

/** The credential calls the service makes, over two maps. */
export class FakeCredentials {
  readonly values = new Map<string, string>()
  readonly records = new Map<string, CredentialRecord>()

  async resolve(ref: string): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return value === undefined ? undefined : { value, source: 'memory' }
  }

  async describe(ref: string): Promise<CredentialInfo> {
    return { configured: this.values.has(ref), writable: true }
  }

  async set(ref: string, value: string): Promise<void> {
    this.values.set(ref, value)
  }

  async readRecord(key: string): Promise<CredentialRecord | undefined> {
    return this.records.get(key)
  }

  async modifyRecord(
    key: string, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const next = await mutate(this.records.get(key))
    if (next !== undefined) this.records.set(key, next)
    return this.records.get(key)
  }

  async deleteRecord(key: string): Promise<void> {
    this.records.delete(key)
  }

  /** The refresh token stored for an account. */
  refreshToken(account: string): string | undefined {
    const record = this.records.get(`gmail/${account}`)
    if (record?.kind !== 'grant') return undefined
    const payload = record.payload as { refreshToken?: unknown }
    return typeof payload.refreshToken === 'string' ? payload.refreshToken : undefined
  }
}

// ── fake Google ────────────────────────────────────────────────────────────────

/** One request the fake received. */
export interface Call {
  readonly method: string
  readonly url: URL
  readonly body: string
  readonly token: string
}

/** One draft a mailbox holds. */
export interface FakeDraft {
  raw: string
  threadId?: string | undefined
  /** `format=full` answers without the message resource. */
  sparse?: boolean | undefined
}

/** One mailbox's Gmail state. */
export interface FakeMailbox {
  readonly email: string
  displayName: string
  readonly messages: Map<string, Record<string, unknown>>
  readonly threads: Map<string, { id: string; messages?: Array<Record<string, unknown>> }>
  readonly drafts: Map<string, FakeDraft>
  readonly attachments: Map<string, string>
  labels: Array<{ id: string; name: string; type?: string }>
  /** Addresses this mailbox wrote to before (its sent mail). */
  readonly sentTo: Set<string>
  /** Messages sent, with the draft they came from. */
  readonly sent: Array<{ raw: string; threadId: string | undefined; draftId: string | undefined }>
  /** Thread ids a search query answers; any other query answers every thread. */
  readonly searches: Map<string, string[]>
}

/** A Google error answer. */
export function googleError(status: number, message: string, reason?: string): Response {
  return Response.json({ error: { code: status, message, ...reason === undefined ? {} : { errors: [{ reason }] } } }, { status })
}

function splitMessage(text: string): { head: string; body: string } {
  const at = text.indexOf('\r\n\r\n')
  return at === -1 ? { head: text, body: '' } : { head: text.slice(0, at), body: text.slice(at + 4) }
}

function parseHeaders(head: string): Array<{ name: string; value: string }> {
  return head.replace(/\r\n[ \t]+/gu, ' ').split('\r\n').filter(line => line !== '').map((line) => {
    const colon = line.indexOf(':')
    return { name: line.slice(0, colon), value: line.slice(colon + 1).trim() }
  })
}

function headerValue(headers: ReadonlyArray<{ name: string; value: string }>, name: string): string {
  return headers.find(entry => entry.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

/** Decode the base64 body of a composed part. */
function base64Body(body: string): Buffer {
  return Buffer.from(body.replace(/\r\n/gu, ''), 'base64')
}

/** The upload body of a send or draft call: its JSON metadata and message text. */
export function uploadParts(call: Call): { metadata: { threadId?: string; message?: { threadId?: string } }; raw: string } {
  const boundary = call.body.slice(2, call.body.indexOf('\r\n'))
  const [, json = '', rfc822 = ''] = call.body.split(`--${boundary}`)
  return {
    metadata: JSON.parse(splitMessage(json.slice(2)).body) as { threadId?: string; message?: { threadId?: string } },
    raw: splitMessage(rfc822.slice(2)).body.slice(0, -2),
  }
}

/** The headers of a composed message, by name. */
export function rawHeader(raw: string, name: string): string {
  return headerValue(parseHeaders(splitMessage(raw).head), name)
}

/** The plain text of a composed message (single part or the first part of a multipart one). */
export function rawText(raw: string): string {
  const { head, body } = splitMessage(raw)
  const boundary = /boundary="([^"]+)"/u.exec(headerValue(parseHeaders(head), 'Content-Type'))?.[1]
  if (boundary === undefined) return base64Body(body).toString('utf8')
  const first = body.split(`--${boundary}`)[1] ?? ''
  return base64Body(splitMessage(first.slice(2)).body).toString('utf8')
}

/**
 * Google, as far as the service reads it. Access tokens map to mailboxes; an unknown token answers 401. `intercept`
 * answers a request first when it returns a response.
 */
export class FakeGoogle {
  readonly calls: Call[] = []
  readonly mailboxes = new Map<string, FakeMailbox>()
  /** The address the next code exchange signs in as. */
  signInEmail = 'owner@example.com'
  /** Scope the token endpoint grants. */
  scope = GMAIL_SCOPE
  /** Refresh answers carry a new refresh token. */
  rotate = false
  /** Refresh answers repeat the refresh token they were given. */
  echo = false
  /** Answer of the revocation endpoint. */
  revokeStatus = 200
  /** Refresh tokens Google no longer accepts. */
  readonly refused = new Set<string>()
  intercept: ((call: Call) => Response | Promise<Response> | undefined) | undefined
  private counter = 0
  private readonly refreshEmail = new Map<string, string>()
  readonly accessEmail = new Map<string, string>()

  /** The mailbox of an address, created on first use. */
  mailbox(email: string): FakeMailbox {
    let box = this.mailboxes.get(email)
    if (box === undefined) {
      box = {
        email, displayName: '', messages: new Map(), threads: new Map(), drafts: new Map(), attachments: new Map(),
        labels: [], sentTo: new Set(), sent: [], searches: new Map(),
      }
      this.mailboxes.set(email, box)
    }
    return box
  }

  /** Calls whose method and path (without the API base) match. */
  callsTo(method: string, path: string | RegExp): Call[] {
    return this.calls.filter(call => call.method === method && (typeof path === 'string' ? apiPath(call.url) === path : path.test(apiPath(call.url))))
  }

  /** Token endpoint calls of one grant type. */
  tokenCalls(grant: 'authorization_code' | 'refresh_token'): URLSearchParams[] {
    return this.calls.filter(call => call.url.href === 'https://oauth2.googleapis.com/token')
      .map(call => new URLSearchParams(call.body)).filter(form => form.get('grant_type') === grant)
  }

  /** The fetch the service sees. */
  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const headers = new Headers(init?.headers)
    const call: Call = {
      method: init?.method ?? 'GET', url, body: typeof init?.body === 'string' ? init.body : '',
      token: (headers.get('authorization') ?? '').replace(/^Bearer /u, ''),
    }
    this.calls.push(call)
    const intercepted = this.intercept?.(call)
    if (intercepted !== undefined) return intercepted
    if (url.host === 'oauth2.googleapis.com') return url.pathname === '/token' ? this.token(new URLSearchParams(call.body)) : this.revoke()
    const email = this.accessEmail.get(call.token)
    if (email === undefined) return googleError(401, 'Request had invalid authentication credentials.')
    return this.gmail(this.mailbox(email), call)
  }

  private token(form: URLSearchParams): Response {
    const access = `access-${++this.counter}`
    if (form.get('grant_type') === 'authorization_code') {
      const refresh = `refresh-${++this.counter}`
      this.refreshEmail.set(refresh, this.signInEmail)
      this.accessEmail.set(access, this.signInEmail)
      return Response.json({ access_token: access, refresh_token: refresh, expires_in: 3600, scope: this.scope, token_type: 'Bearer' })
    }
    const given = form.get('refresh_token') ?? ''
    const email = this.refreshEmail.get(given)
    if (email === undefined || this.refused.has(given)) {
      return Response.json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, { status: 400 })
    }
    this.accessEmail.set(access, email)
    let refresh: string | undefined
    if (this.rotate) {
      refresh = `refresh-${++this.counter}`
      this.refreshEmail.set(refresh, email)
    } else if (this.echo) {
      refresh = given
    }
    const rotated = refresh === undefined ? {} : { refresh_token: refresh }
    return Response.json({ access_token: access, expires_in: 3600, scope: this.scope, ...rotated })
  }

  private revoke(): Response {
    return new Response(null, { status: this.revokeStatus })
  }

  /** The draft resource of `format=full`. */
  private draftResource(box: FakeMailbox, id: string, draft: FakeDraft): Record<string, unknown> {
    if (draft.sparse === true) return { id }
    const { head, body } = splitMessage(draft.raw)
    const headers = parseHeaders(head)
    const type = headerValue(headers, 'Content-Type')
    const boundary = /boundary="([^"]+)"/u.exec(type)?.[1]
    let payload: GmailPart
    if (boundary === undefined) {
      payload = { mimeType: type.split(';')[0] ?? 'text/plain', headers, body: { data: base64Body(body).toString('base64url') } }
    } else {
      const sections = body.split(`--${boundary}`).slice(1, -1)
      payload = {
        mimeType: 'multipart/mixed', headers,
        parts: sections.map((section, index): GmailPart => {
          const part = splitMessage(section.slice(2))
          const partHeaders = parseHeaders(part.head)
          const bytes = base64Body(part.body)
          const filename = /filename="([^"]*)"/u.exec(headerValue(partHeaders, 'Content-Disposition'))?.[1] ?? ''
          const mimeType = headerValue(partHeaders, 'Content-Type').split(';')[0]
          if (filename === '') return { partId: String(index), mimeType, headers: partHeaders, body: { data: bytes.toString('base64url'), size: bytes.length } }
          const attachmentId = `att-${id}-${index}`
          box.attachments.set(attachmentId, bytes.toString('base64url'))
          return { partId: String(index), mimeType, filename, headers: partHeaders, body: { attachmentId, size: bytes.length } }
        }),
      }
    }
    return { id, message: { id: `m-${id}`, ...draft.threadId === undefined ? {} : { threadId: draft.threadId }, payload } }
  }

  private gmail(box: FakeMailbox, call: Call): Response {
    const path = apiPath(call.url)
    const route = `${call.method} ${path}`
    const notFound = googleError(404, 'Requested entity was not found.', 'notFound')
    const empty = new Response(null, { status: 204 })
    let match: RegExpExecArray | null
    if (route === 'GET /profile') return Response.json({ emailAddress: box.email, messagesTotal: box.messages.size, threadsTotal: box.threads.size })
    if (route === 'GET /settings/sendAs') return Response.json({ sendAs: [{ sendAsEmail: box.email, displayName: box.displayName, isPrimary: true }] })
    if (route === 'GET /labels') return Response.json({ labels: box.labels })
    if (route === 'GET /threads') {
      const query = call.url.searchParams.get('q') ?? ''
      const sent = /^in:sent \(to:"([^"]+)"/u.exec(query)?.[1]
      if (sent !== undefined) return Response.json(box.sentTo.has(sent) ? { threads: [{ id: 'sent-thread' }], resultSizeEstimate: 1 } : { resultSizeEstimate: 0 })
      const ids = box.searches.get(query) ?? [...box.threads.keys()]
      const max = Number(call.url.searchParams.get('maxResults'))
      return Response.json(ids.length === 0 ? { resultSizeEstimate: 0 } : { threads: ids.slice(0, max).map(id => ({ id, snippet: `entry ${id}` })) })
    }
    if ((match = /^GET \/threads\/([^/]+)$/u.exec(route)) !== null) {
      const thread = box.threads.get(decodeURIComponent(match[1] ?? ''))
      return thread === undefined ? notFound : Response.json(thread)
    }
    if ((match = /^POST \/threads\/([^/]+)\/(modify|trash|untrash)$/u.exec(route)) !== null) {
      return box.threads.has(decodeURIComponent(match[1] ?? '')) ? Response.json({}) : notFound
    }
    if ((match = /^GET \/messages\/([^/]+)\/attachments\/([^/]+)$/u.exec(route)) !== null) {
      const data = box.attachments.get(decodeURIComponent(match[2] ?? ''))
      return data === undefined ? notFound : Response.json({ data, size: Buffer.from(data, 'base64url').length })
    }
    if ((match = /^GET \/messages\/([^/]+)$/u.exec(route)) !== null) {
      const message = box.messages.get(decodeURIComponent(match[1] ?? ''))
      return message === undefined ? notFound : Response.json(message)
    }
    if (route === 'POST /messages/send') {
      const { metadata, raw } = uploadParts(call)
      box.sent.push({ raw, threadId: metadata.threadId, draftId: undefined })
      return Response.json({ id: `sent-${box.sent.length}`, threadId: metadata.threadId ?? `thread-sent-${box.sent.length}`, labelIds: ['SENT'] })
    }
    if (route === 'POST /drafts') {
      const { metadata, raw } = uploadParts(call)
      const id = `d${++this.counter}`
      box.drafts.set(id, { raw, threadId: metadata.message?.threadId })
      return Response.json({ id, message: { id: `m-${id}`, ...metadata.message?.threadId === undefined ? {} : { threadId: metadata.message.threadId } } })
    }
    if ((match = /^PUT \/drafts\/([^/]+)$/u.exec(route)) !== null) {
      const id = decodeURIComponent(match[1] ?? '')
      if (!box.drafts.has(id)) return notFound
      const { metadata, raw } = uploadParts(call)
      box.drafts.set(id, { raw, threadId: metadata.message?.threadId })
      return Response.json({ id, message: { id: `m-${id}`, ...metadata.message?.threadId === undefined ? {} : { threadId: metadata.message.threadId } } })
    }
    if ((match = /^(GET|DELETE) \/drafts\/([^/]+)$/u.exec(route)) !== null) {
      const id = decodeURIComponent(match[2] ?? '')
      const draft = box.drafts.get(id)
      if (draft === undefined) return notFound
      if (call.method === 'DELETE') {
        box.drafts.delete(id)
        return empty
      }
      return Response.json(call.url.searchParams.get('format') === 'raw'
        ? { id, message: { raw: Buffer.from(draft.raw, 'latin1').toString('base64url') } }
        : this.draftResource(box, id, draft))
    }
    if (route === 'POST /drafts/send') {
      const id = (JSON.parse(call.body) as { id: string }).id
      const draft = box.drafts.get(id)
      if (draft === undefined) return notFound
      box.drafts.delete(id)
      box.sent.push({ raw: draft.raw, threadId: draft.threadId, draftId: id })
      return Response.json({ id: `sent-${box.sent.length}`, threadId: draft.threadId ?? `thread-sent-${box.sent.length}`, labelIds: ['SENT'] })
    }
    return googleError(400, `the fake has no route ${route}`)
  }
}

/** The path of a Gmail call under its API or upload base. */
export function apiPath(url: URL): string {
  return url.pathname.replace(/^\/(?:upload\/)?gmail\/v1\/users\/me/u, '')
}

// ── mounting ───────────────────────────────────────────────────────────────────

export interface MountOptions {
  readonly pool?: MemoryMediaPool | undefined
  readonly config?: Partial<Config> | undefined
  readonly credentials?: FakeCredentials | undefined
  readonly google?: FakeGoogle | undefined
  /** No OAuth client stored. */
  readonly noClient?: boolean | undefined
  /** No ownerNotifier service. */
  readonly noNotifier?: boolean | undefined
  /** The notifier throws this value. */
  readonly notifierThrows?: unknown
}

export interface Mounted {
  readonly ctx: Context
  readonly fiber: Fiber
  readonly gmail: Gmail
  readonly facility: DomainFacility
  readonly credentials: FakeCredentials
  readonly google: FakeGoogle
  readonly pool: MemoryMediaPool
  readonly notes: OwnerNote[]
  readonly logs: string[]
}

const contexts: Context[] = []

/** Dispose every Context the specs mounted. */
export async function disposeAll(): Promise<void> {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
}

/** A Context with Timer, Storage over a memory backend on the pool, and the domain facility. */
async function storageHost(pool: MemoryMediaPool): Promise<{ ctx: Context; facility: DomainFacility; logs: string[] }> {
  const ctx = new Context()
  contexts.push(ctx)
  const logs: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push(`${message.type} ${String(message.args[0])}`) } })
  await ctx.plugin(Timer)
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  ctx.effect(() => async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => {
      await facility.closeAll()
      unmount()
    }
  })
  return { ctx, facility, logs }
}

/** A Context with storage, the domain facility, and the given credentials and notifier, without the service. */
export async function host(options: MountOptions = {}): Promise<Omit<Mounted, 'gmail' | 'fiber'>> {
  const pool = options.pool ?? new MemoryMediaPool()
  const { ctx, facility, logs } = await storageHost(pool)
  const credentials = options.credentials ?? new FakeCredentials()
  if (options.noClient !== true && options.credentials === undefined) {
    credentials.values.set(CLIENT_ID_REF, CLIENT_ID)
    credentials.values.set(CLIENT_SECRET_REF, CLIENT_SECRET)
  }
  ctx.provide('credentials', credentials)
  const notes: OwnerNote[] = []
  if (options.noNotifier !== true) {
    ctx.provide('ownerNotifier', {
      send: async (note: OwnerNote) => {
        if (options.notifierThrows !== undefined) throw options.notifierThrows
        notes.push(note)
      },
    })
  }
  const google = options.google ?? new FakeGoogle()
  vi.stubGlobal('fetch', vi.fn(google.fetch))
  return { ctx, facility, credentials, google, pool, notes, logs }
}

/** Mount the service. */
export async function mount(options: MountOptions = {}): Promise<Mounted> {
  const base = await host(options)
  const fiber = await base.ctx.plugin(Gmail, Config((options.config ?? {}) as Config))
  await vi.advanceTimersByTimeAsync(0)
  return { ...base, fiber, gmail: base.ctx.gmail }
}

/** Connect an account through the sign-in flow as `email`. */
export async function connect(env: Mounted, account: string, email: string, policy?: SendPolicy): Promise<AccountView> {
  const { url } = await env.gmail.beginSignIn({ account, origin: ORIGIN, ...policy === undefined ? {} : { policy } })
  env.google.signInEmail = email
  env.google.mailbox(email)
  return env.gmail.completeSignIn({ state: new URL(url).searchParams.get('state') ?? '', code: `code-${account}` })
}

/** Open the Gmail domain on a pool directly while no service holds it: to read rows Settings does not show, or to seed stored rows. */
export async function withDomain<T>(pool: MemoryMediaPool, read: (domain: Domain<typeof gmailDomain>) => T | Promise<T>): Promise<T> {
  const { facility } = await storageHost(pool)
  const domain = await facility.open(gmailDomain)
  try {
    return await read(domain)
  } finally {
    await domain.close()
  }
}

/** The rejection of a promise, which must reject. */
export async function rejection(promise: Promise<unknown>): Promise<Error> {
  const error: unknown = await promise.then(() => undefined, (caught: unknown) => caught)
  if (!(error instanceof Error)) throw new Error(`expected a rejection with an Error, got ${String(error)}`)
  return error
}
