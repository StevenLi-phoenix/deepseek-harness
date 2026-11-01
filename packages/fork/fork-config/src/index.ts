/**
 * Plugin configuration, node half: `GET /api/fork.config?entries=a,b` answers the full form of each named plugin
 * entry (every Config field, the value in force, and the layer that set it), and `POST /api/fork.config` saves a set
 * of edits to the owner's patch in one write, through the profile's configuration editor. Both routes sit under
 * `/api`, so the connection's sign-in check guards them. Credential fields are described, never read out, and a save
 * never touches one. Each save is logged with the entry id, the changed field paths, the outcome and the time.
 */

import { isDeepStrictEqual } from 'node:util'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-config-editor'
import { ConfigEditError, applyOps, revisionOf } from './edit.ts'
import { buildFields, objectFields } from './fields.ts'
import {
  CONFIG_PATH, ENTRY_ID, MAX_ENTRIES, MAX_EXCLUDE, MAX_OPS, leavesOf, pathLabel,
  type ConfigDescribe, type ConfigEntryView, type ConfigOp, type ConfigSaveFailure, type ConfigSaveResult, type ConfigValue,
} from './view.ts'

/** Required Host services. */
export const inject = ['connection', 'configEditor']

/** The slice of the connection service this plugin uses. */
interface ConfigConnection {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'POST')[]
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/** One entry and the layers under it, as the configuration editor reports them. */
interface Row {
  readonly entry: Entry
  readonly inherited: Record<string, unknown>
  readonly override: Record<string, unknown>
}

/** The HTTP status of each refusal. */
const STATUS: Record<ConfigSaveFailure, number> = {
  'bad-request': 400, 'not-found': 404, conflict: 409, 'home-locked': 409, invalid: 422, failed: 500,
}

/** @returns the Config schema of a running entry, or undefined when it has none to read. */
function schemaOf(entry: Entry): z | undefined {
  const schema = entry.fiber?.runtime?.Config
  return schema !== undefined && 'toJSON' in schema ? schema as z : undefined
}

/** @returns the config in force of an entry, as stored. */
function effectiveOf(entry: Entry): Record<string, unknown> {
  const config: unknown = entry.options.config
  return typeof config === 'object' && config !== null && !Array.isArray(config) ? structuredClone(config) as Record<string, unknown> : {}
}

/** @returns whether the home patch or an overlay, not the owner's patch, decides the entry's config. */
function lockedBy(effective: Record<string, unknown>, row: Row): boolean {
  return !isDeepStrictEqual(effective, row.override) && !isDeepStrictEqual(effective, row.inherited)
}

function describeEntry(id: string, row: Row | undefined, exclude: readonly string[]): ConfigEntryView {
  const absent = { id, found: false, active: false, locked: false, revision: '', overrides: 0, fields: [] } as const
  if (row === undefined) return absent
  const effective = effectiveOf(row.entry)
  const locked = lockedBy(effective, row)
  const revision = revisionOf(effective, row.inherited, exclude)
  if (row.entry.fiber?.state !== FiberState.ACTIVE) return { ...absent, found: true, locked, revision }
  // A running plugin without a Config schema has no fields to show.
  const schema = schemaOf(row.entry)
  const fields = schema === undefined ? [] : buildFields(schema, { effective, inherited: row.inherited, locked, exclude })
  return {
    id, found: true, active: true, locked, revision, fields,
    overrides: leavesOf(fields).filter(leaf => leaf.layer === 'owner').length,
  }
}

function parseIds(request: Request): string[] | undefined {
  const ids = (new URL(request.url).searchParams.get('entries') ?? '').split(',').filter(id => id !== '')
  if (ids.length === 0 || ids.length > MAX_ENTRIES || !ids.every(id => ENTRY_ID.test(id))) return undefined
  return [...new Set(ids)]
}

/** @returns the dotted field paths a request leaves out, or undefined when they are malformed or too many. */
function parseExclude(value: unknown): string[] | undefined {
  const list = value === undefined || value === '' ? [] : typeof value === 'string' ? value.split(',') : value
  if (!Array.isArray(list) || list.length > MAX_EXCLUDE) return undefined
  return list.every(entry => typeof entry === 'string' && /^[^\s,.][^\s,]*$/.test(entry)) ? list as string[] : undefined
}

function parseOps(value: unknown): ConfigOp[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_OPS) return undefined
  const ops: ConfigOp[] = []
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null) return undefined
    const { op, path, value: payload } = item as { op?: unknown; path?: unknown; value?: unknown }
    if (!Array.isArray(path) || path.length === 0 || !path.every(key => typeof key === 'string' && key !== '')) return undefined
    if (op === 'unset' || op === 'clear') ops.push({ op, path: path as string[] })
    else if (op === 'set' && payload !== undefined) ops.push({ op, path: path as string[], value: payload as ConfigValue })
    else return undefined
  }
  return ops
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return (text.split('\n')[0] ?? '').slice(0, 200)
}

