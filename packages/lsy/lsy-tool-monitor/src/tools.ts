/**
 * The three monitor tools. The registry, not the model, enforces batching, budgets, and deadlines; the tools validate
 * the request, start or stop through the registry, and keep the store in step.
 */

import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MonitorRefused, type MonitorRegistry, type MonitorView } from './monitor.ts'
import type { MonitorStorage } from './persistence.ts'

const DEFAULT_TIMEOUT_MINUTES = 60

interface StartArgs {
  command: string
  description: string
  timeout_minutes?: number
  persistent?: boolean
}
const MAX_TIMEOUT_MINUTES = 24 * 60
const MAX_COMMAND_CHARS = 4000
const VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    description: { type: 'string', required: true },
    command: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['running', 'ended'] },
    startedAt: { type: 'number', required: true },
    deadline: { type: 'number' },
    lines: { type: 'number', required: true },
    notices: { type: 'number', required: true },
    ended: { type: 'string' },
  },
} as const

const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { error: { type: 'string', required: true } },
} as const

const renderValue = (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }]

const START_DESCRIPTION = [
  'Start a background monitor: a bash command whose stdout lines are sent back to this session as they appear, waking you when you are idle.',
  'Use it to watch something over time, e.g. `tail -n 0 -F /path/app.log | grep --line-buffered -E "ERROR|Traceback"`, or a loop such as `while true; do curl -fsS http://127.0.0.1:8080/health >/dev/null || echo "health check failed"; sleep 60; done`.',
  'Print only lines that need your attention, and use --line-buffered (grep) or fflush (awk) in pipelines so lines are not held back. Lines arriving together are batched; a monitor that sends more than 30 batches in an hour is stopped, so filter tightly.',
  'stderr is not sent; it is shown when the monitor ends. It runs as the service user in the session\'s working directory until it exits, its timeout passes, or you call monitor_stop; a host restart starts it again with the same id.',
].join(' ')

/** What the tools need from the plugin. */
interface ToolDeps {
  readonly ctx: Context
  readonly registry: MonitorRegistry
  readonly storage: MonitorStorage
}

function startMonitor({ ctx, registry, storage }: ToolDeps, args: StartArgs, agent: Agent | undefined): MonitorView | { error: string } {
  const owner = agent?.session.id
  if (owner === undefined) return { error: 'monitors need an agent session to report to' }
  const command = args.command.trim()
  if (command === '' || command.length > MAX_COMMAND_CHARS) return { error: `command must be 1-${String(MAX_COMMAND_CHARS)} characters` }
  const description = args.description.replace(/\s+/gu, ' ').trim().slice(0, 80)
  if (description === '') return { error: 'description must not be empty' }
  const minutes = args.timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES
  if (args.persistent !== true && (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_TIMEOUT_MINUTES)) {
    return { error: `timeout_minutes must be more than 0 and at most ${String(MAX_TIMEOUT_MINUTES)}` }
  }
  const cwd = agent?.session.header.cwd ?? homedir()
  let view: MonitorView
  try {
    view = registry.start({
      owner,
      command,
      description,
      cwd,
      // Same scrubbing as the bash tool: no credential-shaped or DSH_* variables.
      env: scrubbedParentEnv(),
      ...args.persistent === true ? {} : { timeoutMs: Math.round(minutes * 60_000) },
    })
  } catch (error: unknown) {
    if (error instanceof MonitorRefused) return { error: error.message }
    throw error
  }
  ctx.logger.info('monitor %s started for session %s: %s', view.id, owner, description)
  const { id, startedAt, deadline } = view
  storage.save(id, { owner, command, description, cwd, startedAt, ...deadline === undefined ? {} : { deadline } })
  return view
}

function startTool(deps: ToolDeps) {
  return defineTool({
    name: 'monitor_start',
    description: START_DESCRIPTION,
    parameters: {
      command: { type: 'string', required: true, description: 'Bash command or script; each stdout line becomes an event for you.' },
      description: { type: 'string', required: true, description: 'Short label shown with every event, e.g. "globe errors".' },
      timeout_minutes: { type: 'number', description: `Stop after this many minutes; default ${String(DEFAULT_TIMEOUT_MINUTES)}, at most ${String(MAX_TIMEOUT_MINUTES)}. Ignored when persistent is true.` },
      persistent: { type: 'boolean', description: 'Run until monitor_stop or until the session is gone, with no timeout, across host restarts.' },
    },
    output: { schema: { oneOf: [VIEW_SCHEMA, ERROR_SCHEMA] }, render: renderValue },
    execute(args, exec): Promise<MonitorView | { error: string }> {
      return Promise.resolve(startMonitor(deps, args, exec.agent))
    },
    presentCall: args => ({ card: 'generic', title: `Monitor: ${args.description}`, kind: 'execute', rawInput: args.command }),
  })
}

function stopTool({ ctx, registry }: ToolDeps) {
  return defineTool({
    name: 'monitor_stop',
    description: 'Stop one of your running monitors by id.',
    parameters: {
      id: { type: 'string', required: true, description: 'Monitor id from monitor_start or monitor_list.' },
    },
    output: {
      schema: {
        oneOf: [
          { type: 'object', additionalProperties: false, properties: { stopped: { type: 'string', required: true } } },
          ERROR_SCHEMA,
        ],
      },
      render: renderValue,
    },
    execute(args, exec): Promise<{ stopped: string } | { error: string }> {
      const owner = exec.agent?.session.id
      if (owner === undefined || !registry.owns(owner, args.id) || !registry.stop(args.id)) {
        return Promise.resolve({ error: `no running monitor ${args.id} in this session` })
      }
      ctx.logger.info('monitor %s stopped by session %s', args.id, owner)
      return Promise.resolve({ stopped: args.id })
    },
    presentCall: args => ({ card: 'generic', title: `Stop monitor ${args.id}`, kind: 'other', rawInput: args.id }),
  })
}

function listTool({ registry }: ToolDeps) {
  return defineTool({
    name: 'monitor_list',
    description: 'List this session\'s monitors: running ones, then recently ended ones with why they ended.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { monitors: { type: 'array', required: true, items: VIEW_SCHEMA } } },
      render: renderValue,
    },
    execute(_args, exec): Promise<{ monitors: MonitorView[] }> {
      const owner = exec.agent?.session.id
      return Promise.resolve({ monitors: owner === undefined ? [] : registry.list(owner) })
    },
    presentCall: () => ({ card: 'generic', title: 'List monitors', kind: 'other' }),
  })
}

/**
 * Register `monitor_start`, `monitor_stop`, and `monitor_list`.
 * @param ctx - the preset scope's context.
 * @param registry - the monitors.
 * @param storage - the store that keeps the running ones across a host restart.
 */
export function registerMonitorTools(ctx: Context, registry: MonitorRegistry, storage: MonitorStorage): void {
  const deps: ToolDeps = { ctx, registry, storage }
  ctx.tools.register(startTool(deps))
  ctx.tools.register(stopTool(deps))
  ctx.tools.register(listTool(deps))
}
