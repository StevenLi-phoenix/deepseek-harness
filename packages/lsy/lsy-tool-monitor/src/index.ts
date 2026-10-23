/**
 * `monitor_start`, `monitor_stop`, `monitor_list`: the agent watches anything a
 * shell command can print — a log tail, a polling loop — and each new stdout
 * line comes back to the same Session, waking it when idle, as Claude Code's
 * Monitor does. Each running monitor is stored, and a host restart starts it
 * again under the same id; the registry, not the model, enforces batching,
 * budgets, and deadlines.
 *
 * @module @deepseek-ai/dsh-lsy-tool-monitor
 */

import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DEFAULT_LIMITS, MonitorRefused, MonitorRegistry, noticeText, type MonitorNotice, type MonitorView } from './monitor.ts'
import { monitorDomain } from './storage.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'lsy-tool-monitor': { kind: 'lsy-tool-monitor' } & ContextFormed
  }
}

export { DEFAULT_LIMITS, MonitorRefused, MonitorRegistry, noticeText, type Deliver, type MonitorLimits, type MonitorNotice, type MonitorView, type RestoreRequest } from './monitor.ts'
export { monitorDomain, type MonitorRecord } from './storage.ts'

/** Plugin name; also the source kind of monitor notices. */
export const name = 'lsy-tool-monitor'

/**
 * Mounted inside an agent preset's scope, like other tool plugins. A preset's
 * plugins load when the Host registers the preset, not with its first Agent, so
 * stored monitors start again at host start. Sessions resume lazily after a
 * restart: delivery resolves an owner whose agent is not loaded through the
 * Session controller, and Session persistence tells a gone Session from an
 * unloaded one.
 */
export const inject = ['tools', 'storageDomain', 'sessionController', 'sessionPersistence']

const DEFAULT_TIMEOUT_MINUTES = 60

interface StartArgs {
  command: string
  description: string
  timeout_minutes?: number
  persistent?: boolean
}
const MAX_TIMEOUT_MINUTES = 24 * 60
const MAX_COMMAND_CHARS = 4000
/** How often monitors of vanished Sessions are stopped. */
const SWEEP_MS = 60_000

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

/** Human-readable error text. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Register the monitor tools, and start the stored monitors again.
 * @param ctx - the preset scope's context.
 */
