/** Telegram Bot API notifier: provides `ctx.lsyNotifier` for the lsy event bus. */

import { Context, Service } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { LsyNote, LsyNotifier } from '@deepseek-ai/dsh-lsy-event-bus'
import z from '@deepseek-ai/schemastery'

/** Telegram rejects message text longer than this. */
const MAX_MESSAGE_CHARS = 4096

/** Notifier configuration. */
export interface Config {
  /** Credential reference holding the bot token from @BotFather. */
  botTokenEnv: string
  /** Target chat id; a user id, a group id (negative), or `@channelname`. */
  chatId: string
  /** Bot API origin, overridable for a local Bot API server. */
  apiBase: string
  /** Per-request deadline in milliseconds. */
  timeoutMs: number
  /** Longest `retry_after` honored with one retry; longer limits fail the send. */
  maxRetryAfterSeconds: number
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  botTokenEnv: z.string().role('credential-ref').default('LSY_TELEGRAM_BOT_TOKEN'),
  chatId: z.string().required(),
  apiBase: z.string().default('https://api.telegram.org'),
  timeoutMs: z.natural().min(1).default(15_000),
  maxRetryAfterSeconds: z.natural().default(30),
})

/** The subset of a Bot API response this notifier reads. */
interface BotApiReply {
  ok?: unknown
  description?: unknown
  parameters?: { retry_after?: unknown }
}

/** Parse a Bot API reply body; anything else reads as an empty reply. */
function parseReply(text: string): BotApiReply {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null ? value : {}
  } catch {
    return {}
  }
}

/** Plain-text message: title, body, and link separated by blank lines, clipped to the Telegram limit. */
export function renderNote(note: LsyNote): string {
  const text = [note.title, note.body, note.url].filter(part => part !== undefined && part.trim() !== '').join('\n\n')
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…` : text
}

/** Sends notes to one Telegram chat through the Bot API `sendMessage` method. */
export class TelegramNotifier extends Service implements LsyNotifier {
  static inject = ['credentials']
  static Config = Config

  private readonly tokenRef: CredentialRef

  /**
   * @param ctx - Host services owning credentials.
   * @param config - Bot token reference, chat, and request limits.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'lsyNotifier')
    if (typeof config.chatId !== 'string' || config.chatId.trim() === '') {
      throw new Error('lsy-telegram: chatId must be a non-empty string')
    }
    this.tokenRef = credentialRef(config.botTokenEnv)
  }

  /**
   * Deliver one note.
   * @param note - title, optional body, and optional link.
   * @returns resolves once Telegram accepted the message.
   * @throws when the token is unset or Telegram rejects the message; the error never contains the token.
   */
  async send(note: LsyNote): Promise<void> {
    const token = (await this.ctx.credentials.resolve(this.tokenRef))?.value
    if (token === undefined) {
      throw new Error(`Telegram bot token ${this.config.botTokenEnv} is not configured`)
    }
    const body = JSON.stringify({
      chat_id: this.config.chatId,
      text: renderNote(note),
      link_preview_options: { is_disabled: true },
    })
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(`${this.config.apiBase}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.timeoutMs),
      })
      const reply = parseReply(await response.text())
      if (response.ok && reply.ok === true) {
        this.ctx.logger.debug(`lsy-telegram: sent "${note.title}"`)
        return
      }
      const retryAfter = reply.parameters?.retry_after
      if (response.status === 429 && attempt === 0 && typeof retryAfter === 'number' && retryAfter <= this.config.maxRetryAfterSeconds) {
        this.ctx.logger.info(`lsy-telegram: rate limited; retrying in ${retryAfter}s`)
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000))
        continue
      }
      const description = typeof reply.description === 'string' ? reply.description : '(no description)'
      throw new Error(`Telegram sendMessage failed: HTTP ${response.status} ${description}`)
    }
  }
}

export default TelegramNotifier
