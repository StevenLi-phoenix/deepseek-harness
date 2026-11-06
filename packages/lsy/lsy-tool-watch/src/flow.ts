/**
 * Model-facing `flow_read` and `flow_edit`: the whole notification flow as routes the agent reads and changes itself, CI to the
 * notifier included, with no YAML and no deploy. The bus stores a change, so a deploy keeps it, and `reset` puts a deployment's route back.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import {
  flowResultKind, LsyFlowError, ROUTE_RESULTS, type FlowChange, type FlowEdit, type FlowRouteView, type RoutePatch, type RouteResult,
} from '@deepseek-ai/dsh-lsy-event-bus'
import { defineTool, type GenericCallView } from '@deepseek-ai/dsh-tools'
import type { Config } from './index.ts'
import { ID_PATTERN, MAX_COALESCE_SECONDS, MAX_PER_HOUR } from './limits.ts'

const DAY_MS = 86_400_000

const OPS = ['set', 'remove', 'reset', 'pause', 'resume'] as const
const ERROR_CODES = ['invalid_arguments', 'invalid_route', 'not_found', 'not_config', 'cycle', 'internal_error'] as const

const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true, enum: ERROR_CODES },
    message: { type: 'string', required: true },
  },
} as const

const READ_DESCRIPTION =
  'Read the notification flow: every route from an incoming event to the owner, with what it takes, what its Session is told, where its answer '
  + 'goes, and its recent batches; also the event kinds no route took in the last day and the latest changes of the flow.'

const EDIT_DESCRIPTION =
  'Change the notification flow, including routes the deployment wrote, such as CI runs or host alerts. A route takes events by source, kind, and '
  + 'subject; a notify route sends a plain message and a session route runs an agent on the batch. A change takes effect at once, outlives '
  + 'restarts and deploys, and is refused when it makes a loop.'

/** Arguments of `flow_edit`. */
interface EditArgs {
  op: typeof OPS[number]
  id: string
  note: string
  sources?: string[]
  kinds?: string[]
  subjects?: string[]
  action?: 'notify' | 'session'
  result?: RouteResult
  instructions?: string
  agent_preset?: string
  workspace_path?: string
  model?: { provider: string; model: string }
  session_per?: 'batch' | 'route' | 'subject'
  coalesce_seconds?: number
  max_per_hour?: number
}

/** First problem of a call's arguments. */
function argumentProblem(args: EditArgs): string | undefined {
  if (!ID_PATTERN.test(args.id)) return 'id must be 1-63 lowercase letters, digits, or hyphens.'
  if (args.note.trim() === '') return 'note must say why, in a line the owner can read.'
  const within = (value: number, min: number, max: number): boolean => Number.isSafeInteger(value) && value >= min && value <= max
  if (args.coalesce_seconds !== undefined && !within(args.coalesce_seconds, 0, MAX_COALESCE_SECONDS)) {
    return `coalesce_seconds must be a whole number from 0 to ${MAX_COALESCE_SECONDS}.`
  }
  if (args.max_per_hour !== undefined && !within(args.max_per_hour, 1, MAX_PER_HOUR)) {
    return `max_per_hour must be a whole number from 1 to ${MAX_PER_HOUR}.`
  }
  if (args.workspace_path?.startsWith('/') === false) return 'workspace_path must be absolute.'
  return undefined
}

/** The Session settings a call gives. */
function sessionOf(args: EditArgs, config: Config): NonNullable<RoutePatch['session']> {
  return {
    ...(args.instructions === undefined ? {} : { instructions: args.instructions.trim() }),
    ...(args.agent_preset === undefined ? {} : { agentPreset: args.agent_preset }),
    ...(args.workspace_path === undefined ? {} : { workspacePath: args.workspace_path }),
    ...(args.result === undefined ? {} : { result: args.result }),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.session_per === undefined ? {} : {
      persistent: {
        enabled: args.session_per !== 'batch',
        key: args.session_per === 'subject' ? 'subject' as const : 'subscription' as const,
        rolloverDays: config.defaultRolloverDays,
        maxSeedChars: config.defaultMaxSeedChars,
      },
    }),
  }
}

/**
 * The fields of a call as a change of a route.
 * @param args - the call.
 * @param existing - the route as it stands, if any.
 * @param config - defaults of a route that has no Session yet.
 * @returns the change.
 */
