/**
 * Local files sent to the owner: those `wechat_send_file` names, and the local pictures a final answer refers to with
 * markdown, which WeChat cannot show inside a text message. Each goes as its own message through the open reply window
 * and never waits in the outbox.
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { BackgroundWork } from '@deepseek-ai/dsh-service-kit'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { isStaleTokenError } from './api.ts'
import { errorText } from './errors.ts'
import type { Config } from './index.ts'
import type { AccountLink } from './link.ts'
import { outboundKind, uploadMedia, type OutboundKind } from './media.ts'
import type { wechatDomain } from './storage.ts'
import { fitText, markdownImages, withoutMarkdownImages, type MarkdownImage } from './text.ts'
import type { ChatTurns } from './turns.ts'
import type { ReplyWindow } from './window.ts'

/** Outcome of {@link OutgoingFiles.sendFile}: what went out, or why nothing did. */
export type SendFileResult =
  | { readonly sent: OutboundKind; readonly name: string; readonly bytes: number }
  | { readonly notSent: string }

/** One local file read and checked for sending. */
export interface OutgoingFile {
  /** Absolute path it was read from. */
  readonly path: string
  /** Leaf name the owner sees. */
  readonly name: string
  readonly data: Buffer
  readonly size: number
}

/** Whether a markdown image target points somewhere this computer cannot read: a URL or a protocol-relative path. */
function isRemoteReference(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith('//')
}

/** What {@link OutgoingFiles} needs of the channel. */
export interface OutgoingFilesDeps {
  /** The storage domain, once open. */
  readonly ready: Promise<Domain<typeof wechatDomain>>
  readonly link: AccountLink
  readonly window: ReplyWindow
  /** What each running turn already sent. */
  readonly turns: ChatTurns
  /** Serializes every send with the other storage changes. */
  readonly background: BackgroundWork
  readonly config: Pick<Config, 'cdnBaseUrl' | 'chat' | 'maxMediaBytes' | 'mediaTimeoutMs' | 'repliesPerToken'>
  readonly logger: Context['logger']
  /** Aborts when the channel stops. */
  readonly signal: AbortSignal
}

/** Files and inline pictures for the owner. */
export class OutgoingFiles {
  /** @param deps - storage, the reply window, the running turns, limits, and log. */
  constructor(private readonly deps: OutgoingFilesDeps) {}

  /**
   * Send one local file to the owner through the open reply window, keeping the window's last slot for the turn's text reply.
   * @param path - absolute path of a regular file within `maxMediaBytes`.
   * @param sessionId - the Session sending it, so a markdown image of the same file in this turn's answer is not sent twice.
   * @returns what was sent, or why it was not.
   */
  async sendFile(path: string, sessionId?: string): Promise<SendFileResult> {
    const file = await this.readOutgoing(path)
    if ('notSent' in file) return file
    const result = await this.sendOutgoing(file, true)
    if ('sent' in result && sessionId !== undefined) this.deps.turns.turnSends(sessionId).files.add(file.path)
    return result
  }

  /**
   * Read one local file and apply the checks every outbound attachment shares:
   * an absolute path, a regular non-empty file within `maxMediaBytes`.
   * @param path - the path to read.
   * @returns the bytes and size, or why the file cannot be sent.
   */
  private async readOutgoing(path: string): Promise<OutgoingFile | { notSent: string }> {
    const { maxMediaBytes } = this.deps.config
    if (!isAbsolute(path)) return { notSent: 'path must be absolute' }
    let size: number
    try {
      const info = await stat(path)
      if (!info.isFile()) return { notSent: 'not a regular file' }
      size = info.size
    } catch (error: unknown) {
      return { notSent: `cannot read the file (${(error as NodeJS.ErrnoException).code ?? errorText(error)})` }
    }
    if (size === 0) return { notSent: 'the file is empty' }
    if (size > maxMediaBytes) return { notSent: `the file exceeds ${maxMediaBytes} bytes` }
    return { path, name: basename(path), data: await readFile(path), size }
  }

