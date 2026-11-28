import { z } from 'zod'
import { validateText, type CommandRunner } from './repo.ts'

const REPO = 'StevenLi-phoenix/jobapplication'
const LABELS = new Map([
  ['approval', 'needs-approval'], ['question', 'question'], ['owner', 'owner-action'], ['upload', 'upload'],
])
/** The tracker API's own lifecycle states; an unfinished form is `queued` with a step. */
export const TRACKER_STATUSES = ['queued', 'applied', 'skipped', 'rejected', 'interviewing', 'offer'] as const
/** Posting sources the tracker accepts in a row's `source` field. */
export const TRACKER_SOURCES = ['handshake', 'linkedin', 'company_site', 'referral'] as const
const STATUSES = new Set<string>(TRACKER_STATUSES)
const SOURCES = new Set<string>(TRACKER_SOURCES)
const DAY = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u
const ISSUE = z.object({ number: z.number().int().positive(), title: z.string(), state: z.enum(['OPEN', 'CLOSED']), body: z.string(), labels: z.array(z.object({ name: z.string() })) })
const ISSUE_ID = ISSUE.pick({ number: true, state: true })
const COMMENT = z.object({ author: z.object({ login: z.string() }).nullable().optional(), body: z.string(), createdAt: z.string() })
const ISSUE_THREAD = ISSUE.extend({ comments: z.array(COMMENT) })
const MAX_COMMENTS = 20
const TRACKER_BASE = 'https://mcp.lishuyu.app/api/jobtracker/'
const TRACKER_MAX_RESPONSE = 50_000
// A list without a status reads every row (about 1 KB each), so it gets a larger read cap than a write.
const TRACKER_LIST_MAX_RESPONSE = 8_000_000
const LIST_MAX_ROWS = 40
const LIST_FULL_NOTES = 5
const LIST_NOTE_CHARS = 300
const TRACKER_ROW = z.object({
  id: z.string(), status: z.string(), company: z.string(), role: z.string(),
  url: z.string().nullish(), location: z.string().nullish(), source: z.string().nullish(),
  date_applied: z.string().nullish(), deadline: z.string().nullish(), notes: z.string().nullish(), updated_at: z.string().nullish(),
})
type TrackerRow = z.infer<typeof TRACKER_ROW>
const TRACKER_LIST = z.union([z.array(TRACKER_ROW), z.object({ result: z.array(TRACKER_ROW) }).transform(value => value.result)])
const TRACKING_PARAM = /^(?:utm_.*|gh_src|ref|src|source|lever-source|lever-origin|trk|trackingid|refid)$/iu

interface TrackerArguments {
  operation: 'append' | 'update'
  id?: string | undefined
  company: string
  role: string
  url: string
  status: string
  step?: number | undefined
  note?: string | undefined
  location?: string | undefined
  source?: string | undefined
  date_applied?: string | undefined
  deadline?: string | undefined
  visa_flag?: boolean | undefined
  requires_cover_letter?: boolean | undefined
}

