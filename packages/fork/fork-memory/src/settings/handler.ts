/**
 * The Memory settings route's request handler. The owner reaches it through the Web UI's sign-in (the
 * connection answers 403 to everyone else), and no agent tool calls it: it registers nothing the model
 * sees, so a waiting write cannot be approved by the Session that wrote it. Every change goes through the
 * same store functions as the `memory-admin` CLI, with the history label `settings`.
 */

import {
  describeRollback, planPurge, purgeConfirmed, purgeToken, reviewWrite, rollbackConfirmed, rollbackToken,
} from '../admin.ts'
import { FeedbackError, type FeedbackStore } from '../feedback.ts'
import { MemoryError, type MemoryStore, type RollbackFilter } from '../store.ts'
import z from '@deepseek-ai/schemastery'
import { clip, readDetail, readView } from './read.ts'
import {
  CATEGORIES, MAX_IDS, MAX_PAGE_SIZE, PAGE_SIZE,
  type ActionResult, type ItemResult, type MemoryAction, type MemoryQuery, type PurgePreviewItem, type RollbackPreviewItem,
} from './view.ts'

/** History label of a change made from Settings. */
export const SETTINGS_ORIGIN = 'settings'

/** The logger methods the handler uses. */
export interface HandlerLogger {
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
}

/** What the handler works on. */
export interface HandlerDeps {
  readonly store: MemoryStore
  readonly feedback: FeedbackStore
  readonly logger: HandlerLogger
  /** Clock in milliseconds, injectable for tests. */
  readonly now?: () => number
}

const ID = /^[0-9a-f]{6}$/u
const TOKEN = /^[0-9a-f]{64}$/u
const ids = z.array(z.string().required().pattern(ID)).required().min(1).max(MAX_IDS)
const SESSION_MAX = 80

const ACTION_SCHEMAS = {
  'approve': z.object({ ids }),
  'discard': z.object({ ids }),
  'revert': z.object({ ids }),
  'rollback': z.object({
    session: z.string().max(SESSION_MAX),
    since: z.string().max(40),
    confirm: z.string().pattern(TOKEN),
  }),
  'forget': z.object({ ids, confirm: z.string().pattern(TOKEN) }),
  'feedback.add': z.object({
    scope: z.union(['up', 'bili']).required(),
    verdict: z.union(['keep', 'delete']).required(),
    kind: z.union(['comment', 'dm']).required(),
    text: z.string().required(),
    ref: z.string(),
    note: z.string(),
  }),
  'feedback.forget': z.object({ id: z.string().required().pattern(ID) }),
} as const

const GET_SCHEMA = z.object({
  q: z.string().max(200).default(''),
  category: z.union(['all', ...CATEGORIES]).default('all'),
  offset: z.natural().default(0),
  limit: z.natural().min(1).max(MAX_PAGE_SIZE).default(PAGE_SIZE),
  id: z.string().pattern(ID),
})

/** A refused request: the status and a message that carries no request data. */
class Refusal extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message)
  }
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

function isAction(name: string): name is keyof typeof ACTION_SCHEMAS {
  return Object.hasOwn(ACTION_SCHEMAS, name)
}

/**
 * Read a rollback's filter: a Session id, or a time normalised to the `toISOString()` form the history compares against.
 * @param body - the validated action body.
 */
function rollbackFilter(body: { session?: string; since?: string }): RollbackFilter {
  if (body.session === undefined && body.since === undefined) throw new Refusal(400, 'give a session or a since time to roll back')
  let since: string | undefined
  if (body.since !== undefined) {
    const time = Date.parse(body.since)
    if (Number.isNaN(time)) throw new Refusal(400, 'since is not a time')
    since = new Date(time).toISOString()
  }
  return { ...body.session === undefined ? {} : { session: body.session }, ...since === undefined ? {} : { since } }
}

const failure = (error: unknown): { code: string; message: string } | undefined => {
  if (error instanceof MemoryError || error instanceof FeedbackError) return { code: error.code, message: error.message }
  return undefined
}

/** The route's handler; one per memory file. */
export class MemoryHandler {
  private readonly now: () => number

  constructor(private readonly deps: HandlerDeps) {
    this.now = deps.now ?? Date.now
  }

  /**
   * Answer one request.
   * @param request - a GET for the page's data, or a POST carrying one action.
   * @returns the JSON or HTML answer; failures are answered as responses.
   */
  async fetch(request: Request): Promise<Response> {
    const started = this.now()
    try {
      if (request.method === 'GET') return json(await this.read(new URL(request.url)))
      if (request.method === 'POST') return await this.act(request, started)
      return json({ error: 'method not allowed' }, 405)
    } catch (error: unknown) {
      if (error instanceof Refusal) {
        this.deps.logger.warn('fork-memory-settings: %s refused (%d%s) in %dms', request.method, error.status, error.code === undefined ? '' : ` ${error.code}`, this.now() - started)
        return json({ error: error.message, ...error.code === undefined ? {} : { code: error.code } }, error.status)
      }
      const known = failure(error)
      if (known !== undefined) {
        this.deps.logger.warn('fork-memory-settings: %s failed (%s) in %dms', request.method, known.code, this.now() - started)
        return json({ error: known.message, code: known.code }, known.code === 'not_found' ? 404 : known.code === 'stale_preview' ? 409 : 400)
      }
      this.deps.logger.warn('fork-memory-settings: %s failed: %s', request.method, error instanceof Error ? error.message : String(error))
      return json({ error: 'the memory could not be read or changed; see the Host log' }, 500)
    }
  }

