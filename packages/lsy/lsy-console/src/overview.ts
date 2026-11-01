/**
 * The service overview: one card per integrated service with a health tone, a state, and the facts its status line shows.
 * Every card is read in parallel under the probe deadline; a service that fails, hangs, or is absent turns its own card
 * red or grey and never breaks the page. Only states and counts leave the Host: no URL, key, token, or message text.
 */

import type { Context } from '@deepseek-ai/cordis'
import { claudeCodeOf } from './claude-code.ts'
import type { Config } from './config.ts'
import { readBuildInfo, type BuildInfo } from './build-info.ts'
import { TIMED_OUT, httpProbe, isHealthy, isReachable, within } from './probe.ts'
import type { Fact, OverviewView, ServiceCard, ServiceId, Tone } from './views.ts'
import type {} from '@deepseek-ai/dsh-lsy-event-bus'
import type {} from '@deepseek-ai/dsh-lsy-voice'

/** What a service may report about itself: `health()` is optional, so each service adds it when it has more to say than "mounted". */
export interface HealthReport {
  readonly state: 'ok' | 'warn' | 'down'
  /** A short note for the owner, shown under the status line. */
  readonly detail?: string
}

/** Seams that tests replace. */
export interface OverviewEnv {
  readonly fetch: typeof fetch
  readonly now: () => number
  readonly uptimeSeconds: () => number
  readonly build: () => BuildInfo
}

/** Production seams. */
export const LIVE_ENV: OverviewEnv = {
  fetch: (...args) => fetch(...args),
  now: () => Date.now(),
  uptimeSeconds: () => Math.floor(process.uptime()),
  build: () => readBuildInfo(),
}

/** What the cards read. */
export interface OverviewSources {
  readonly ctx: Context
  readonly config: Config
  readonly env?: OverviewEnv
}

/** A service looked up by name, or undefined when it is not mounted. */
function service(ctx: Context, name: string): Record<string, unknown> | undefined {
  const found = (ctx.get as (name: string) => unknown)(name)
  return typeof found === 'object' && found !== null ? found as Record<string, unknown> : undefined
}

/** Call a method a duck-typed service may have. */
function ask<T>(owner: Record<string, unknown>, method: string): Promise<T | undefined> | T | undefined {
  const fn = owner[method]
  return typeof fn === 'function' ? (fn as () => T).call(owner) : undefined
}

function card(id: ServiceId, tone: Tone, state: string, facts: Record<string, Fact> = {}): ServiceCard {
  return { id, tone, state, facts }
}

function absent(id: ServiceId): ServiceCard {
  return card(id, 'off', 'absent')
}

/** Fold an optional `health()` report into a card whose own facts say the rest. */
async function reported(owner: Record<string, unknown>): Promise<HealthReport | undefined> {
  const report = await ask<HealthReport>(owner, 'health')
  // A duck-typed service may answer anything; only the three known states count.
  return typeof report === 'object' && ['ok', 'warn', 'down'].includes((report as Partial<HealthReport> | null)?.state ?? '') ? report : undefined
}

function dshCard(env: OverviewEnv): ServiceCard {
  const { version, sha } = env.build()
  return card('dsh', 'ok', 'up', { version, sha, uptime: env.uptimeSeconds() })
}

function busCard(ctx: Context): ServiceCard {
  const bus = ctx.get('lsyEventBus')
  if (bus === undefined) return absent('bus')
  const stats = bus.stats()
  const limited = stats.rateLimitHitsLastHour > 0
  return card('bus', limited ? 'warn' : 'ok', limited ? 'limited' : 'up', {
    subscriptions: stats.subscriptions, paused: stats.paused, pending: stats.pending,
    events: stats.eventsLastHour, batches: stats.batchesLastHour, limited: stats.rateLimitHitsLastHour,
  })
}

async function biliCard({ ctx, config, env = LIVE_ENV }: OverviewSources): Promise<ServiceCard> {
  const status = await httpProbe(`${config.bili.url.replace(/\/+$/u, '')}/healthz`, config.probeTimeoutMs, env.fetch)
  const mounted = service(ctx, 'bili')
  if (!isHealthy(status)) return card('bili', 'down', 'down', { plugin: mounted !== undefined })
  const report = mounted === undefined ? undefined : await reported(mounted)
  if (report === undefined) return card('bili', 'ok', mounted === undefined ? 'svc_only' : 'up', {})
  return card('bili', report.state === 'ok' ? 'ok' : report.state, report.state === 'ok' ? 'up' : report.state, { detail: report.detail ?? null })
}