function postingUrl(value: string): string {
  const parsed = URL.parse(value)
  if (value.length > 2048 || /[\s\\"'`<>\p{Cc}]/u.test(value) || parsed?.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.port !== '' || !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/u.test(parsed.hostname)) {
    throw new Error('Use a public HTTPS posting URL, without credentials or an absolute file path.')
  }
  if (/(?:^|\.)(?:local|localhost|internal|invalid|test)$/u.test(parsed.hostname)) throw new Error('Use a public HTTPS posting URL.')
  return parsed.href
}

/**
 * Validate a single tracker row and produce a fixed endpoint selector and JSON body.
 * @param args Model-supplied row fields.
 * @returns The endpoint selector and JSON payload.
 */
export function trackerCall(args: TrackerArguments): ['add_application' | 'update_application', string] {
  const company = validateText(args.company, 'company', 180)
  const role = validateText(args.role, 'role', 240)
  const url = postingUrl(args.url)
  if (!STATUSES.has(args.status)) throw new Error('Unsupported tracker status.')
  if (args.operation === 'update' && (args.id === undefined || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(args.id))) throw new Error('Updating a row requires its existing row UUID.')
  if (args.operation === 'append' && args.id !== undefined) throw new Error('Do not supply an id when appending a new row.')
  if (args.step !== undefined && (!Number.isSafeInteger(args.step) || args.step < 1 || args.step > 999)) throw new Error('step must be an integer from 1 through 999.')
  const note = args.note === undefined ? undefined : validateText(args.note, 'note', 1500)
  const notes = args.step === undefined ? note : `Step ${args.step}${note === undefined ? '' : `: ${note}`}`
  // add_application requires location and source; update keeps the stored values when they are omitted.
  if (args.operation === 'append' && (args.location === undefined || args.source === undefined)) {
    throw new Error('Appending a row requires location (NYC, Remote, Hybrid or a city) and source.')
  }
  const location = args.location === undefined ? undefined : validateText(args.location, 'location', 200)
  if (args.source !== undefined && !SOURCES.has(args.source)) throw new Error('source must be handshake, linkedin, company_site or referral.')
  for (const [field, value] of [['date_applied', args.date_applied], ['deadline', args.deadline]] as const) {
    if (value !== undefined && !DAY.test(value)) throw new Error(`${field} must be a YYYY-MM-DD date.`)
  }
  if (args.status === 'applied' && args.operation === 'append' && args.date_applied === undefined) {
    throw new Error('An applied row needs date_applied (YYYY-MM-DD).')
  }
  const body = {
    id: args.id, company, role, url, status: args.status, notes, location, source: args.source,
    date_applied: args.date_applied, deadline: args.deadline, visa_flag: args.visa_flag, requires_cover_letter: args.requires_cover_letter,
  }
  return [args.operation === 'append' ? 'add_application' : 'update_application', JSON.stringify(body)]
}

class TrackerResponseError extends Error {}

async function trackerResponse(response: Response, limit: number): Promise<string> {
  if (response.body === null) throw new TrackerResponseError('Jobtracker returned no response body.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let result = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return result + decoder.decode()
      bytes += chunk.value.byteLength
      if (bytes > limit) {
        await reader.cancel()
        throw new TrackerResponseError('Jobtracker response exceeded the size limit.')
      }
      result += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Write a single row to the host-pinned tracker, without following redirects or using the job clone.
 * @param args Model-supplied row fields.
 * @param token Service-provisioned token, never supplied by the tool caller.
 * @param signal Cancellation from tool execution.
 * @param request HTTP transport.
 * @returns Bounded response text without the supplied bearer token.
 */
export async function writeTrackerRow(
  args: TrackerArguments, token: string | undefined, signal: AbortSignal, request = fetch,
): Promise<string> {
  const [endpoint, body] = trackerCall(args)
  return callTracker(endpoint, body, token, signal, request)
}

/** Optional list filters; company, role and URL search every status. */
export interface TrackerFilter {
  status?: string | undefined
  company?: string | undefined
  role?: string | undefined
  url?: string | undefined
}

/** Lowercase letters and digits only, so "TikTok Inc." matches "tiktok" and "Software-Engineer" matches "software engineer". */
function fold(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Host without www plus path without a trailing slash, the part two copies of a posting link share. */
function urlKey(value: string | null | undefined): string {
  const parsed = URL.parse(value ?? '')
  if (parsed === null) return fold(value)
  return `${parsed.hostname.replace(/^www\./u, '')}${parsed.pathname.replace(/\/$/u, '')}`.toLowerCase()
}

/** Either side contains the other, so a role with or without its requisition number still matches. */
function overlaps(stored: string, wanted: string): boolean {
  return stored !== '' && wanted !== '' && (stored.includes(wanted) || wanted.includes(stored))
}

function compactRow(row: TrackerRow, fullNotes: boolean): Record<string, string | null | undefined> {
  const notes = row.notes ?? ''
  return {
    id: row.id, status: row.status, company: row.company, role: row.role, url: row.url, location: row.location, source: row.source,
    date_applied: row.date_applied, deadline: row.deadline, updated_at: row.updated_at,
    notes: fullNotes || notes.length <= LIST_NOTE_CHARS ? notes : `${notes.slice(0, 100)} … ${notes.slice(-(LIST_NOTE_CHARS - 100))}`,
  }
}

/**
 * List tracker rows. A company, role or URL filter reads every status and matches ignoring case and punctuation;
 * otherwise the tracker filters by status. Output is bounded: at most 40 rows, with full notes only when 5 or fewer match.
 * @param filter Model-supplied filters, fillers already removed.
 * @param token Service-provisioned token.
 * @param signal Cancellation from tool execution.
 * @param request HTTP transport.
 * @returns JSON text without the supplied bearer token.
 */
export async function listTrackerRows(
  filter: TrackerFilter, token: string | undefined, signal: AbortSignal, request = fetch,
): Promise<string> {
  const { status } = filter
  if (status !== undefined && !STATUSES.has(status)) throw new Error('Unsupported tracker status.')
  // Filters are only compared locally and never sent, so they need bounds, not the write-side injection checks.
  const bounded = (value: string | undefined, field: string): string | undefined => {
    if (value === undefined) return undefined
    if (Buffer.byteLength(value) > 2048 || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error(`The ${field} filter must be plain text up to 2048 bytes.`)
    return value
  }
  const company = bounded(filter.company, 'company') === undefined ? undefined : fold(filter.company)
  const role = bounded(filter.role, 'role') === undefined ? undefined : fold(filter.role)
  const url = bounded(filter.url, 'url') === undefined ? undefined : urlKey(filter.url)
  const search = company !== undefined || role !== undefined || url !== undefined
  const body = JSON.stringify(search || status === undefined ? {} : { status })
  const text = await callTracker('list_applications', body, token, signal, request, TRACKER_LIST_MAX_RESPONSE)
  let rows: TrackerRow[]
  try {
    rows = TRACKER_LIST.parse(JSON.parse(text))
  } catch {
    throw new Error('Jobtracker returned an unexpected list response.')
  }
  let matched = rows
  let fallback: string | undefined
  if (search) {
    const byCompany = company === undefined ? rows : rows.filter(row => overlaps(fold(row.company), company))
    const roleMatches = (row: TrackerRow) => role === undefined || overlaps(fold(row.role), role)
    matched = byCompany.filter(row => roleMatches(row) && (url === undefined || urlKey(row.url) === url))
    if (matched.length === 0 && company !== undefined && byCompany.length > 0) {
      matched = byCompany
      fallback = 'No row matched the role or URL; these are every row for the company.'
    }
  }
  const shown = matched.slice(0, LIST_MAX_ROWS)
  const fullNotes = matched.length <= LIST_FULL_NOTES
  return JSON.stringify({
    filter: search ? { company: filter.company, role: filter.role, url: filter.url, statuses: 'all' } : { status: status ?? 'all' },
    matched: matched.length,
    ...(fallback === undefined ? {} : { note: fallback }),
    ...(matched.length > shown.length ? { omitted: matched.length - shown.length, hint: 'Newest first; add company, role or url to narrow.' } : {}),
    ...(fullNotes ? {} : {
      notes: `Notes are shortened when more than ${LIST_FULL_NOTES} rows match; list by company and role to read a row's full notes before an update.`,
    }),
    rows: shown.map(row => compactRow(row, fullNotes)),
  })
}

async function callTracker(
  endpoint: 'add_application' | 'update_application' | 'list_applications', body: string, token: string | undefined, signal: AbortSignal,
  request: typeof fetch, limit = TRACKER_MAX_RESPONSE,
): Promise<string> {
  if (token === undefined || !token.trim()) throw new Error('Jobtracker requires JOBTRACKER_PAT in the service environment.')
  signal.throwIfAborted()
  const write = endpoint !== 'list_applications'
  const unsure = write ? '; do not assume the write landed.' : '.'
  try {
    const response = await request(`${TRACKER_BASE}${endpoint}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      redirect: 'error', body, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    })
    if (response.status === 200) return (await trackerResponse(response, limit)).replaceAll(token, '[redacted]')
    await response.body?.cancel()
  } catch (error) {
    // Fetch errors can retain the entire request, including the authorization header, so only our own messages pass.
    signal.throwIfAborted()
    if (error instanceof TrackerResponseError) throw new Error(`${error.message.replace(/\.$/u, '')}${unsure}`)
    throw new Error(`The fixed jobtracker request did not complete${unsure}`)
  }
  throw new Error(`Jobtracker returned an unsuccessful HTTP response${unsure}`)
}

function issueMarker(kind: string, ref: string): string {
  if (/^[a-z0-9][a-z0-9-]{0,79}$/u.test(ref)) return `<!-- job-apply-key: ${kind}:${ref} -->`
  const url = new URL(postingUrl(ref))
  const host = url.hostname.replace(/^www\./u, '')
  const path = url.pathname.replace(/\/$/u, '')
  const query = url.search.slice(1).split('&').filter((param) => {
    const name = /^[^=]+/u.exec(param)?.[0]
    return name !== undefined && !TRACKING_PARAM.test(name)
  }).join('&')
  return `<!-- job-apply-key: ${kind}:https://${host}${path}${query ? `?${query}` : ''} -->`
}

/** Drop the oldest entries of an insertion-ordered map until one more entry fits under `bound`. */
function makeRoom<K, V>(map: Map<K, V>, bound: number): void {
  for (const key of map.keys()) {
    if (map.size < bound) return
    map.delete(key)
  }
}

function labelOf(kind: string): string {
  const label = LABELS.get(kind)
  if (label === undefined) throw new Error('Use approval, question, owner, or upload. Record an unfinished posting in jobtracker with status queued and a step, not as an issue.')
  return label
}

/** Fixed issue commands for one repository; a Session can only close an item from its own open list. */
export class IssueItems {
  readonly #listed = new Map<string, Map<number, string>>()
  readonly #recent = new Map<string, number>()

  constructor(private readonly run: CommandRunner) {}

  /**
   * List a bounded page, marking shown open items eligible for a later close.
   * @param session - trusted identity of the calling Session; its eligible-item set is updated.
   * @param kind - workflow kind: approval, question, owner or upload.
   * @param state - which issue states to list.
   * @param limit - maximum issues to fetch, an integer from 1 through 50.
   * @param signal - cancellation of the GitHub command.
   * @returns a JSON array of issues (number, title, state, body cut to 2500 characters, labels).
   * @throws Error - when the kind is unknown or the limit is out of range.
   */
  async list(session: string, kind: string, state: 'open' | 'closed' | 'all', limit: number, signal: AbortSignal): Promise<string> {
    const label = labelOf(kind)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Issue limit must be an integer from 1 through 50.')
    const result = await this.run('gh', ['issue', 'list', '-R', REPO, '--label', label, '--state', state, '--limit', String(limit), '--json', 'number,title,state,body,labels'], signal)
    const issues = ISSUE.array().parse(JSON.parse(result)).filter(issue => issue.labels.some(item => item.name === label))
    const allowed = this.#listed.get(session) ?? new Map<number, string>()
    if (!this.#listed.has(session)) makeRoom(this.#listed, 512)
    this.#listed.set(session, allowed)
    for (const issue of issues) {
      if (issue.state === 'CLOSED') { allowed.delete(issue.number); continue }
      makeRoom(allowed, 250)
      allowed.set(issue.number, label)
    }
    return JSON.stringify(issues.map(issue => ({ ...issue, body: issue.body.slice(0, 2500) })))
  }

  /**
   * Read one issue with its latest comments; the owner answers questions and approvals there.
   * An open item with a workflow label becomes eligible for a later comment or close in this Session.
   * @param session - trusted identity of the calling Session; its eligible-item set is updated.
   * @param number - GitHub issue number, a positive integer.
   * @param signal - cancellation of the GitHub command.
   * @returns a JSON object of the issue with its last 20 comments (each cut to 1500 characters) and the omitted-comment count.
   * @throws Error - when the number is invalid or GitHub returns a different issue.
   */
  async view(session: string, number: number, signal: AbortSignal): Promise<string> {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Issue number must be a positive integer.')
    const result = await this.run('gh', ['issue', 'view', String(number), '-R', REPO, '--json', 'number,title,state,body,labels,comments'], signal)
    const issue = ISSUE_THREAD.parse(JSON.parse(result))
    if (issue.number !== number) throw new Error('GitHub returned an unexpected issue number.')
    const label = issue.labels.map(item => item.name).find(name => [...LABELS.values()].includes(name))
    if (issue.state === 'OPEN' && label !== undefined) {
      const allowed = this.#listed.get(session) ?? new Map<number, string>()
      this.#listed.set(session, allowed)
      allowed.set(number, label)
    }
    const comments = issue.comments.slice(-MAX_COMMENTS).map(comment => ({
      author: comment.author?.login ?? 'unknown', createdAt: comment.createdAt, body: comment.body.slice(0, 1500),
    }))
    const omittedComments = Math.max(0, issue.comments.length - MAX_COMMENTS)
    return JSON.stringify({ ...issue, body: issue.body.slice(0, 2500), comments, omittedComments })
  }

  /**
   * Post a bounded comment only to a currently open item previously listed in this Session.
   * @param session - trusted identity of the calling Session.
   * @param number - GitHub issue number previously listed or viewed in this Session.
   * @param text - comment body, validated to at most 1500 characters.
   * @param signal - cancellation of the GitHub command.
   * @returns a one-line confirmation naming the issue.
   * @throws Error - when the text is invalid, or the issue was not listed in this Session or is no longer open with its label.
   */
  async comment(session: string, number: number, text: string, signal: AbortSignal): Promise<string> {
    const body = validateText(text, 'text', 1500)
    await this.#listedOpen(session, number, signal)
    await this.run('gh', ['issue', 'comment', String(number), '-R', REPO, `--body=${body}`], signal)
    return `Commented on #${number}.`
  }

  async #listedOpen(session: string, number: number, signal: AbortSignal): Promise<void> {
    const label = this.#listed.get(session)?.get(number)
    if (label === undefined) throw new Error('List this workflow’s open issues in this Session before changing one.')
    const current = await this.run('gh', ['issue', 'view', String(number), '-R', REPO, '--json', 'number,title,state,body,labels'], signal)
    const issue = ISSUE.parse(JSON.parse(current))
    if (issue.number !== number || issue.state !== 'OPEN' || !issue.labels.some(item => item.name === label)) throw new Error('Issue is no longer open with that workflow label.')
  }

  /**
   * Close a previously listed open item, after confirming current state and workflow label.
   * @param session - trusted identity of the calling Session; the item leaves its eligible set.
   * @param number - GitHub issue number previously listed or viewed in this Session.
   * @param reason - closure reason: `completed` or `not planned`.
   * @param signal - cancellation of the GitHub command.
   * @returns a one-line confirmation naming the issue and reason.
   * @throws Error - when the reason is invalid, or the issue was not listed in this Session or is no longer open with its label.
   */
  async close(session: string, number: number, reason: string, signal: AbortSignal): Promise<string> {
    if (reason !== 'completed' && reason !== 'not planned') throw new Error('Closure reason must be completed or not planned.')
    await this.#listedOpen(session, number, signal)
    await this.run('gh', ['issue', 'close', String(number), '-R', REPO, '--reason', reason], signal)
    this.#listed.get(session)?.delete(number)
    return `Closed #${number} as ${reason}.`
  }

  /**
   * Create a workflow issue unless GitHub already reports the same workflow key.
   * @param kind - workflow kind: approval, question, owner or upload.
   * @param ref - dedup reference: a lowercase slug of at most 80 characters, or a posting URL; it forms the workflow key with the kind.
   * @param title - issue title, validated to at most 200 characters.
   * @param text - issue body, validated to at most 1500 characters; the workflow key is appended to it.
   * @param signal - cancellation of the GitHub commands.
   * @returns `open <number>` or `closed <number>` when the key already has an issue, otherwise `created <number>`.
   * @throws Error - when an argument is invalid or GitHub does not return the expected issue URL.
   */
  async create(kind: string, ref: string, title: string, text: string, signal: AbortSignal): Promise<string> {
    const label = labelOf(kind)
    const marker = issueMarker(kind, ref)
    const safeTitle = validateText(title, 'title', 200)
    const safeBody = validateText(text, 'text', 1500)
    // Only base64 characters are inserted into jq source; the decoded value is used solely as a string.
    const encoded = Buffer.from(marker).toString('base64')
    const filter = `[.[] | select(.body | split("\\n") | index("${encoded}" | @base64d)) | {number,state}] | sort_by(.state != "OPEN") | .[:1]`
    const found = await this.run('gh', ['issue', 'list', '-R', REPO, '--label', label, '--state', 'all', '--limit', '2000', '--json', 'number,state,body', '--jq', filter], signal)
    const [existing] = ISSUE_ID.array().max(1).parse(JSON.parse(found))
    if (existing !== undefined) return `${existing.state.toLowerCase()} ${existing.number}`
    // Cover the GitHub list's visibility lag without reading a worktree journal.
    const recent = this.#recent.get(marker)
    if (recent !== undefined) {
      const current = await this.run('gh', ['issue', 'view', String(recent), '-R', REPO, '--json', 'number,state'], signal)
      const issue = ISSUE_ID.parse(JSON.parse(current))
      if (issue.number !== recent) throw new Error('GitHub returned an unexpected issue number.')
      return `${issue.state.toLowerCase()} ${issue.number}`
    }
    const output = await this.run('gh', ['issue', 'create', '-R', REPO, `--title=${safeTitle}`, `--body=${safeBody}\n\n${marker}`, '--label', label, '--assignee', '@me'], signal)
    const url = output.trim()
    const prefix = `https://github.com/${REPO}/issues/`
    const number = Number(url.slice(prefix.length))
    if (!url.startsWith(prefix) || !Number.isSafeInteger(number) || number < 1 || url !== `${prefix}${number}`) {
      throw new Error('GitHub did not return the expected issue URL; do not assume the action landed.')
    }
    makeRoom(this.#recent, 250)
    this.#recent.set(marker, number)
    return `created ${number}`
  }
}

/**
 * Strict-schema providers (Codex, the deployment's default route) send every declared property and fill the unused
 * ones with '', [], 0 or false. Treat those fillers as absent, so each operation reads only the fields it uses and
 * never fails because a field it does not use was sent (2026-11-27: the first job-lead run looped on read_runbook).
 * @param args - model-supplied arguments.
 * @param keepFalse - keep `false` booleans (an append states them; an update would overwrite a stored true).
 * @returns the arguments without filler values.
 */
export function present<T extends Record<string, unknown>>(args: T, keepFalse = true): Partial<T> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined && value !== null && value !== ''
    && value !== 0 && !(Array.isArray(value) && value.length === 0) && (keepFalse || value !== false))) as Partial<T>
}
