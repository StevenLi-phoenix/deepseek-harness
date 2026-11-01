/**
 * Subscriptions and reminders over the plugins' own APIs: the event bus (`ctx.lsyEventBus`) holds what `watch_create` and the
 * configuration define, and the Host schedule service (`ctx.schedule`) holds what `schedule_create` defines. Nothing here reads
 * their storage. Event text and reminder prompts stay on the Host; rows carry ids, selectors, times, and counts.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ArchivedRecord, ArchiveStatus, Subscription, SubscriptionView, SweepReport } from '@deepseek-ai/dsh-lsy-event-bus'
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule'
import type { Config } from './config.ts'
import { logAction, type Log } from './log.ts'
import { Refusal, parseBody } from './request.ts'
import type {
  ArchivedRow, ArchiveSweepView, ArchiveView, NewSubscription, ScheduleRow, SubscriptionAction, SubscriptionRow, SubscriptionsView,
} from './views.ts'

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/u
/** Selector globs: printable, no whitespace, so a stray space or newline is a mistake caught early. */
const GLOB = /^[^\s]{1,120}$/u
const MAX_INSTRUCTIONS_CHARS = 4000
const MAX_SELECTORS = 20
/** `createdBy` of subscriptions this page makes; it is not a Session id. */
export const CREATED_BY_SETTINGS = 'settings'
/** Prompt bounds of the Sessions a `session` subscription starts; those of `watch_create`. */
const SESSION_PROMPT_EVENTS = 50
const SESSION_TEXT_CHARS = 2000

/** Rows the page lists of the recently archived Sessions, and of a preview. */
const RECENT_ROWS = 30
const PREVIEW_ROWS = 20
const TITLE_CHARS = 80

const selectors = z.array(z.string().required().pattern(GLOB)).max(MAX_SELECTORS).default([])

/** The form a create request carries. */
interface CreateForm {
  id: string
  sources: string[]
  kinds: string[]
  subjects: string[]
  mode: 'notify' | 'session'
  instructions?: string
  coalesceSeconds?: number
  maxPerHour?: number
}

interface CreateBody {
  action: 'create'
  subscription: CreateForm
}

interface ChangeBody {
  action: 'pause' | 'resume' | 'delete'
  target: 'subscription' | 'schedule'
  id: string
}

const createSchema: z<CreateBody> = z.object({
  action: z.const('create').required(),
  subscription: z.object({
    id: z.string().required().pattern(ID),
    sources: selectors,
    kinds: selectors,
    subjects: selectors,
    mode: z.union(['notify', 'session'] as const).required(),
    instructions: z.string(),
    coalesceSeconds: z.natural().max(86_400),
    maxPerHour: z.natural().min(1).max(60),
  }).required(),
})

const sweepSchema: z<{ action: 'archive.sweep'; dryRun: boolean }> = z.object({
  action: z.const('archive.sweep').required(),
  dryRun: z.boolean().default(false),
})

const changeSchema: z<ChangeBody> = z.object({
  action: z.union(['pause', 'resume', 'delete'] as const).required(),
  target: z.union(['subscription', 'schedule'] as const).required(),
  id: z.string().required().pattern(/^[^\s]{1,200}$/u),
})

/** The slice of the GitHub sensor a delete must clean up after; duck-typed, as the sensor may not be mounted. */
interface RepoWatches {
  watchedRepos(): { origin: string; ref: string }[]
  unwatch(ref: string): Promise<boolean>
}

function service(ctx: Context, name: string): unknown {
  return (ctx.get as (name: string) => unknown)(name)
}

function subscriptionRow(view: SubscriptionView, fired: { count: number }): SubscriptionRow {
  const last = view.status.lastBatch
  return {
    id: view.id,
    origin: view.origin,
    mode: view.action,
    sources: view.sources,
    kinds: view.kinds,
    subjects: view.subjects,
    paused: view.paused === true,
    createdBy: view.createdBy ?? null,
    createdAt: view.createdAt ?? null,
    lastFiredAt: last?.createdAt ?? null,
    fireCount: fired.count,
    pending: view.status.pending,
    lastStatus: last?.status ?? null,
  }
}

const clipTitle = (title: string | undefined): string | null => (title === undefined || title === '' ? null : Array.from(title).slice(0, TITLE_CHARS).join(''))