function patchOf(args: EditArgs, existing: FlowRouteView | undefined, config: Config): RoutePatch {
  const session = sessionOf(args, config)
  const action = args.action ?? existing?.action ?? (args.instructions === undefined ? 'notify' : 'session')
  const needsDefaults = action === 'session' && existing?.action !== 'session'
  const defaults = needsDefaults
    ? {
      workspacePath: config.defaultWorkspacePath,
      agentPreset: config.defaultAgentPreset,
      permissionPreset: config.defaultPermissionPreset,
      maxPromptEvents: config.defaultMaxPromptEvents,
      maxTextChars: config.defaultMaxTextChars,
    }
    : {}
  const merged = { ...defaults, ...session }
  return {
    ...(args.sources === undefined ? {} : { sources: args.sources }),
    ...(args.kinds === undefined ? {} : { kinds: args.kinds }),
    ...(args.subjects === undefined ? {} : { subjects: args.subjects }),
    ...(existing === undefined || args.action !== undefined ? { action } : {}),
    ...(args.coalesce_seconds === undefined ? {} : { coalesceMs: args.coalesce_seconds * 1000 }),
    ...(args.max_per_hour === undefined ? {} : { maxPerHour: args.max_per_hour }),
    ...(existing === undefined
      ? {
        coalesceMs: (args.coalesce_seconds ?? config.defaultCoalesceSeconds) * 1000,
        maxPerHour: args.max_per_hour ?? (action === 'session' ? config.defaultSessionMaxPerHour : config.defaultNotifyMaxPerHour),
      }
      : {}),
    ...(Object.keys(merged).length === 0 ? {} : { session: merged }),
  }
}

/** A route as the model reads it. */
function routeView(route: FlowRouteView) {
  const last = route.status.lastBatch
  // The bus's schema hands a notify row an empty `session`.
  const session = route.action === 'session' ? route.session : undefined
  return {
    id: route.id,
    origin: route.origin,
    action: route.action,
    sources: route.sources,
    kinds: route.kinds,
    subjects: route.subjects,
    coalesce_seconds: route.coalesceMs / 1000,
    max_per_hour: route.maxPerHour,
    ...(route.paused === true ? { paused: true } : {}),
    ...(route.removed === true ? { removed: true } : {}),
    ...(route.changed === undefined ? {} : { changed_at: new Date(route.changed.at).toISOString() }),
    ...(route.result === undefined ? {} : { result: route.result }),
    ...(route.result === 'event' ? { result_kind: flowResultKind(route.id) } : {}),
    downstream: route.downstream,
    ...(session === undefined ? {} : {
      instructions: session.instructions,
      agent_preset: session.agentPreset,
      workspace_path: session.workspacePath,
      ...(session.model?.provider === undefined ? {} : { model: session.model }),
      session_per: session.persistent?.enabled === true ? (session.persistent.key === 'subject' ? 'subject' : 'route') : 'batch',
    }),
    pending: route.status.pending,
    batches_last_hour: route.status.batchesLastHour,
    ...(last === undefined ? {} : {
      last_batch: {
        at: new Date(last.createdAt).toISOString(),
        status: last.status,
        ...(last.silent === true ? { silent: true } : {}),
        ...(last.error === undefined ? {} : { error: last.error }),
      },
    }),
  }
}

/** A change as the model reads it. */
function changeView(change: FlowChange) {
  return {
    at: new Date(change.at).toISOString(),
    op: change.op,
    route: change.route,
    ...(change.by === undefined ? {} : { by: change.by }),
    ...(change.note === undefined ? {} : { note: change.note }),
  }
}

const renderValue = (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }]

const present = (title: string, kind: 'read' | 'other', rawInput?: string): GenericCallView =>
  ({ card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } })

const ROUTE_SCHEMA = { type: 'object', additionalProperties: true, properties: { id: { type: 'string', required: true } } } as const

/**
 * Register `flow_read` and `flow_edit`.
 * @param ctx - scope whose bus the tools act through.
 * @param config - defaults of a route the model creates.
 */