  /**
   * Upload one checked file and send it as its own message through the open reply window.
   * @param file - the file as {@link readOutgoing} read it.
   * @param reserveLastSlot - keep the window's last slot for the turn's text reply, as a file sent
   * in the middle of a turn does; a picture that follows the reply has nothing left to reserve.
   * @returns what was sent, or why it was not.
   */
  private sendOutgoing(file: OutgoingFile, reserveLastSlot: boolean): Promise<SendFileResult> {
    const { link, window, config, logger } = this.deps
    return this.deps.background.serialize(async (): Promise<SendFileResult> => {
      const domain = await this.deps.ready
      const target = window.target(domain)
      if (typeof target === 'string') return { notSent: target }
      if (reserveLastSlot && target.window.used + 1 >= config.repliesPerToken) return { notSent: 'reply quota nearly used up; the last message is kept for the text reply' }
      const client = link.client(target.account)
      let uploaded: Awaited<ReturnType<typeof uploadMedia>>
      try {
        uploaded = await uploadMedia(client, target.account.ownerUserId, file.name, file.data, {
          cdnBaseUrl: config.cdnBaseUrl, timeoutMs: config.mediaTimeoutMs, signal: this.deps.signal,
        })
      } catch (error: unknown) {
        if (isStaleTokenError(error)) {
          link.markStale(target.account)
          return { notSent: 'bot token is stale' }
        }
        logger.warn(`wechat: uploading ${file.name} failed: ${errorText(error)}`)
        return { notSent: `upload failed: ${errorText(error)}` }
      }
      const outcome = await window.transmitItem(domain, target, uploaded.item, `${uploaded.kind} ${file.name} (${file.size} bytes) from ${file.path}`, 'file')
      return outcome === 'sent' ? { sent: uploaded.kind, name: file.name, bytes: file.size } : { notSent: outcome }
    })
  }

  /**
   * Split a final answer into the text to send and the local pictures it refers to with
   * markdown (`![alt](path)`, `![alt](<path with spaces>)`). A reference to a remote URL, a
   * missing file, a file over the size limit, or something that is not a PNG, JPEG, GIF, or
   * WebP image stays in the text as written and is logged, so the owner still sees what the
   * model meant; a reference to a file this turn already sent with `wechat_send_file` is
   * dropped, since the owner has that picture.
   * @param text - the answer as the model wrote it.
   * @param sessionId - the answering Session, for what its turn already sent.
   * @returns the text without the references that will be sent, and those pictures in the order they appeared.
   */
  async planInlinePictures(text: string, sessionId: string): Promise<{ text: string; pictures: OutgoingFile[] }> {
    const { logger } = this.deps
    const images = markdownImages(text)
    if (images.length === 0) return { text, pictures: [] }
    const alreadySent = this.deps.turns.sent(sessionId)?.files
    const strip: MarkdownImage[] = []
    const pictures: OutgoingFile[] = []
    const planned = new Set<string>()
    for (const image of images) {
      const target = image.target
      if (isRemoteReference(target)) {
        logger.info(`wechat: left a markdown image in Session ${sessionId}'s answer (a remote URL is not sent): ${fitText(target, 200)}`)
        continue
      }
      const path = resolve(this.deps.config.chat.workspacePath, target)
      if (alreadySent?.has(path) === true) {
        strip.push(image)
        logger.info(`wechat: a picture already sent with wechat_send_file in this turn is not sent again: ${path}`)
        continue
      }
      if (planned.has(path)) {
        strip.push(image)
        continue
      }
      const file = await this.readOutgoing(path)
      if ('notSent' in file) {
        logger.info(`wechat: left a markdown image in Session ${sessionId}'s answer (${file.notSent}): ${fitText(target, 200)}`)
        continue
      }
      if (outboundKind(file.name, file.data) !== 'image') {
        logger.info(`wechat: left a markdown image in Session ${sessionId}'s answer (not a PNG, JPEG, GIF, or WebP image): ${fitText(target, 200)}`)
        continue
      }
      planned.add(path)
      pictures.push(file)
      strip.push(image)
    }
    return { text: withoutMarkdownImages(text, strip), pictures }
  }

  /**
   * Send the pictures of a final answer, one message each, after its text. Each counts against
   * the reply window like any other message; a picture cannot wait in the outbox, so when the
   * answer itself is held for the morning they are not sent and the log says so.
   * @param sessionId - the answering Session, for the log.
   * @param pictures - the pictures, in the order they appeared in the answer.
   * @param held - the answer waits for the owner to wake.
   */
  async sendInlinePictures(sessionId: string, pictures: readonly OutgoingFile[], held: boolean): Promise<void> {
    if (pictures.length === 0) return
    if (held) {
      this.deps.logger.info(`wechat: ${pictures.length} picture(s) of Session ${sessionId}'s answer were not sent: the answer waits for the morning`)
      return
    }
    for (const file of pictures) {
      const result = await this.sendOutgoing(file, false)
      if ('notSent' in result) this.deps.logger.warn(`wechat: the picture ${file.name} of Session ${sessionId}'s answer was not sent: ${result.notSent}`)
    }
  }
}
