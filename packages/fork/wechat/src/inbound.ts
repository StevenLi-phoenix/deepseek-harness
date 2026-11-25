/**
 * The owner's messages. Each one opens a reply window and releases the outbox; then a command (`/new`, `/help`, `/stop`)
 * is answered, or the text and its attachments are forwarded to the owner's chat Session.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { BackgroundWork } from '@deepseek-ai/dsh-service-kit'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: ctx.sessionTitle, which names the Sessions `/stop` cancelled.
import type {} from '@deepseek-ai/dsh-session-title'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
// Type-only: ctx.voice, which reads the audio files the owner sends when transcription is on.
import type {} from '@deepseek-ai/dsh-voice'
import { MESSAGE_TYPE_USER, type WeixinMessage } from './api.ts'
import type { ChatSessions } from './chat.ts'
import { errorText } from './errors.ts'
import type { Config } from './index.ts'
import type { WechatAccount } from './login.ts'
import { attachmentNote, describeMedia, downloadMedia, isPromptImage, mediaSpec, saveInboxFile, type ReceivedMedia, type Transcription } from './media.ts'
import type { Outbox } from './outbox.ts'
import type { ActivityRecord, wechatDomain } from './storage.ts'
import { fitText, formatGap, HELP_REPLY, inboundText, STOP_IDLE_REPLY, stopReply, timeGapNotice } from './text.ts'
import type { ChatTurns } from './turns.ts'
import { windowKey, type ReplyWindow } from './window.ts'

/** Exact owner text that starts a fresh chat Session. */
const NEW_CHAT_COMMAND = '/new'
/** Exact owner text that cancels every running turn on the Host. */
const STOP_COMMAND = '/stop'
/** Exact owner text that lists the commands. */
const HELP_COMMAND = '/help'

/** What `/stop` needs of the Host agent registry; read through `ctx.get`, so the channel works without one. */
interface RootAgents {
  roots(): Array<{ readonly session: Session; readonly status: string; cancel(cause: { kind: 'user' }): void }>
}

/** What {@link InboundMessages} needs of the channel. */
export interface InboundMessagesDeps {
  /** Host services: `ctx.sessionController`, `ctx.sessionTitle`, the agent registry, `ctx.voice`, and `ctx.ownerRelay`. */
  readonly ctx: Context
  readonly window: Pick<ReplyWindow, 'putWindow' | 'recallSent' | 'recordActivity'>
  readonly outbox: Pick<Outbox, 'deliver' | 'flushOutbox'>
  readonly chat: Pick<ChatSessions, 'chatSession' | 'injectNotice' | 'ownsSession' | 'startNewChat'>
  /** The typing line while the chat works. */
  readonly turns: Pick<ChatTurns, 'armTypingGrace' | 'clearTypingGrace' | 'settleTyping' | 'startTyping' | 'stopTyping'>
  /** Serializes every storage change. */
  readonly background: BackgroundWork
  readonly config: Pick<Config, 'cdnBaseUrl' | 'chat' | 'maxMediaBytes' | 'mediaTimeoutMs' | 'timeGapMs'>
  /** Aborts when the channel stops. */
  readonly signal: AbortSignal
  /** Whether the channel is stopping. */
  stopping(): boolean
}

/** Handles each message the long-poll fetched. */
export class InboundMessages {
  /** @param deps - Host services, the reply window, the delivery path, the chat Sessions, and the typing line. */
  constructor(private readonly deps: InboundMessagesDeps) {}