async function qqCard(ctx: Context): Promise<ServiceCard> {
  const qq = service(ctx, 'lsyQq')
  if (qq === undefined) return absent('qq')
  const report = await reported(qq)
  if (report !== undefined) return card('qq', report.state, report.state === 'ok' ? 'up' : report.state, { detail: report.detail ?? null })
  const groups = await ask<{ recorded: boolean }[]>(qq, 'groupOverview')
  return card('qq', 'ok', 'mounted', { groups: groups?.filter(group => group.recorded).length ?? null })
}

async function wechatCard(ctx: Context): Promise<ServiceCard> {
  const notifier = service(ctx, 'lsyNotifier')
  if (notifier === undefined) return absent('wechat')
  const report = await reported(notifier)
  if (report !== undefined && report.state !== 'ok') return card('wechat', report.state, report.state, { detail: report.detail ?? null })
  const queued = (await ask<unknown[]>(notifier, 'outbox'))?.length ?? 0
  return queued > 0 ? card('wechat', 'warn', 'queued', { queued }) : card('wechat', 'ok', 'up')
}

async function voiceCard({ ctx, config, env = LIVE_ENV }: OverviewSources): Promise<ServiceCard> {
  const voice = ctx.get('lsyVoice')
  if (voice === undefined) return absent('voice')
  const summary = voice.describe()
  const [tts, asr] = await Promise.all([
    summary.tts.enabled ? httpProbe(`${summary.tts.url.replace(/\/+$/u, '')}/health`, config.probeTimeoutMs, env.fetch) : null,
    summary.asr.enabled ? httpProbe(`${summary.asr.url.replace(/\/+$/u, '')}/health`, config.probeTimeoutMs, env.fetch) : null,
  ])
  const facts = { provider: summary.tts.provider, asr: summary.asr.enabled, engine: summary.asr.engine }
  if (!summary.tts.enabled) return card('voice', 'off', 'tts_off', { asr: summary.asr.enabled })
  if (!isReachable(tts)) return card('voice', 'down', 'tts_down', facts)
  if (summary.asr.enabled && !isReachable(asr)) return card('voice', 'warn', 'asr_down', facts)
  return card('voice', 'ok', 'up', facts)
}

async function ccCard({ ctx }: OverviewSources): Promise<ServiceCard> {
  const claudeCode = claudeCodeOf(ctx)
  if (claudeCode === undefined) return absent('cc')
  if (!claudeCode.enabled) return card('cc', 'off', 'disabled')
  const view = await claudeCode.view()
  const facts = { sessions: view.sessions.length, max: view.maxSessions, login: view.login }
  return view.login === 'none' ? card('cc', 'warn', 'nologin', facts) : card('cc', 'ok', 'up', facts)
}

async function amsCard({ config, env = LIVE_ENV }: OverviewSources): Promise<ServiceCard | undefined> {
  if (config.ams.url === '') return undefined
  const status = await httpProbe(config.ams.url, config.probeTimeoutMs, env.fetch)
  return isReachable(status) ? card('ams', 'ok', 'up') : card('ams', 'down', 'down')
}

/**
 * Read every card in parallel.
 * @param sources - services, configuration, and seams.
 * @returns the cards in display order; the LLM card is the browser's, from the balance route.
 */
export async function collectOverview(sources: OverviewSources): Promise<OverviewView> {
  const { ctx, config } = sources
  const env = sources.env ?? LIVE_ENV
  // A card's own probes stop at probeTimeoutMs; this outer bound also covers in-process services that never answer.
  const deadline = config.probeTimeoutMs * 2 + 500
  type Build = () => Promise<ServiceCard | undefined> | ServiceCard | undefined
  const guard = async (id: ServiceId, build: Build): Promise<ServiceCard | undefined> => {
    try {
      const outcome = await within(Promise.resolve().then(build), deadline)
      if (outcome === TIMED_OUT) {
        ctx.logger.warn(`lsy-console: the ${id} card did not answer within ${deadline} ms`)
        return card(id, 'down', 'timeout')
      }
      return outcome
    } catch (error: unknown) {
      ctx.logger.warn(`lsy-console: the ${id} card failed: ${error instanceof Error ? error.name : 'error'}`)
      return card(id, 'down', 'error')
    }
  }
  const cards = await Promise.all([
    guard('dsh', () => dshCard(env)),
    guard('bus', () => busCard(ctx)),
    guard('bili', () => biliCard({ ...sources, env })),
    guard('qq', () => qqCard(ctx)),
    guard('wechat', () => wechatCard(ctx)),
    guard('voice', () => voiceCard({ ...sources, env })),
    guard('cc', () => ccCard(sources)),
    guard('ams', () => amsCard({ ...sources, env })),
  ])
  return { cards: cards.filter(entry => entry !== undefined), checkedAt: env.now() }
}
