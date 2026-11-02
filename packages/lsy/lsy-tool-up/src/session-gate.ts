/**
 * Who may write channel notes and ask for evidence, and how often: only the configured persistent Session, and at most
 * `callsPerTurn` calls of each kind per turn.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: the `session/event` Session event.
import type {} from '@deepseek-ai/dsh-session'
// Type-only: ctx.lsyEventBus.
import type {} from '@deepseek-ai/dsh-lsy-event-bus'

/** The two kinds of call a turn is limited in. */
export type CallKind = 'notes' | 'evidence'

/** The part of the configuration the gate reads. */
export interface GateConfig {
  /** The bus subscription whose persistent Session may write notes and verify evidence; any other Session is refused. */
  subscription: string
  /** Calls per turn of each kind. */
  callsPerTurn: number
}

/** The gate. */
export interface SessionGate {
  /** Why a Session may not write notes or verify evidence, or undefined when it is the configured persistent Session. */
  refusal: (sessionId: string | undefined) => string | undefined
  /** Count one call of `kind` in the Session's turn; false once the turn used `callsPerTurn`. */
  take: (sessionId: string, kind: CallKind) => boolean
}

/**
 * Open the gate for a scope. What each Session's open turn already used is cleared at its turn end.
 * @param ctx - the preset scope's context.
 * @param config - the subscription and the per-turn limit.
 * @returns the gate.
 */
export function sessionGate(ctx: Context, config: GateConfig): SessionGate {
  const used = new Map<string, Record<CallKind, number>>()
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') used.delete(session.id)
  })
  return {
    refusal(sessionId) {
      if (sessionId === undefined) return 'the call runs outside a Session'
      const bus = ctx.get('lsyEventBus')
      if (bus === undefined) return 'lsy-event-bus is not running, so the persistent Session is unknown'
      return bus.persistentSubscriptionOf(sessionId) === config.subscription ? undefined : `only the persistent ${config.subscription} Session may do this`
    },
    take(sessionId, kind) {
      const counts = used.get(sessionId) ?? { notes: 0, evidence: 0 }
      used.set(sessionId, counts)
      if (counts[kind] >= config.callsPerTurn) return false
      counts[kind] += 1
      return true
    },
  }
}
