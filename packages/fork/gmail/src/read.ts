/**
 * Reading an account's mail: search results as thread summaries, threads and messages as the model reads them, and
 * one received attachment saved under the Session's working directory.
 */

import type { GmailApi } from './api.ts'
import { saveAttachment } from './attachments.ts'
import { GmailError } from './errors.ts'
import { decodeEntities } from './html.ts'
import { attachmentPart, attachmentsOf, header, messageView, type MessageView, type ViewOptions } from './message.ts'
import type { SavedAttachment, SearchOptions, SearchResult, ThreadSummary, ThreadView } from './types.ts'
import { readVerificationCode, type VerificationProof, type VerificationLookup } from './verification.ts'

/** The configured limits of reading. */
export interface ReadLimits {
  /** Threads one search returns at most. */
  readonly maxSearchResults: number
  /** Characters of one message body shown to the model. */
  readonly maxBodyChars: number
  /** Characters of an HTML body read at most. */
  readonly maxHtmlChars: number
  /** Newest messages of one thread shown; older ones are only counted. */
  readonly maxThreadMessages: number
  /** Bytes of one received attachment saved. */
  readonly maxDownloadBytes: number
}

/** Reads mail within the configured limits. */
export class MailReader {
  /** @param limits - the configured limits. */
  constructor(private readonly limits: ReadLimits) {}

  /**
   * Search an account's mail.
   * @param api - the account's API client.
   * @param query - Gmail search syntax.
   * @param options - threads wanted (10 by default, capped by `maxSearchResults`) and the page token of a previous page.
   * @returns one summary per thread.
   */
  async search(api: GmailApi, query: string, options: SearchOptions): Promise<SearchResult> {
    const max = Math.max(1, Math.min(options.max ?? 10, this.limits.maxSearchResults))
    const page = await api.listThreads(query, max, options.pageToken)
    const threads = await Promise.all((page.threads ?? []).map(async (entry): Promise<ThreadSummary> => {
      const thread = await api.thread(entry.id, 'metadata')
      const messages = thread.messages ?? []
      const first = messages[0]
      const last = messages.at(-1)
      const labels = [...new Set(messages.flatMap(message => message.labelIds ?? []))]
      const date = Number(last?.internalDate)
      return {
        id: entry.id,
        subject: header(first?.payload, 'Subject'),
        from: header(last?.payload, 'From'),
        date: Number.isFinite(date) && last?.internalDate !== undefined ? date : null,
        snippet: decodeEntities(last?.snippet ?? entry.snippet ?? ''),
        messages: messages.length,
        unread: labels.includes('UNREAD'),
        labels,
      }
    }))
    return { threads, nextPageToken: page.nextPageToken ?? null, estimate: page.resultSizeEstimate ?? threads.length }
  }

  /**
   * Find a recent verification code within the scoped sender, result and body limits.
   * @param api - the account API.
   * @param lookup - the approved sender and receipt bounds.
   * @returns a reduced code or link result, or null when no code matched.
   */
  verificationCode(api: GmailApi, lookup: VerificationLookup): Promise<VerificationProof | null> {
    const { maxSearchResults, maxHtmlChars, maxBodyChars } = this.limits
    return readVerificationCode(api, lookup, maxSearchResults, maxHtmlChars, maxBodyChars)
  }

  /**
   * Read one thread: its newest messages in full.
   * @param api - the account's API client.
   * @param threadId - thread id.
   * @param keepQuotes - keep the quoted history of each reply.
   * @returns the thread.
   */
  async thread(api: GmailApi, threadId: string, keepQuotes: boolean): Promise<ThreadView> {
    const thread = await api.thread(threadId, 'full')
    const all = thread.messages ?? []
    const shown = all.slice(-this.limits.maxThreadMessages)
    return {
      id: thread.id,
      messages: shown.map(message => messageView(message, this.viewOptions(keepQuotes))),
      omitted: all.length - shown.length,
    }
  }

  /**
   * Read one message.
   * @param api - the account's API client.
   * @param messageId - message id.
   * @param keepQuotes - keep the quoted history.
   * @returns the message.
   */
  async message(api: GmailApi, messageId: string, keepQuotes: boolean): Promise<MessageView> {
    return messageView(await api.message(messageId, 'full'), this.viewOptions(keepQuotes))
  }

  /**
   * Save one attachment of a received message under `<cwd>/.gmail-inbox/`.
   * @param api - the account's API client.
   * @param messageId - message id.
   * @param part - the attachment's part id.
   * @param cwd - the Session's working directory.
   * @returns where it was saved.
   * @throws GmailError `not-found` for a part that is no attachment, `limit` for one over `maxDownloadBytes`.
   */
  async download(api: GmailApi, messageId: string, part: string, cwd: string): Promise<SavedAttachment> {
    const message = await api.message(messageId, 'full')
    const found = attachmentPart(message.payload, part)
    if (found === undefined) {
      const listed = attachmentsOf(message.payload).map(entry => `${entry.part} (${entry.filename})`)
      throw new GmailError('not-found', `message ${messageId} has no attachment part "${part}"; its attachments: ${listed.length === 0 ? 'none' : listed.join(', ')}`)
    }
    const size = found.body?.size ?? 0
    if (size > this.limits.maxDownloadBytes) throw new GmailError('limit', `the attachment holds ${size} bytes, over the ${this.limits.maxDownloadBytes}-byte limit`)
    const inline = found.body?.data ?? ''
    const data = found.body?.attachmentId !== undefined ? await api.attachment(messageId, found.body.attachmentId) : Buffer.from(inline, 'base64url')
    if (data.length > this.limits.maxDownloadBytes) throw new GmailError('limit', `the attachment holds ${data.length} bytes, over the ${this.limits.maxDownloadBytes}-byte limit`)
    const filename = found.filename
    const path = await saveAttachment(cwd, messageId.slice(-8), filename, data)
    return { path, filename, mimeType: found.mimeType ?? 'application/octet-stream', bytes: data.length }
  }

  private viewOptions(keepQuotes: boolean): ViewOptions {
    return { maxChars: this.limits.maxBodyChars, maxHtmlChars: this.limits.maxHtmlChars, keepQuotes }
  }
}