/** @returns the refusal class of an error thrown while writing. */
function classify(error: unknown): ConfigSaveFailure {
  if (error instanceof ConfigEditError) return error.reason
  if (error instanceof Error && error.name === 'ValidationError') return 'invalid'
  if (error instanceof Error && error.message.includes('overridden by a home patch')) return 'home-locked'
  return 'failed'
}

/**
 * Register the configuration routes.
 * @param ctx - Host context with the connection service and the configuration editor.
 */
export function apply(ctx: Context): void {
  const connection = Reflect.get(ctx, 'connection') as ConfigConnection
  const rows = (): Row[] => ctx.configEditor.configuration()

  const describe = (ids: readonly string[], exclude: readonly string[]): ConfigDescribe => {
    const started = Date.now()
    const all = rows()
    const entries = ids.map(id => describeEntry(id, all.find(row => row.entry.options.id === id), exclude))
    const fieldCount = entries.reduce((sum, entry) => sum + leavesOf(entry.fields).length, 0)
    ctx.logger.debug(`fork-config: read ${ids.join(',')} (${fieldCount} fields) in ${Date.now() - started}ms`)
    return { entries }
  }

  const save = async (id: string, revision: string, ops: readonly ConfigOp[], exclude: readonly string[]): Promise<ConfigSaveResult> => {
    const row = rows().find(candidate => candidate.entry.options.id === id)
    if (row === undefined) return { ok: false, reason: 'not-found', message: `no plugin entry "${id}"` }
    const schema = schemaOf(row.entry)
    if (schema === undefined || objectFields(schema) === undefined) {
      return { ok: false, reason: 'not-found', message: `plugin entry "${id}" has no settings to edit` }
    }
    if (lockedBy(effectiveOf(row.entry), row)) {
      return { ok: false, reason: 'home-locked', message: 'the home patch sets this entry, so a save here would be shadowed' }
    }
    let changed: string[] = []
    let reload = false
    await ctx.configEditor.edit(row.entry, (current, inherited) => {
      if (revisionOf(current, inherited, exclude) !== revision) throw new ConfigEditError('conflict', 'the configuration changed since this form was read')
      const result = applyOps(schema, current, inherited, ops, exclude)
      changed = result.changed
      reload = result.reload
      return result.next
    })
    const after = rows().find(candidate => candidate.entry.options.id === id)
    return { ok: true, revision: after === undefined ? '' : revisionOf(effectiveOf(after.entry), after.inherited, exclude), changed, reload }
  }

  const answer = async (request: Request): Promise<Response> => {
    const headers = { 'cache-control': 'no-store' }
    if (request.method === 'GET') {
      const ids = parseIds(request)
      const exclude = parseExclude(new URL(request.url).searchParams.get('exclude') ?? undefined)
      return ids === undefined || exclude === undefined
        ? Response.json({ ok: false, reason: 'bad-request', message: 'entries must name 1 to 16 plugin entry ids; exclude, dotted field paths' }, { status: 400, headers })
        : Response.json(describe(ids, exclude), { headers })
    }
    const body: unknown = await request.json().catch((_notJson: unknown) => undefined)
    const fields = typeof body === 'object' && body !== null ? body as { id?: unknown; revision?: unknown; ops?: unknown; exclude?: unknown } : {}
    const ops = parseOps(fields.ops)
    const exclude = parseExclude(fields.exclude)
    if (typeof fields.id !== 'string' || !ENTRY_ID.test(fields.id) || typeof fields.revision !== 'string' || ops === undefined || exclude === undefined) {
      return Response.json({ ok: false, reason: 'bad-request', message: `a save names an entry, its revision and 1 to ${MAX_OPS} edits` }, { status: 400, headers })
    }
    const started = Date.now()
    const paths = ops.map(op => pathLabel(op.path))
    let result: ConfigSaveResult
    try {
      result = await save(fields.id, fields.revision, ops, exclude)
    } catch (error) {
      result = { ok: false, reason: classify(error), message: messageOf(error) }
    }
    const ms = Date.now() - started
    if (result.ok) {
      ctx.logger.info(`fork-config: saved ${fields.id} changed=[${result.changed.join(',')}] reload=${result.reload} outcome=ok in ${ms}ms`)
    } else {
      // Paths and the refusal class only: a message may quote a field of the config, so it stays out of the log.
      ctx.logger.warn(`fork-config: save of ${fields.id} edits=[${paths.join(',')}] outcome=${result.reason} in ${ms}ms`)
    }
    return Response.json(result, { status: result.ok ? 200 : STATUS[result.reason], headers })
  }

  ctx.effect(() => connection.fetch.register({
    path: CONFIG_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: answer,
  }), `fork-config: ${CONFIG_PATH}`)
}
