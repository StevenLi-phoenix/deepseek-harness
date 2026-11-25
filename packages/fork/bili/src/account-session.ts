/**
 * The account's long-lived Session: the stored one while it resolves and is not archived, else a
 * new one in the configured workspace and presets, claimed with `ctx.ownerRelay` before its first
 * prompt. It is prompted with the owner's messages or the daily share, each marked on the DM
 * channel before the prompt goes in.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
// Type-only: ctx.ownerRelay, which a new Session is claimed with.
import type {} from '@deepseek-ai/dsh-owner-relay'
import { openPresetSession, unavailableReason } from '@deepseek-ai/dsh-service-kit'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
// Type-only: ctx.workspaceRegistry, whose archived Session ids the account's Session is checked against.
import type {} from '@deepseek-ai/dsh-workspace'
import { BILI_RELAY_CHANNEL, type DmChannel, type TurnKind } from './dm.ts'
import type { biliDomain } from './storage.ts'

/** How the account's Session is created. */
export interface SessionConfig {
  /** Absolute directory the Session works in; created before every prompt. */
  workspacePath: string
  /** Agent preset of the Session; the bundle defines `bili` with only the Bilibili tools. */
  agentPreset: string
  /** Permission preset set on a new Session; the `bili` preset mounts no shell or file tools, and nobody approves calls. */
  permissionPreset: string
  /** Session title. */
  title: string
}

/** What the account's Session needs of the account. */
export interface AccountSessionHost {
  /** The plugin's context: the Session Controller, presets, titles, the relay, the workspace registry, and the logger. */
  readonly ctx: Context
  readonly ready: Promise<Domain<typeof biliDomain>>
  /** Storage work, one piece at a time. */
  serialize<T>(work: () => Promise<T>): Promise<T>
  readonly session: SessionConfig
  /** IANA time zone sent with every prompt. */
  readonly timeZone: string
  /** Aborted when the account stops. */
  readonly signal: AbortSignal
  /** The DM channel, which learns before each prompt what the turn's answer is. */
  readonly dm: Pick<DmChannel, 'expectReply' | 'expectShare' | 'dropReply'>
}

/** The account's Session: finding or creating it, and prompting it. */
export class AccountSession {
  /** @param host - the context, storage, the Session settings, and the DM channel. */
  constructor(private readonly host: AccountSessionHost) {}

  /**
   * Prompt the account's Session unless it is in a turn, marking what its answer is: the reply to
   * the owner's messages, or the daily share.
   * @param text - the prompt.
   * @param kind - what the turn's answer is.
   * @returns the Session id, or undefined when the Session is in a turn.
   */
  async prompt(text: string, kind: TurnKind): Promise<SessionId | undefined> {
    const { ctx } = this.host
    mkdirSync(this.host.session.workspacePath, { recursive: true })
    const sessionId = await this.current()
    const resolved = await ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw resolved.error
    const status = (resolved.agent as { status?: string }).status
    if (status !== undefined && status !== 'idle') {
      ctx.logger.info(`bili: Session ${sessionId} is ${status}; ${kind === 'reply' ? 'the owner\'s messages wait for the next check' : 'the share waits'}`)
      return undefined
    }
    // Known before the turn can end: its answer is the reply, or the share.
    if (kind === 'reply') this.host.dm.expectReply(sessionId)
    else this.host.dm.expectShare(sessionId)
    try {
      await ctx.sessionController.prompt({
        requestId: randomUUID() as SessionRequestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: this.host.timeZone,
      }, this.host.signal)
    } catch (error: unknown) {
      this.host.dm.dropReply(sessionId)
      throw error
    }
    if (kind === 'reply') ctx.logger.info(`bili: the owner's messages prompted Session ${sessionId} (${text.length} chars)`)
    return sessionId
  }

  /** The account's Session: the stored one while it resolves, otherwise a new one. */
  private async current(): Promise<SessionId> {
    const { ctx } = this.host
    const domain = await this.host.ready
    const stored = domain.table('current').get('session')
    if (stored !== undefined) {
      const sessionId = stored.sessionId as SessionId
      // An archived Session still resolves, but its turns end `blocked` before any model call (the archived-session gate),
      // so the owner's messages would get a placeholder answer.
      if (ctx.get('workspaceRegistry')?.archivedSessionIds.includes(sessionId) === true) {
        ctx.logger.info(`bili: Session ${sessionId} is archived; starting a new one`)
      } else {
        const unavailable = await unavailableReason(ctx, sessionId)
        if (unavailable === undefined) return sessionId
        ctx.logger.info(`bili: Session ${sessionId} is unavailable (${unavailable}); starting a new one`)
      }
    }
    const session = this.host.session
    const createdId = await openPresetSession(ctx, session, session.title)
    const now = Date.now()
    // Claimed before the first prompt, so the relay follows the Session's first turn.
    ctx.get('ownerRelay')?.claim(createdId, BILI_RELAY_CHANNEL)
    await this.host.serialize(async () => {
      await domain.table('sessions').put(createdId, { sessionId: createdId, createdAt: now })
      await domain.table('current').put('session', { sessionId: createdId, createdAt: now })
    })
    ctx.logger.info(`bili: created Session ${createdId} in ${session.workspacePath} (${session.agentPreset}, ${session.permissionPreset})`)
    return createdId
  }
}
