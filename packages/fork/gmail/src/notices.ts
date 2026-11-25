/**
 * The notices the service sends the owner through `ctx.ownerNotifier`: a held message waiting for confirmation, and an
 * account that must be signed in again. A notice's body is never logged; a failed delivery logs only its title.
 */

import type { OwnerNotifier } from '@deepseek-ai/dsh-event-bus'
import { errorText } from './errors.ts'
import type { PendingRecord } from './storage.ts'

/** Who the copy of a notice in the owner's chat Session comes from; never shown to the owner. */
const NOTE_ORIGIN = 'the Gmail send gate (gmail: fixed rules, not a model); a held message goes out only when the owner\'s own next message holds its code and you then call gmail_send with that code, or when the owner confirms it in Settings'
/** Characters of a held message's body in the owner's notice. */
const PREVIEW_CHARS = 400

/** One notice for the owner. */
export interface Notice {
  readonly title: string
  readonly body: string
  /** Event kinds a channel matches against its urgent kinds. */
  readonly kinds: readonly string[]
}

/** What {@link OwnerNotices} reads. */
export interface NoticeDeps {
  /** The mounted notifier, read at each send; undefined when none is mounted. */
  readonly notifier: () => OwnerNotifier | undefined
  readonly logger: { warn(message: string): void }
}

/** Hands notices to the owner's notifier. */
export class OwnerNotices {
  /** @param deps - the notifier lookup and the logger. */
  constructor(private readonly deps: NoticeDeps) {}

  /**
   * Send the owner a notice.
   * @param note - the notice.
   * @returns true once the notifier accepted it; false, with a warning, when none is mounted or it failed.
   */
  async send(note: Notice): Promise<boolean> {
    const notifier = this.deps.notifier()
    if (notifier === undefined) {
      this.deps.logger.warn(`gmail: could not send "${note.title}": no ownerNotifier service is mounted`)
      return false
    }
    try {
      await notifier.send({ ...note, origin: NOTE_ORIGIN })
      return true
    } catch (error: unknown) {
      this.deps.logger.warn(`gmail: could not send "${note.title}": ${errorText(error)}`)
      return false
    }
  }
}

/**
 * The start of a held message's text, as the notice and Settings show it.
 * @param text - the message's whole text.
 * @returns the first characters, and whether the text goes on past them.
 */
export function notePreview(text: string): { readonly preview: string; readonly cut: boolean } {
  const characters = Array.from(text)
  return { preview: characters.slice(0, PREVIEW_CHARS).join(''), cut: characters.length > PREVIEW_CHARS }
}

/**
 * The notice of a held message.
 * @param record - the held message as stored.
 * @param cut - whether the message's text goes on past `record.preview`.
 * @param confirmTtlHours - hours the hold waits for the owner.
 * @returns the notice.
 */
export function heldNotice(record: PendingRecord, cut: boolean, confirmTtlHours: number): Notice {
  const lines = [
    `发件：${record.from}`,
    `收件：${record.to.join(', ') || '（无）'}`,
    ...record.cc.length > 0 ? [`抄送：${record.cc.join(', ')}`] : [],
    ...record.bcc.length > 0 ? [`密送：${record.bcc.join(', ')}`] : [],
    `主题：${record.subject}`,
    ...record.attachments.length > 0 ? [`附件：${record.attachments.join('，')}`] : [],
    `为什么要确认：${record.reason}`,
    '',
    '正文开头：',
    `${record.preview}${cut ? '…' : ''}`,
    '',
    `要发就回复「发送 ${record.code}」；不发就不用管，${confirmTtlHours} 小时后作废（草稿留在 Gmail）。也可以在 设置 → 邮箱 里确认或丢弃。`,
  ]
  const recipients = record.to.length + record.cc.length + record.bcc.length
  return {
    title: `✉️ 待你确认：${record.account} 发给 ${record.to[0] ?? record.cc[0] ?? record.bcc[0] ?? ''}${recipients > 1 ? ' 等' : ''}`,
    body: lines.join('\n'),
    kinds: ['gmail.send.held'],
  }
}

/**
 * The notice of an account whose sign-in Google no longer accepts.
 * @param account - account id.
 * @param email - the account's address.
 * @param why - Google's reason, cut to 200 characters.
 * @returns the notice.
 */
export function reconnectNotice(account: string, email: string, why: string): Notice {
  return {
    title: `⚠️ Gmail ${account}（${email}）要重新登录`,
    body: `Google 不再接受这个账号的登录（${why.slice(0, 200)}）。在 设置 → 邮箱 里点「重新登录」；在那之前不能读信或发信。`,
    kinds: ['gmail.reconnect'],
  }
}