function archivedRow(record: ArchivedRecord): ArchivedRow {
  return { id: record.sessionId, title: clipTitle(record.title), lastActiveAt: record.lastActiveAt, archivedAt: record.archivedAt }
}

function sweepView(report: SweepReport): ArchiveSweepView {
  return {
    at: report.at,
    trigger: report.trigger,
    dryRun: report.dryRun,
    scanned: report.scanned,
    archived: report.dryRun ? report.wouldArchive.length : report.archived.length,
    skipped: report.skipped,
    errors: report.errors.length,
    aborted: report.aborted ?? null,
    preview: report.wouldArchive.slice(0, PREVIEW_ROWS).map(entry => ({
      id: entry.id, title: clipTitle(entry.title), lastActiveAt: entry.lastActiveAt, archivedAt: null,
    })),
  }
}

function archiveView(status: ArchiveStatus): ArchiveView {
  return {
    enabled: status.enabled,
    dryRun: status.dryRun,
    inactiveDays: status.inactiveDays,
    maxPerSweep: status.maxPerSweep,
    sweepHours: status.sweepHours,
    nextSweepAt: status.nextSweepAt ?? null,
    protectors: status.protectors,
    last: status.lastSweep === undefined ? null : sweepView(status.lastSweep),
    recent: status.recent.slice(0, RECENT_ROWS).map(archivedRow),
  }
}

/** Short form of a reminder's rule. */
function ruleDetail(entry: ScheduleCatalogEntry): string {
  switch (entry.kind) {
    case 'after': return `${entry.afterSeconds} s`
    case 'at': return ''
    case 'every': return `${entry.everySeconds} s`
    case 'daily': return `${entry.time.slice(0, 8)} ${entry.timeZone}`
    case 'weekly': return `${entry.weekdays.join(',')} ${entry.time.slice(0, 8)} ${entry.timeZone}`
    case 'cron': return `${entry.expression} ${entry.timeZone}`
    case 'rrule': return entry.rrule.replaceAll(/\s+/gu, ' ').slice(0, 80)
  }
}

function scheduleRow(entry: ScheduleCatalogEntry): ScheduleRow {
  const next = Date.parse(entry.scheduledAt)
  const last = entry.lastDelivery === undefined ? Number.NaN : Date.parse(entry.lastDelivery.deliveredAt)
  return {
    id: entry.id,
    title: entry.title,
    rule: entry.kind,
    detail: ruleDetail(entry),
    status: entry.status,
    nextAt: Number.isFinite(next) ? next : null,
    lastFiredAt: Number.isFinite(last) ? last : null,
  }
}

/**
 * Read both lists.
 * @param ctx - Host context.
 * @param config - the form defaults.
 * @param now - clock.
 * @returns the view; a list is null when its service is not mounted.
 */
export async function listSubscriptions(ctx: Context, config: Config, now: () => number = Date.now): Promise<SubscriptionsView> {
  const bus = ctx.get('lsyEventBus')
  const schedule = ctx.get('schedule')
  const counts = new Map<string, number>()
  for (const batch of bus?.batches() ?? []) counts.set(batch.subscription, (counts.get(batch.subscription) ?? 0) + 1)
  return {
    subscriptions: bus?.listSubscriptions().map(view => subscriptionRow(view, { count: counts.get(view.id) ?? 0 })) ?? null,
    schedules: schedule === undefined ? null : (await schedule.catalog()).map(scheduleRow),
    archive: bus === undefined ? null : archiveView(bus.archiveStatus()),
    defaults: {
      coalesceSeconds: config.subscriptions.coalesceSeconds,
      notifyMaxPerHour: config.subscriptions.notifyMaxPerHour,
      sessionMaxPerHour: config.subscriptions.sessionMaxPerHour,
      agentPreset: config.subscriptions.agentPreset,
      workspacePath: config.subscriptions.workspacePath,
    },
    checkedAt: now(),
  }
}

