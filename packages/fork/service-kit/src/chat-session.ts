/** The Sessions a channel service opens for its chats, and how it hands them to the owner relay. */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: ctx.sessionController.
import type {} from '@deepseek-ai/dsh-api-session-controller'
// Type-only: ctx.permissionPresets.
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: ctx.sessionTitle.
import type {} from '@deepseek-ai/dsh-session-title'

/** Resolve failures that keep the stored Session: it exists and is only unavailable right now. */
const TRANSIENT_RESOLVE_CODES: ReadonlySet<string> = new Set(['session/agent-busy', 'session/writer-held'])

/** Where and how a channel's Sessions run. */
export interface PresetSession {
  readonly workspacePath: string
  readonly agentPreset: string
  readonly permissionPreset: string
}

/**
 * Whether a stored Session can take the next prompt.
 * @param ctx - the context holding `sessionController`.
 * @param sessionId - the stored Session.
 * @returns undefined when it resolves, else the code of why it does not, after which the caller starts a new one.
 * @throws the resolve error when it is transient (the agent is busy, the writer is held).
 */
export async function unavailableReason(ctx: Context, sessionId: SessionId): Promise<string | undefined> {
  const resolved = await ctx.sessionController.resolveAgent(sessionId)
  if ('agent' in resolved) return undefined
  if (TRANSIENT_RESOLVE_CODES.has(resolved.error.code)) throw resolved.error
  return resolved.error.code
}

/**
 * Create a Session in the preset's workspace, with its agent preset, permission preset, and title.
 * @param ctx - the context holding `sessionController`, `permissionPresets`, and `sessionTitle`.
 * @param preset - where and how the Session runs.
 * @param title - its title.
 * @returns the new Session's id.
 * @throws on an unknown permission preset before any Session exists, and the resolve error of the new Session.
 */
export async function openPresetSession(ctx: Context, preset: PresetSession, title: string): Promise<SessionId> {
  ctx.permissionPresets.resolve(preset.permissionPreset)
  const created = await ctx.sessionController.create({ cwd: preset.workspacePath, agentPreset: preset.agentPreset })
  const resolved = await ctx.sessionController.resolveAgent(created.sessionId)
  if ('error' in resolved) throw resolved.error
  ctx.permissionPresets.set(resolved.agent.session, preset.permissionPreset)
  ctx.sessionTitle.rename(resolved.agent.session, title)
  return created.sessionId
}

/** The remembered Sessions of a channel, keyed by Session id. */
export interface RememberedSessions {
  entries(): Iterable<[string, { readonly createdAt: number }]>
  readonly size: number
  delete(sessionId: string): Promise<boolean>
}

/**
 * Forget the oldest remembered Sessions beyond `max`.
 * @param sessions - the remembered Sessions.
 * @param max - how many to keep.
 * @param forgotten - called with each forgotten Session's id after it is deleted.
 * @returns settlement after every delete.
 */
export async function forgetOldest(sessions: RememberedSessions, max: number, forgotten: (sessionId: string) => void): Promise<void> {
  const excess = [...sessions.entries()]
    .sort(([, a], [, b]) => a.createdAt - b.createdAt)
    .slice(0, Math.max(0, sessions.size - max))
  for (const [id] of excess) {
    await sessions.delete(id)
    forgotten(id)
  }
}

/** What {@link joinRelay} uses of the owner relay (`ctx.ownerRelay`, whose package imports this one's users). */
export interface RelayRegistry<Channel extends { readonly name: string }> {
  registerChannel(channel: Channel): () => void
  claim(sessionId: string, channelName: string): void
}

/**
 * Register a channel with the owner relay and, once the service's storage is open, claim every Session it stored.
 * @param ctx - the context whose logger reports the claim, under `label`.
 * @param relay - the owner relay.
 * @param channel - the channel.
 * @param stored - the stored Session ids once storage is open; a rejection is logged and nothing is claimed.
 * @param label - the service's log prefix.
 * @returns the disposer that unregisters the channel; after it, a late `stored` claims nothing.
 */
export function joinRelay<Channel extends { readonly name: string }>(
  ctx: Context,
  relay: RelayRegistry<Channel>,
  channel: Channel,
  stored: Promise<readonly string[]>,
  label: string,
): () => void {
  const unregister = relay.registerChannel(channel)
  let joined = true
  stored.then((ids) => {
    if (!joined) return
    for (const id of ids) relay.claim(id, channel.name)
    ctx.logger.info(`${label}: the relay carries ${ids.length} chat Session(s) through channel ${channel.name}`)
  }, (error: unknown) => {
    ctx.logger.warn(`${label}: chat Sessions not claimed with the relay: ${error instanceof Error ? error.message : String(error)}`)
  })
  return () => {
    joined = false
    unregister()
  }
}