  /**
   * Accept one owner message: open a reply window, flush the outbox, then answer a command or forward the text.
   * @param domain - the open storage domain.
   * @param account - the account the long-poll used.
   * @param message - the fetched message; one of another type or from another user is dropped.
   */
  async handleMessage(domain: Domain<typeof wechatDomain>, account: WechatAccount, message: WeixinMessage): Promise<void> {
    const { ctx, window, outbox, chat, turns, config } = this.deps
    if (message.message_type !== MESSAGE_TYPE_USER) {
      ctx.logger.debug(`wechat: ignored a message of type ${message.message_type ?? 'unknown'}`)
      return
    }
    if (message.from_user_id !== account.ownerUserId) {
      ctx.logger.info(`wechat: dropped a message from ${message.from_user_id ?? 'an unknown user'}, who is not the owner`)
      return
    }
    const text = inboundText(message, at => window.recallSent(domain, at))
    ctx.logger.info(`wechat: owner message (${text.length} chars)`)
    const token = message.context_token ?? ''
    const arrivedAt = Date.now()
    let before: ActivityRecord | undefined
    await this.deps.background.serialize(async () => {
      // Read before the outbox flush below, whose digest would otherwise count as the latest message.
      before = domain.table('activity').get(account.ownerUserId)
      await window.recordActivity(domain, account.ownerUserId, { ownerAt: arrivedAt })
      if (token === '') {
        ctx.logger.warn('wechat: owner message carries no context_token; replies wait in the outbox')
      } else {
        await window.putWindow(domain, windowKey(account), { token, receivedAt: Date.now(), used: 0, exhausted: false })
      }
      await outbox.flushOutbox(domain)
    })
    if (text === '') return
    const command = text.trim().toLowerCase()
    if (command === NEW_CHAT_COMMAND) {
      await outbox.deliver(await chat.startNewChat(domain, account), 'notice')
      return
    }
    if (command === HELP_COMMAND) {
      await outbox.deliver(HELP_REPLY, 'notice')
      return
    }
    if (command === STOP_COMMAND) {
      await this.stopEverything()
      return
    }
    // Typing starts before attachments download, so the owner sees the message was taken up.
    turns.startTyping()
    const gap = timeGapNotice(arrivedAt, before, config.timeGapMs, config.chat.timeZone)
    try {
      const quietMs = arrivedAt - Math.max(before?.ownerAt ?? 0, before?.sentAt ?? 0)
      await this.forward(domain, account, text, await this.receiveMedia(message), gap === undefined ? undefined : { text: gap, quietMs })
      turns.armTypingGrace()
    } catch (error: unknown) {
      if (this.deps.stopping()) return
      turns.settleTyping()
      ctx.logger.warn(`wechat: forwarding the owner message failed: ${errorText(error)}`)
      await outbox.deliver(`⚠️ 消息没能交给 agent：${fitText(errorText(error), 300)}`, 'notice')
    }
  }

  /**
   * `/stop`: cancel every running root turn on the Host (this chat and the bus Sessions), dropping
   * their queued messages, and tell the owner what stopped. Monitors and reminders keep running;
   * they are not turns. The cancel cause is `user`, so `ctx.ownerRelay` and the bus send nothing for
   * the aborted turns: this answer already says what stopped.
   */
  private async stopEverything(): Promise<void> {
    const { ctx, outbox, chat, turns } = this.deps
    const registry = (ctx.get as (name: string) => unknown)('agents') as RootAgents | undefined
    const running = (registry?.roots() ?? []).filter(agent => agent.status === 'running')
    const labels: string[] = []
    for (const agent of running) {
      const id = agent.session.id
      agent.cancel({ kind: 'user' })
      labels.push(chat.ownsSession(id) ? '微信对话' : ctx.sessionTitle.get(agent.session)?.title ?? `Session ${id}`)
    }
    turns.clearTypingGrace()
    await turns.stopTyping()
    ctx.logger.info(`wechat: /stop cancelled ${running.length} running Session(s)${running.length === 0 ? '' : `: ${running.map(agent => agent.session.id).join(', ')}`}`)
    await outbox.deliver(running.length === 0 ? STOP_IDLE_REPLY : stopReply(labels), 'notice')
  }