  private async read(url: URL): Promise<unknown> {
    const params: Record<string, unknown> = {}
    for (const key of ['q', 'category', 'id'] as const) {
      const value = url.searchParams.get(key)
      if (value !== null && value !== '') params[key] = value
    }
    for (const key of ['offset', 'limit'] as const) {
      const value = url.searchParams.get(key)
      if (value !== null && value !== '') params[key] = /^\d{1,6}$/u.test(value) ? Number(value) : value
    }
    let parsed: ReturnType<typeof GET_SCHEMA>
    try {
      parsed = GET_SCHEMA(params)
    } catch {
      throw new Refusal(400, 'the query is not valid')
    }
    const { id } = parsed as { id?: string }
    if (id !== undefined) {
      const detail = await readDetail(this.deps.store, id)
      if (detail === undefined) throw new Refusal(404, `no entry or waiting write under id ${id}`, 'not_found')
      return detail
    }
    const query: MemoryQuery = { q: parsed.q.trim(), category: parsed.category, offset: parsed.offset, limit: parsed.limit }
    return await readView(this.deps.store, this.deps.feedback, query, this.now())
  }

  private async act(request: Request, started: number): Promise<Response> {
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) throw new Refusal(415, 'send application/json')
    const origin = request.headers.get('origin')
    if (origin !== null && URL.parse(origin)?.host !== new URL(request.url).host) throw new Refusal(403, 'cross-origin requests are not accepted')
    let raw: unknown
    try {
      raw = await request.json()
    } catch {
      throw new Refusal(400, 'the body is not JSON')
    }
    const name = typeof raw === 'object' && raw !== null ? (raw as { action?: unknown }).action : undefined
    if (typeof name !== 'string' || !isAction(name)) throw new Refusal(400, 'unknown action')
    const { action: _action, ...fields } = raw as Record<string, unknown>
    let body: unknown
    try {
      body = ACTION_SCHEMAS[name](fields)
    } catch {
      throw new Refusal(400, `the ${name} request is not valid`)
    }
    const result = await this.run(name, body as never)
    this.deps.logger.info('fork-memory-settings: %s %s in %dms', name, this.summary(result), this.now() - started)
    return json(result)
  }

  /** What the log says about an action's outcome: ids and counts, never entry text. */
  private summary(result: ActionResult): string {
    switch (result.action) {
      case 'approve':
      case 'discard':
      case 'revert':
        return `ids ${result.results.map(item => `${item.id}${item.ok ? '' : ' (failed)'}`).join(' ')}; ${String(result.results.filter(item => item.ok).length)} ok, ${String(result.results.filter(item => !item.ok).length)} failed`
      case 'rollback':
        return result.stage === 'preview'
          ? `preview: ${String(result.matched)} matched, ${String(result.restored)} restored, ${String(result.removed)} removed`
          : `done: ${String(result.matched)} matched, ${String(result.restored)} restored, ${String(result.removed)} removed`
      case 'forget':
        return `${result.stage} ids ${result.items.map(item => item.id).join(' ')}`
      case 'feedback.add':
        return `${result.outcome} ${result.id}`
      case 'feedback.forget':
        return result.id
    }
  }

  private async run(name: MemoryAction['action'], body: Record<string, unknown>): Promise<ActionResult> {
    const { store, feedback } = this.deps
    switch (name) {
      case 'approve':
      case 'discard':
      case 'revert': {
        const results: ItemResult[] = []
        for (const id of new Set(body['ids'] as string[])) {
          try {
            const done = await reviewWrite(store, name, id, SETTINGS_ORIGIN)
            results.push({ id, ok: true, outcome: done.outcome })
          } catch (error: unknown) {
            const known = failure(error)
            if (known === undefined) throw error
            results.push({ id, ok: false, failure: known })
          }
        }
        return { action: name, results }
      }
      case 'rollback': {
        const filter = rollbackFilter(body)
        const confirm = body['confirm'] as string | undefined
        if (confirm !== undefined) {
          const done = await rollbackConfirmed(store, filter, confirm)
          return { action: 'rollback', stage: 'done', matched: done.matched, restored: done.restored, removed: done.removed }
        }
        const planned = await store.rollback(filter, { dryRun: true })
        const items: RollbackPreviewItem[] = (await describeRollback(store, filter)).map((item) => {
          const shown = item.now ?? item.then
          return {
            id: item.id,
            change: item.change,
            ...shown === undefined ? {} : { category: shown.category },
            ...item.now === undefined ? {} : { now: clip(item.now.text) },
            ...item.then === undefined ? {} : { then: clip(item.then.text) },
          }
        })
        return { action: 'rollback', stage: 'preview', matched: planned.matched, restored: planned.restored, removed: planned.removed, items, token: rollbackToken(filter, planned) }
      }
      case 'forget': {
        const wanted = [...new Set(body['ids'] as string[])]
        const confirm = body['confirm'] as string | undefined
        const preview = (plans: Awaited<ReturnType<typeof planPurge>>): PurgePreviewItem[] => plans.map(plan => ({
          id: plan.id,
          found: plan.entry !== undefined,
          ...plan.entry === undefined ? {} : { category: plan.entry.category, text: clip(plan.entry.text) },
          history: plan.planned.history,
          snapshots: plan.planned.snapshots,
          pending: plan.planned.pending,
        }))
        if (confirm !== undefined) return { action: 'forget', stage: 'done', items: preview(await purgeConfirmed(store, wanted, confirm)) }
        const plans = await planPurge(store, wanted)
        return { action: 'forget', stage: 'preview', items: preview(plans), token: purgeToken(plans) }
      }
      case 'feedback.add': {
        const added = await feedback.add(body as never)
        return { action: 'feedback.add', outcome: added.outcome, id: added.entry.id }
      }
      case 'feedback.forget': {
        const removed = await feedback.forget(body['id'])
        return { action: 'feedback.forget', id: removed.id }
      }
    }
  }
}
