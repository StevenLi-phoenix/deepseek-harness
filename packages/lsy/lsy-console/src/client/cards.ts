/** Overview card text: the status line and the facts line, from a card's state and facts. */

import type { Fact, ServiceCard, ServiceId } from '../views.ts'
import { ago, duration, type Translate } from './format.ts'
import type { ConsoleKey } from './locales.ts'

/** States that have their own copy under `card.<id>.<state>`. */
const OWN_STATES: Readonly<Record<ServiceId, readonly string[]>> = {
  dsh: ['up'],
  bus: ['up', 'limited'],
  bili: ['up', 'svc_only', 'down'],
  qq: ['mounted', 'up', 'reconnecting', 'waiting_token', 'starting', 'recorder_down', 'protocol_mismatch'],
  style: ['mounted', 'up', 'pending'],
  wechat: ['up', 'queued'],
  voice: ['up', 'tts_off', 'tts_down', 'asr_down'],
  cc: ['up', 'nologin', 'disabled'],
  ams: ['up', 'down'],
  llm: ['ok', 'warn', 'off'],
}

/** States every service shares under `state.<state>`. */
const SHARED_STATES: ReadonlySet<string> = new Set(['up', 'ok', 'warn', 'down', 'absent', 'timeout', 'error', 'loading'])

/** The status line of a card. */
export function statusText(card: ServiceCard, t: Translate): string {
  if (OWN_STATES[card.id].includes(card.state)) return t(`card.${card.id}.${card.state}` as ConsoleKey, params(card.facts))
  return t(`state.${SHARED_STATES.has(card.state) ? card.state : 'error'}` as ConsoleKey)
}

/** Facts as translate parameters; a missing fact reads as a dash. */
function params(facts: Readonly<Record<string, Fact>>): Record<string, string | number> {
  return Object.fromEntries(Object.entries(facts).map(([key, value]) => [key, value === null ? '—' : typeof value === 'boolean' ? String(value) : value]))
}

/** The short facts under the status line, for example the version and the sessions. */
export function factLines(card: ServiceCard, t: Translate, now: number = Date.now()): string[] {
  const { facts } = card
  const text = (key: ConsoleKey, extra: Record<string, string | number> = {}): string => t(key, { ...params(facts), ...extra })
  switch (card.id) {
    case 'dsh': {
      const lines = []
      if (typeof facts.version === 'string') lines.push(text('fact.version'))
      if (typeof facts.sha === 'string') lines.push(text('fact.sha'))
      if (typeof facts.uptime === 'number') lines.push(text('fact.uptime', { duration: duration(facts.uptime, t) }))
      return [lines.join(' · ')].filter(Boolean)
    }
    case 'bus': {
      if (card.state === 'absent') return []
      const limited = typeof facts.limited === 'number' && facts.limited > 0 ? ` · ${text('fact.busLimited')}` : ''
      return [`${text('fact.bus')}${limited}`]
    }
    case 'qq': {
      const lines = [
        typeof facts.account === 'string' ? text('fact.qqAccount') : null,
        typeof facts.groups === 'number' ? text('fact.groups') : null,
        card.state === 'reconnecting' ? text('fact.qqAttempts') : null,
      ].filter(line => line !== null)
      return lines.length === 0 ? detail(card) : [lines.join(' · ')]
    }
    case 'wechat':
      return card.state === 'queued' ? [text('fact.queued')] : detail(card)
    case 'voice':
      if (!('provider' in facts)) return []
      return [[text('fact.voice'), facts.asr === true ? text('fact.asrOn') : text('fact.asrOff')].join(' · ')]
    case 'cc':
      if (!('login' in facts)) return []
      return [[text('fact.sessions'), t(`fact.login.${String(facts.login)}` as ConsoleKey)].join(' · ')]
    case 'style': {
      if (typeof facts.kept !== 'number') return []
      const refreshed = typeof facts.lastRefreshAt === 'number' ? text('fact.styleRefresh', { when: ago(facts.lastRefreshAt, now, t) }) : t('fact.styleNever')
      const trend = facts.ticTrend === 'up' || facts.ticTrend === 'flat' || facts.ticTrend === 'down' ? t(`fact.styleTrend.${facts.ticTrend}`) : null
      return [[text('fact.styleCounts'), refreshed, trend].filter(line => line !== null).join(' · ')]
    }
    case 'llm':
      return typeof facts.percent === 'number' ? [text('fact.llmQuota')] : []
    default:
      return detail(card)
  }
}

/** A note a service's own health report carried. */
function detail(card: ServiceCard): string[] {
  return typeof card.facts.detail === 'string' && card.facts.detail !== '' ? [card.facts.detail] : []
}
