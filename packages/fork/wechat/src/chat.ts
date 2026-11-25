/**
 * The owner's chat Session: the stored one while it resolves, a new one otherwise or after `/new`, the handover of what
 * the earlier chat Sessions own, and the notices queued for its next step without starting a turn.
 */

import { mkdirSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
// Type-only: ctx.schedule, whose tasks follow the owner from an earlier chat Session into the current one.
import type {} from '@deepseek-ai/dsh-schedule'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { forgetOldest, openPresetSession, unavailableReason, type BackgroundWork } from '@deepseek-ai/dsh-service-kit'
import { errorText } from './errors.ts'
import type { Config } from './index.ts'
import type { AccountLink } from './link.ts'
import type { WechatAccount } from './login.ts'
import type { Outbox } from './outbox.ts'
import type { wechatDomain } from './storage.ts'
import { fitText, handoverFailureText, handoverNotice, handoverText, NEW_CHAT_REPLY, sharedNoteText, WECHAT_RELAY_CHANNEL, type HandoverPart } from './text.ts'

/** Chat Sessions remembered for {@link ChatSessions.ownsSession}; the oldest are forgotten first. */
const MAX_REMEMBERED_SESSIONS = 200

/** What {@link ChatSessions} needs of the channel. */
export interface ChatSessionsDeps {
  /** Host services: Sessions, presets, `ctx.ownerRelay`, `ctx.schedule`, and `ctx.eventBus`. */
  readonly ctx: Context
  /** The storage domain, once open. */
  readonly ready: Promise<Domain<typeof wechatDomain>>
  readonly link: AccountLink
  /** Tells the owner what a handover moved. */
  readonly outbox: Pick<Outbox, 'deliver'>
  /** Serializes every storage change. */
  readonly background: BackgroundWork
  readonly config: Pick<Config, 'chat'>
  /** The storage domain once it opened. */
  domain(): Domain<typeof wechatDomain> | undefined
}

/** The owner's current and earlier chat Sessions. */
export class ChatSessions {
  /** The chat Session every earlier chat Session was last handed over to without a failure, in this process. */
  private handedOverTo: string | undefined

  /** @param deps - Host services, storage, the account, and the delivery path. */
  constructor(private readonly deps: ChatSessionsDeps) {}

  /**
   * Whether this is the owner's current chat Session (not an earlier one a new chat replaced).
   * @param sessionId - Session to check.
   * @returns true for the Session each owner's chat currently runs in.
   */
  isCurrentChat(sessionId: string): boolean {
    const chats = this.deps.domain()?.table('chats')
    return chats !== undefined && [...chats.entries()].some(([, chat]) => chat.sessionId === sessionId)
  }

  /**
   * Whether the channel created a Session: true for every chat Session it remembers.
   * @param sessionId - Session to check.
   * @returns true for the current and earlier chat Sessions.
   */
  ownsSession(sessionId: string): boolean {
    return this.deps.domain()?.table('sessions').get(sessionId) !== undefined
  }

  /**
   * Every remembered chat Session, once storage is open.
   * @returns their ids, which the channel claims with `ctx.ownerRelay`.
   */
  async remembered(): Promise<string[]> {
    const domain = await this.deps.ready
    return [...domain.table('sessions').keys()]
  }

  /**
   * The owner's current chat Session, created when there is none.
   * @returns its id.
   * @throws when no account is bound, so the main agent has no chat.
   */
  async openChat(): Promise<SessionId> {
    const domain = await this.deps.ready
    const account = this.deps.link.account
    if (account === undefined) throw new Error('WeChat is not bound yet, so the main agent has no chat')
    mkdirSync(this.deps.config.chat.workspacePath, { recursive: true })
    return this.chatSession(domain, account)
  }

  /**
   * The owner's chat Session: the stored one while it resolves, otherwise a new one. The first time in this process,
   * and after a handover failed, the earlier chat Sessions are handed over to it first, and the owner hears what moved.
   * @param domain - the open storage domain.
   * @param account - the bound account, whose owner the chat belongs to.
   * @returns its id.
   */
  async chatSession(domain: Domain<typeof wechatDomain>, account: WechatAccount): Promise<SessionId> {
    const sessionId = await this.resolveChatSession(domain, account)
    if (this.handedOverTo !== sessionId) {
      const { parts, failed } = await this.handOver(domain, sessionId, 'current')
      const lines = [...parts.length === 0 ? [] : [handoverText(parts, 'current')], ...failed.length === 0 ? [] : [handoverFailureText(failed)]]
      if (lines.length > 0) await this.deps.outbox.deliver(lines.join('\n'), 'notice')
    }
    return sessionId
  }

  /** The stored chat Session while it resolves, otherwise a new one. */
  private async resolveChatSession(domain: Domain<typeof wechatDomain>, account: WechatAccount): Promise<SessionId> {
    const { ctx } = this.deps
    const stored = domain.table('chats').get(account.ownerUserId)
    if (stored !== undefined) {
      const sessionId = stored.sessionId as SessionId
      const unavailable = await unavailableReason(ctx, sessionId)
      if (unavailable === undefined) return sessionId
      ctx.logger.info(`wechat: chat Session ${sessionId} is unavailable (${unavailable}); starting a new one`)
    }
    return this.createChatSession(domain, account)
  }

  /** Create, resolve, configure, and remember a new chat Session. */
  private async createChatSession(domain: Domain<typeof wechatDomain>, account: WechatAccount): Promise<SessionId> {
    const { ctx } = this.deps
    const chat = this.deps.config.chat
    const createdId = await openPresetSession(ctx, chat, chat.title)
    const now = Date.now()
    const relay = ctx.get('ownerRelay')
    // Claimed before the first prompt, so the relay follows the Session's first turn.
    relay?.claim(createdId, WECHAT_RELAY_CHANNEL)
    await this.deps.background.serialize(async () => {
      const sessions = domain.table('sessions')
      await sessions.put(createdId, { ownerUserId: account.ownerUserId, createdAt: now })
      await domain.table('chats').put(account.ownerUserId, { sessionId: createdId, createdAt: now })
      await forgetOldest(sessions, MAX_REMEMBERED_SESSIONS, (id) => { relay?.release(id) })
    })
    ctx.logger.info(`wechat: created chat Session ${createdId} in ${chat.workspacePath} (${chat.agentPreset}, ${chat.permissionPreset})`)
    return createdId
  }

  /**
   * `/new`: retire the current chat Session, create the next one at once, and hand the earlier chats over to it, so
   * the reply can say what moved. With no chat yet, the next message creates one as usual.
   * @param domain - the open storage domain.
   * @param account - the bound account, whose owner the chat belongs to.
   * @returns the reply for the owner.
   */
  async startNewChat(domain: Domain<typeof wechatDomain>, account: WechatAccount): Promise<string> {
    const { ctx } = this.deps
    const had = await this.deps.background.serialize(() => domain.table('chats').delete(account.ownerUserId))
    if (!had) return NEW_CHAT_REPLY
    ctx.logger.info('wechat: owner started a new chat')
    let sessionId: SessionId
    try {
      mkdirSync(this.deps.config.chat.workspacePath, { recursive: true })
      sessionId = await this.createChatSession(domain, account)
    } catch (error: unknown) {
      ctx.logger.warn(`wechat: the new chat Session could not be created now; the next message tries again: ${errorText(error)}`)
      return `${NEW_CHAT_REPLY}\n⚠️ 新对话还没建好（${fitText(errorText(error), 200)}），下一条消息时再建。`
    }
    const { parts, failed } = await this.handOver(domain, sessionId, 'new')
    const moved = parts.length === 0 ? NEW_CHAT_REPLY : `${NEW_CHAT_REPLY}${handoverText(parts, 'new')}`
    return failed.length === 0 ? moved : `${moved}\n${handoverFailureText(failed)}`
  }

  /**
   * Move what the earlier chat Sessions own to the current one: schedule tasks through `ctx.schedule`, then the
   * subscriptions they created and every binding registered with `ctx.eventBus` (monitors). The current chat
   * Session gets a notice of what it now owns. Idempotent; after a failure the next message tries again.
   * @param to - the current chat Session.
   * @param where - `new` right after `/new`, `current` when an earlier chat still held work.
   * @returns what moved, by kind, and what failed.
   */
  private async handOver(
    domain: Domain<typeof wechatDomain>, to: SessionId, where: 'new' | 'current',
  ): Promise<{ parts: HandoverPart[]; failed: Array<{ kind: string; error: string }> }> {
    const { ctx } = this.deps
    const from = [...domain.table('sessions').keys()].filter(id => id !== to)
    const parts: HandoverPart[] = []
    const failed: Array<{ kind: string; error: string }> = []
    if (from.length === 0) {
      this.handedOverTo = to
      return { parts, failed }
    }
    const schedule = ctx.get('schedule')
    if (schedule !== undefined) {
      try {
        const moved = await schedule.handOverSessions(from as SessionId[], to)
        if (moved.length > 0) parts.push({ kind: 'schedule', labels: moved.map(task => task.title) })
      } catch (error: unknown) {
        failed.push({ kind: 'schedule', error: errorText(error) })
      }
    }
    const bus = ctx.get('eventBus')
    if (bus !== undefined) {
      try {
        const report = await bus.handOverSessions(from, to)
        for (const part of report.moved) parts.push({ kind: part.kind, labels: part.items.map(item => item.label) })
        failed.push(...report.failed)
      } catch (error: unknown) {
        failed.push({ kind: 'event-bus', error: errorText(error) })
      }
    }
    const summary = parts.length === 0 ? 'nothing to move' : parts.map(part => `${part.labels.length} ${part.kind}`).join(', ')
    const failures = failed.length === 0 ? '' : `; failed: ${failed.map(entry => `${entry.kind} (${entry.error})`).join(', ')}, retried with the next message`
    const log = `wechat: handed earlier chat Session(s) ${from.join(', ')} over to ${to}: ${summary}${failures}`
    if (failed.length === 0) {
      ctx.logger.info(log)
      this.handedOverTo = to
    } else {
      ctx.logger.warn(log)
    }
    if (parts.length > 0) await this.injectNotice(to, handoverNotice(parts, where), 'the earlier chat was handed over')
    return { parts, failed }
  }

  /**
   * Leave a copy of a message another Session sent the owner in the owner's chat Session, so that
   * when the owner answers it on WeChat (where every reply reaches the chat Session) the agent knows
   * what was said. It waits for the chat Session's next turn and never starts one; with no chat
   * Session yet there is nobody to tell. A failure only costs the context, never the delivery.
   * @param text - the rendered note, as the owner received or will receive it.
   * @param from - who sent it, as the chat Session reads it; a generic other Session by default.
   * @param except - a Session that needs no copy: the chat Session that wrote the text itself.
   */
  async shareWithChat(text: string, from?: string, except?: string): Promise<void> {
    const domain = this.deps.domain()
    /* v8 ignore next -- deliver awaits ready first, so the domain is open. */
    const chats = domain === undefined ? [] : [...domain.table('chats').entries()].map(([, row]) => row)
    const chat = chats.sort((a, b) => b.createdAt - a.createdAt)[0]
    if (chat === undefined || chat.sessionId === except) return
    const shared = sharedNoteText(text, Date.now(), this.deps.config.chat.timeZone, from)
    if (await this.injectNotice(chat.sessionId as SessionId, shared, 'another Session messaged the owner')) {
      this.deps.ctx.logger.info(`wechat: shared a ${text.length}-char note with chat Session ${chat.sessionId}`)
    }
  }

  /**
   * Queue a channel notice for a chat Session's next step without starting a turn.
   * @param sessionId - the chat Session.
   * @param text - the notice.
   * @param summary - what the notice is, for the Session log and this log.
   * @returns whether it was queued; a failure is logged and only costs the context.
   */
  async injectNotice(sessionId: SessionId, text: string, summary: string): Promise<boolean> {
    const { ctx } = this.deps
    try {
      const resolved = await ctx.sessionController.resolveAgent(sessionId)
      if (!('agent' in resolved)) return false
      const agent = resolved.agent as { inject?: (message: UserMessage) => void }
      if (typeof agent.inject !== 'function') return false
      agent.inject(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'wechat', form: 'notice', summary } }))
      return true
    } catch (error: unknown) {
      ctx.logger.warn(`wechat: could not pass a notice (${summary}) to chat Session ${sessionId}: ${errorText(error)}`)
      return false
    }
  }
}
