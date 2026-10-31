/** In-memory QQ double: the channel's {@link QqTransport}, driven by fixtures shaped like the Open Platform's events. */

import type { QqHandlers, QqInbound, QqTarget, QqTransport } from '../src/transport.ts'

/** One message the channel sent, as [target, text]. */
export type Sent = [QqTarget, string]

export class FakeQq implements QqTransport {
  readonly sent: Sent[] = []
  /** Number of times the channel opened a connection. */
  runs = 0
  /** Errors the next `run` calls reject with, one each. */
  runErrors: Error[] = []
  /** Errors the next `send` calls throw, one each. */
  sendErrors: Error[] = []
  private handlers: QqHandlers | undefined
  private release: (() => void) | undefined

  run(handlers: QqHandlers, signal: AbortSignal): Promise<void> {
    this.runs += 1
    const error = this.runErrors.shift()
    if (error !== undefined) return Promise.reject(error)
    this.handlers = handlers
    return new Promise((resolve) => {
      this.release = resolve
      signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
  }

  send(target: QqTarget, text: string): Promise<void> {
    const error = this.sendErrors.shift()
    if (error !== undefined) return Promise.reject(error)
    this.sent.push([target, text])
    return Promise.resolve()
  }

  /** The gateway accepted the bot. */
  ready(): void { this.handlers?.ready() }

  /** The connection ended without a stop. */
  drop(): void { this.release?.() }

  /** Deliver one inbound message. */
  deliver(message: QqInbound): void { this.handlers?.message(message) }
}

let counter = 0

/** A private message from `userId`. */
export function privateMessage(userId: string, text: string, overrides: Partial<QqInbound> = {}): QqInbound {
  counter += 1
  return { scope: 'c2c', senderId: userId, messageId: `ROBOT1.0_msg-${counter}`, text, at: Date.now(), attachments: 0, ...overrides }
}

/** A group message that @-mentions the bot, from `memberId` in `groupId`. */
export function groupMessage(groupId: string, memberId: string, text: string, overrides: Partial<QqInbound> = {}): QqInbound {
  counter += 1
  return { scope: 'group', senderId: memberId, groupId, messageId: `ROBOT1.0_gmsg-${counter}`, text, at: Date.now(), attachments: 0, ...overrides }
}