export function registerFlowTools(ctx: Context, config: Config): void {
  /** Tell the owner about a change made from a Session the notifier does not relay itself. Never fails the call. */
  const audit = (sessionId: string | undefined, edit: FlowEdit, note: string): void => {
    const notifier = ctx.get('lsyNotifier')
    if (notifier === undefined || (sessionId !== undefined && notifier.ownsSession?.(sessionId) === true)) return
    void Promise.resolve()
      .then(() => notifier.send({ title: `通知流程改动：${edit.op} ${edit.id}`, body: `${note}\nSession: ${sessionId ?? 'unknown'}` }))
      .catch((error: unknown) => { ctx.logger.warn(`lsy-tool-watch: audit note for ${edit.id} failed: ${String(error)}`) })
  }

  ctx.tools.register(defineTool({
    name: 'flow_read',
    description: READ_DESCRIPTION,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          routes: { type: 'array', required: true, items: ROUTE_SCHEMA },
          unrouted_kinds: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { kind: { type: 'string', required: true }, source: { type: 'string', required: true }, count: { type: 'number', required: true } },
            },
          },
          history: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } },
        },
      },
      render: renderValue,
    },
    execute() {
      const since = Date.now() - DAY_MS
      const unrouted = new Map<string, { kind: string; source: string; count: number }>()
      for (const event of ctx.lsyEventBus.events()) {
        if (event.outcome !== 'unmatched' || event.receivedAt < since) continue
        const seen = unrouted.get(event.kind)
        unrouted.set(event.kind, { kind: event.kind, source: event.source, count: (seen?.count ?? 0) + 1 })
      }
      return Promise.resolve({
        routes: ctx.lsyEventBus.flowRoutes().map(routeView),
        unrouted_kinds: [...unrouted.values()].sort((a, b) => b.count - a.count).slice(0, config.flowUnroutedShown),
        history: ctx.lsyEventBus.flowHistory(config.flowHistoryShown).map(changeView),
      })
    },
    presentCall: () => present('Read the notification flow', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'flow_edit',
    description: EDIT_DESCRIPTION,
    parameters: {
      op: { type: 'string', required: true, enum: OPS, description: 'set: change the fields given, creating the route when the id is new. remove: take it out. reset: put a deployment route back as written. pause, resume: stop and restart it.' },
      id: { type: 'string', required: true, description: 'A route from flow_read, or a new id of 1-63 lowercase letters, digits, or hyphens.' },
      note: { type: 'string', required: true, description: 'Why, in one line for the owner.' },
      sources: { type: 'array', items: { type: 'string' }, description: 'op set: source globs it takes, e.g. ["github"] or ["flow"].' },
      kinds: { type: 'array', items: { type: 'string' }, description: 'op set: kind globs it takes, e.g. ["github.workflow_run.*"] or ["flow.ci.result"].' },
      subjects: { type: 'array', items: { type: 'string' }, description: 'op set: subject globs it takes, e.g. ["owner/*"]; empty takes every subject.' },
      action: { type: 'string', enum: ['notify', 'session'], description: 'op set: notify sends a message; session runs an agent. A new route with instructions defaults to session.' },
      result: { type: 'string', enum: ROUTE_RESULTS, description: 'op set: where a session route\'s answer goes. notify: a message for the owner. urgent: the same, past do-not-disturb. main: the owner\'s main agent. quiet: nowhere. event: an event of source "flow" and kind "flow.<id>.result", which a route naming them takes, so routes chain. An answer of NO_REPLY sends nothing, so a route can filter.' },
      instructions: { type: 'string', description: 'op set: what a session route\'s agent does with each batch. It replaces the current text.' },
      agent_preset: { type: 'string', description: `op set: agent preset of its Sessions. New session routes default to ${config.defaultAgentPreset}.` },
      workspace_path: { type: 'string', description: `op set: absolute working directory of its Sessions. New session routes default to ${config.defaultWorkspacePath}.` },
      model: {
        type: 'object',
        additionalProperties: false,
        properties: { provider: { type: 'string', required: true }, model: { type: 'string', required: true } },
        description: 'op set: model route of its Sessions, instead of the default.',
      },
      session_per: {
        type: 'string',
        enum: ['batch', 'route', 'subject'],
        description: 'op set: a new Session per batch, one long Session for the route, or one per subject such as a repository.',
      },
      coalesce_seconds: { type: 'number', description: 'op set: seconds after the first event during which later events join the same batch.' },
      max_per_hour: { type: 'number', description: 'op set: most batches per rolling hour; later ones wait.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              route: { oneOf: [ROUTE_SCHEMA, { type: 'null' }], required: true },
              warnings: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
          ERROR_SCHEMA,
        ],
      },
      render: renderValue,
    },
    async execute(args, exec) {
      const edit: EditArgs = args
      const problem = argumentProblem(edit)
      if (problem !== undefined) return { code: 'invalid_arguments' as const, message: problem }
      const sessionId = exec.agent?.session.id
      const existing = ctx.lsyEventBus.flowRoutes().find(route => route.id === edit.id)
      const request: FlowEdit = edit.op === 'set'
        ? { op: 'set', id: edit.id, patch: patchOf(edit, existing, config) }
        : { op: edit.op, id: edit.id }
      const note = edit.note.trim()
      try {
        const { route, warnings } = await ctx.lsyEventBus.editFlow(request, { ...(sessionId === undefined ? {} : { by: sessionId }), note })
        audit(sessionId, request, note)
        return { route: route === null ? null : routeView(route), warnings }
      } catch (error: unknown) {
        if (error instanceof LsyFlowError) return { code: error.code, message: error.message }
        ctx.logger.warn(`lsy-tool-watch: flow_edit ${edit.id} failed: ${error instanceof Error ? error.message : String(error)}`)
        return { code: 'internal_error' as const, message: 'The flow change failed.' }
      }
    },
    presentCall: args => present('Change the notification flow', 'other', `${args.op} ${args.id}`),
  }))
}