export function apply(ctx: Context): void {
  /** Set once disposal begins: nothing is delivered, swept, or restored after that. */
  let stopping = false
  /** Notices of owners whose agent is loading, in order. */
  const pending = new Map<string, Promise<boolean>>()

  const send = (agent: Agent, owner: string, monitor: MonitorView, notice: MonitorNotice): void => {
    const message = createUserMessage({
      content: [{ type: 'text', text: noticeText(monitor, notice) }],
      source: {
        kind: name,
        form: 'notice',
        summary: notice.kind === 'ended' ? `monitor ${monitor.id} ended` : `monitor ${monitor.id}: ${String(notice.lines.length + notice.dropped)} line(s)`,
      },
    })
    // Same delivery as background-job completions: an idle agent is woken, a busy one reads it next step.
    if (agent.status === 'idle') agent.followup(message)
    else agent.inject(message)
    ctx.logger.info('monitor %s → session %s: %s', monitor.id, owner, notice.kind === 'ended' ? `ended (${notice.reason})` : `${String(notice.lines.length + notice.dropped)} line(s)`)
  }

  const loadedAgent = (owner: string): Agent | undefined => ctx.get('agents')?.get(owner as SessionId)

  /**
   * Whether a Session whose agent is not loaded still takes notices: Session
   * persistence has it, and it is not a subagent's, which only its parent's
   * subagent runtime resumes. Rejects when persistence cannot tell.
   */
  const reachable = async (owner: string): Promise<boolean> => {
    const stored = await ctx.sessionPersistence.stat(owner as SessionId)
    return stored !== undefined && stored.header.origin !== 'subagent'
  }

  /** Load the owner's agent if needed and send; false only when the Session is definitely gone. */
  const resolveAndSend = async (owner: string, monitor: MonitorView, notice: MonitorNotice): Promise<boolean> => {
    try {
      if (stopping) return true
      let agent = loadedAgent(owner)
      if (agent === undefined) {
        if (!await reachable(owner)) return false
        const resolved = await ctx.sessionController.resolveAgent(owner as SessionId)
        if ('error' in resolved) {
          if (resolved.error.code === 'session/not-found') return false
          throw resolved.error
        }
        agent = resolved.agent
      }
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Disposal can run while the Session loads.
      if (!stopping) send(agent, owner, monitor, notice)
    } catch (error: unknown) {
      // Busy, held by another writer, or failing to resume: the Session exists, so the monitor keeps running.
      ctx.logger.warn('monitor %s: session %s cannot take a notice now, dropped it: %s', monitor.id, owner, errorText(error))
    }
    return true
  }

  const deliver = (owner: string, monitor: MonitorView, notice: MonitorNotice): boolean | Promise<boolean> => {
    const agent = loadedAgent(owner)
    if (agent !== undefined && !pending.has(owner)) {
      send(agent, owner, monitor, notice)
      return true
    }
    // After a restart the owner's agent loads on its first notice; later notices wait their turn.
    const queued = (pending.get(owner) ?? Promise.resolve(true)).then(() => resolveAndSend(owner, monitor, notice))
    pending.set(owner, queued)
    void queued.then(() => { if (pending.get(owner) === queued) pending.delete(owner) })
    return queued
  }

  /** A loaded agent is alive; otherwise Session persistence decides, and a failed lookup is no answer. */
  const alive = async (owner: string): Promise<boolean> => {
    if (stopping || loadedAgent(owner) !== undefined) return true
    try {
      return await reachable(owner)
    } catch (error: unknown) {
      ctx.logger.warn('monitor sweep: cannot tell whether session %s exists: %s', owner, errorText(error))
      return true
    }
  }

  // Undefined when another instance of this plugin holds the store, or it failed to open.
  const opened = ctx.storageDomain.open(monitorDomain).then(domain => domain, (error: unknown) => {
    if ((error as { code?: unknown }).code === 'already-open') {
      ctx.logger.warn('monitor store is held by another lsy-tool-monitor instance; monitors started through this preset are not restored after a host restart')
    } else {
      ctx.logger.warn('monitor store did not open, so monitors are not restored after a host restart: %s', errorText(error))
    }
    return undefined
  })

  /** Writes in call order, once the stored monitors are restored. */
  let writes: Promise<unknown> = Promise.resolve()
  const write = (what: string, operation: (domain: Domain<typeof monitorDomain>) => Promise<unknown>): void => {
    writes = writes.then(async () => {
      const domain = await ready
      if (domain !== undefined) await operation(domain)
    }).catch((error: unknown) => { ctx.logger.warn('monitor store: could not %s: %s', what, errorText(error)) })
  }

  const ended = (monitor: MonitorView, reason: string): void => {
    ctx.logger.info('monitor %s ended: %s', monitor.id, reason)
    write(`forget monitor ${monitor.id}`, domain => domain.table('monitors').delete(monitor.id))
  }
  const registry = new MonitorRegistry(deliver, DEFAULT_LIMITS, Date.now, ended)

  /** Start every stored monitor again, silently: same id, command, directory, and deadline, a freshly scrubbed environment. */
  const restore = async (domain: Domain<typeof monitorDomain>): Promise<void> => {
    const table = domain.table('monitors')
    for (const [id, record] of [...table.entries()]) {
      let dropped: string | undefined
      if (record.deadline !== undefined && record.deadline <= Date.now()) dropped = 'its deadline passed'
      else {
        try {
          if (!await reachable(record.owner)) dropped = 'its session is gone'
        } catch (error: unknown) {
          // Only a definite answer drops a monitor; delivery and the sweep ask again.
          ctx.logger.warn('monitor %s: cannot tell whether session %s exists, restoring it: %s', id, record.owner, errorText(error))
        }
      }
      if (stopping) return
      if (dropped === undefined) {
        try {
          registry.restore({
            id,
            owner: record.owner,
            command: record.command,
            description: record.description,
            cwd: record.cwd,
            startedAt: record.startedAt,
            ...record.deadline === undefined ? {} : { deadline: record.deadline },
            // Same scrubbing as the bash tool, read again now: nothing of the environment is stored.
            env: scrubbedParentEnv(),
          })
          const left = record.deadline === undefined ? 0 : Math.ceil((record.deadline - Date.now()) / 60_000)
          ctx.logger.info('monitor %s restored for session %s: %s (%s)', id, record.owner, record.description,
            record.deadline === undefined ? 'persistent' : `${String(left)} minute${left === 1 ? '' : 's'} left`)
          continue
        } catch (error: unknown) {
          dropped = errorText(error)
        }
      }
      ctx.logger.info('monitor %s of session %s dropped: %s', id, record.owner, dropped)
      try {
        await table.delete(id)
      } catch (error: unknown) {
        ctx.logger.warn('monitor store: could not forget monitor %s: %s', id, errorText(error))
      }
    }
  }
  const ready = opened.then(async (domain) => {
    if (domain === undefined) return undefined
    try {
      await restore(domain)
    } catch (error: unknown) {
      ctx.logger.warn('monitor store: restoring stopped early: %s', errorText(error))
    }
    return domain
  })

  ctx.effect(() => {
    const sweep = setInterval(() => { void registry.sweep(alive) }, SWEEP_MS)
    sweep.unref()
    return async () => {
      stopping = true
      clearInterval(sweep)
      // Kills every process group; the records stay, so the next host start runs them again.
      registry.dispose()
      const domain = await ready
      await writes
      await domain?.close()
    }
  }, 'lsy-tool-monitor: stop monitors')

  ctx.tools.register(defineTool({
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
      return Promise.resolve(startMonitor(args, exec.agent))
    },
    presentCall: args => ({ card: 'generic', title: `Monitor: ${args.description}`, kind: 'execute', rawInput: args.command }),
  }))

  function startMonitor(args: StartArgs, agent: Agent | undefined): MonitorView | { error: string } {
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
    write(`save monitor ${id}`, domain => domain.table('monitors').put(id, {
      owner, command, description, cwd, startedAt, ...deadline === undefined ? {} : { deadline },
    }))
    return view
  }

  ctx.tools.register(defineTool({
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
  }))

  ctx.tools.register(defineTool({
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
  }))
}