  /** Download each image, file, and video of an owner message into the inbox; a failure becomes its reason. */
  private async receiveMedia(message: WeixinMessage): Promise<ReceivedMedia[]> {
    const { ctx, config } = this.deps
    const received: ReceivedMedia[] = []
    /* v8 ignore next -- the text came from item_list, so it is set. */
    for (const item of message.item_list ?? []) {
      const spec = mediaSpec(item)
      if (spec === undefined) continue
      try {
        const media = await downloadMedia(item, {
          cdnBaseUrl: config.cdnBaseUrl,
          maxBytes: config.maxMediaBytes,
          timeoutMs: config.mediaTimeoutMs,
          signal: this.deps.signal,
        })
        const path = await saveInboxFile(join(config.chat.workspacePath, '.wechat-inbox'), media)
        ctx.logger.info(`wechat: received ${describeMedia(media)} at ${path}`)
        const transcript = media.kind === 'file' ? await this.transcribe(media.name, path) : undefined
        received.push(transcript === undefined ? { media, path } : { media, path, transcript })
      } catch (error: unknown) {
        if (this.deps.stopping()) throw error
        ctx.logger.warn(`wechat: could not receive ${spec.kind}: ${errorText(error)}`)
        received.push({ failed: spec.kind, name: spec.name, reason: errorText(error) })
      }
    }
    return received
  }

  /**
   * Speech-to-text of a received audio file, when `ctx.voice` is mounted and transcription is on.
   * A failure is the answer, not an error: the file still reaches the agent, with the reason.
   */
  private async transcribe(name: string, path: string): Promise<Transcription | undefined> {
    const { ctx } = this.deps
    const voice = ctx.get('voice')
    if (voice === undefined || !voice.canTranscribe(path)) return undefined
    try {
      const heard = await voice.transcribe(path, { signal: this.deps.signal })
      ctx.logger.info(`wechat: transcribed ${name} (${Array.from(heard.text).length} chars)`)
      return { text: heard.text, engine: heard.engine }
    } catch (error: unknown) {
      if (this.deps.stopping()) throw error
      ctx.logger.warn(`wechat: could not transcribe ${name}: ${errorText(error)}`)
      return { failed: errorText(error) }
    }
  }

  /**
   * Prompt the owner's chat Session with one message: the text, a note on
   * each attachment, and the images as image parts. A Session that refuses
   * images (a text-only model) gets the note with the saved paths instead.
   * A time-gap notice, when the chat was quiet, is queued just before it.
   */
  private async forward(
    domain: Domain<typeof wechatDomain>, account: WechatAccount, text: string, received: readonly ReceivedMedia[],
    gap?: { text: string; quietMs: number },
  ): Promise<void> {
    const { ctx, chat, config } = this.deps
    mkdirSync(config.chat.workspacePath, { recursive: true })
    const sessionId = await chat.chatSession(domain, account)
    if (gap !== undefined && await chat.injectNotice(sessionId, gap.text, 'time since the last chat message')) {
      ctx.logger.info(`wechat: told chat Session ${sessionId} the chat was quiet for ${formatGap(gap.quietMs)}`)
    }
    const images = received.filter(isPromptImage)
    const prompt = (attach: boolean): Promise<unknown> => {
      const note = attachmentNote(received, attach)
      return ctx.sessionController.prompt({
        requestId: randomUUID() as SessionRequestId,
        sessionId,
        // Steer, not queue: a message sent while the agent works (often a picture right after a
        // word) joins the running turn at its next step, so the model sees it natively there.
        mode: 'steer',
        content: [
          { type: 'text', text: note === '' ? text : `${text}\n\n${note}` },
          ...attach ? images.map(image => ({ type: 'image' as const, mediaType: image.media.mediaType, data: image.media.data.toString('base64'), name: image.media.name })) : [],
        ],
        clientTimeZone: config.chat.timeZone,
      }, this.deps.signal)
    }
    try {
      await prompt(images.length > 0)
    } catch (error: unknown) {
      if (images.length === 0 || (error as { code?: unknown }).code !== 'session/attachment-invalid') throw error
      ctx.logger.warn(`wechat: Session ${sessionId} refused the image parts (${errorText(error)}); forwarding the saved paths only`)
      await prompt(false)
    }
    ctx.logger.info(`wechat: forwarded ${text.length} chars${images.length > 0 ? ` and ${images.length} image(s)` : ''} to Session ${sessionId}`)
    // The answer comes back only through the relay; without it the owner would wait in silence.
    if (ctx.get('ownerRelay') === undefined) ctx.logger.warn('wechat: no ownerRelay is mounted, so the answer will not reach WeChat')
  }
}