/** Build the bus subscription a validated form describes. */
function toSubscription(form: CreateForm, config: Config): Subscription {
  if (form.sources.length === 0 && form.kinds.length === 0 && form.subjects.length === 0) {
    // An empty selector list matches everything; a subscription made from a form must say what it wants.
    throw new Refusal('invalid_subscription', 'selector')
  }
  const defaults = config.subscriptions
  const base = {
    id: form.id,
    sources: [...form.sources],
    kinds: [...form.kinds],
    subjects: [...form.subjects],
    coalesceMs: (form.coalesceSeconds ?? defaults.coalesceSeconds) * 1000,
  }
  if (form.mode === 'notify') {
    return { ...base, action: 'notify', maxPerHour: form.maxPerHour ?? defaults.notifyMaxPerHour }
  }
  const instructions = form.instructions?.trim() ?? ''
  if (instructions === '' || instructions.length > MAX_INSTRUCTIONS_CHARS) throw new Refusal('invalid_subscription', 'instructions')
  return {
    ...base,
    action: 'session',
    maxPerHour: form.maxPerHour ?? defaults.sessionMaxPerHour,
    session: {
      workspacePath: defaults.workspacePath,
      agentPreset: defaults.agentPreset,
      permissionPreset: defaults.permissionPreset,
      instructions,
      maxPromptEvents: SESSION_PROMPT_EVENTS,
      maxTextChars: SESSION_TEXT_CHARS,
    },
  }
}

async function change(ctx: Context, body: ChangeBody): Promise<void> {
  const { action, target, id } = body
  if (target === 'subscription') {
    const bus = ctx.get('lsyEventBus')
    if (bus === undefined) throw new Refusal('unavailable', 'bus')
    if (action !== 'delete') {
      const paused = await bus.setPaused(id, action === 'pause')
      if (paused !== 'ok') throw new Refusal(paused)
      return
    }
    const outcome = await bus.unsubscribe(id)
    if (outcome !== 'removed') throw new Refusal(outcome)
    // `watch_delete` also stops the repository poll that `watch_create` started under the same id.
    const sensor = service(ctx, 'lsyGithubSensor') as RepoWatches | undefined
    if (sensor?.watchedRepos().some(repo => repo.origin === 'agent' && repo.ref === id) === true) await sensor.unwatch(id)
    return
  }
  const schedule = ctx.get('schedule')
  if (schedule === undefined) throw new Refusal('unavailable', 'schedule')
  // The id is the schedule service's own opaque string; an unknown one answers `schedule_not_found`.
  const scheduleId = id as ScheduleCatalogEntry['id']
  const result = action === 'delete'
    ? await schedule.edit({ id: scheduleId, action: 'delete' })
    : await schedule.edit({ id: scheduleId, action: 'update', patch: { active: action === 'resume' } })
  if ('code' in result) throw new Refusal(result.code === 'schedule_not_found' ? 'not_found' : 'invalid_request')
}

async function create(ctx: Context, config: Config, form: CreateForm): Promise<void> {
  const bus = ctx.get('lsyEventBus')
  if (bus === undefined) throw new Refusal('unavailable', 'bus')
  const subscription = toSubscription(form, config)
  try {
    await bus.subscribe(subscription, { createdBy: CREATED_BY_SETTINGS })
  } catch (error: unknown) {
    // `LsySubscriptionError` is told by name and code: this package imports no runtime value from the bus package.
    if (error instanceof Error && error.name === 'LsySubscriptionError') {
      throw new Refusal((error as Error & { code?: unknown }).code === 'duplicate_id' ? 'duplicate_id' : 'invalid_subscription')
    }
    throw error
  }
}

/**
 * Run one POST action.
 * @param ctx - Host context.
 * @param config - the form defaults and presets.
 * @param log - logger.
 * @param body - parsed JSON body.
 * @throws {Refusal} for anything the request or the services refuse.
 */
export async function runSubscriptionAction(ctx: Context, config: Config, log: Log, body: unknown): Promise<void> {
  const requested = typeof body === 'object' && body !== null ? (body as { action?: unknown }).action : undefined
  if (requested === 'create') {
    const form = parseBody(createSchema, body).subscription
    await logAction(log, 'subscription.create', form.id, () => create(ctx, config, form))
    return
  }
  if (requested === 'archive.sweep') {
    const sweep = parseBody(sweepSchema, body)
    const bus = ctx.get('lsyEventBus')
    if (bus === undefined) throw new Refusal('unavailable', 'bus')
    await logAction(log, sweep.dryRun ? 'archive.preview' : 'archive.sweep', 'sessions', async () => { await bus.sweepArchive({ dryRun: sweep.dryRun }) })
    return
  }
  const parsed = parseBody(changeSchema, body)
  await logAction(log, `${parsed.target}.${parsed.action}`, parsed.id, () => change(ctx, parsed))
}

export type { NewSubscription, SubscriptionAction }
