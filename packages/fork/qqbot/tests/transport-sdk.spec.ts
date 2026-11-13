import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSdkTransport, GROUP_AND_C2C_INTENT, type QqInbound } from '../src/transport.ts'

const APP_SECRET = 'app-secret-must-not-leak-0123456789'

interface SdkConfig {
  appId: string
  appSecret: string
  intents: number
  baseUrl?: string
  tokenBaseUrl?: string
  logger: Record<'info' | 'debug' | 'warn' | 'error', (text: unknown) => void>
}

/** What the stand-in SDK client records and lets a test drive. */
const sdk = vi.hoisted(() => ({
  constructed: [] as SdkConfig[],
  listeners: new Map<string, (...args: unknown[]) => void>(),
  sent: [] as Array<[unknown, string]>,
  start: undefined as undefined | ((signal: AbortSignal) => Promise<void>),
}))

vi.mock('@tencent-connect/qqbot-nodejs', () => ({
  QQBot: class {
    constructor(config: SdkConfig) { sdk.constructed.push(config) }
    on(event: string, listener: (...args: unknown[]) => void): void { sdk.listeners.set(event, listener) }
    start(signal: AbortSignal): Promise<void> { return sdk.start === undefined ? Promise.resolve() : sdk.start(signal) }
    sendText(target: unknown, text: string): Promise<void> { sdk.sent.push([target, text]); return Promise.resolve() }
  },
}))

afterEach(() => {
  sdk.constructed.length = 0
  sdk.listeners.clear()
  sdk.sent.length = 0
  sdk.start = undefined
})

function handlersOf() {
  const messages: QqInbound[] = []
  const events: string[] = []
  return {
    messages,
    events,
    handlers: {
      message: (message: QqInbound) => { messages.push(message) },
      ready: () => { events.push('ready') },
      disconnected: (reason: string) => { events.push(`disconnected ${reason}`) },
    },
  }
}

const config = (): SdkConfig => sdk.constructed[0]!

describe('createSdkTransport with a stand-in SDK client', () => {
  it('leaves the SDK endpoints at their defaults when none are given, and asks for group and private intents only', async () => {
    const transport = createSdkTransport({ appId: '1', appSecret: APP_SECRET, log: { debug: () => {}, warn: () => {} } })
    await transport.run(handlersOf().handlers, new AbortController().signal)
    expect(config()).toMatchObject({ appId: '1', appSecret: APP_SECRET, intents: GROUP_AND_C2C_INTENT })
    expect(config()).not.toHaveProperty('baseUrl')
    expect(config()).not.toHaveProperty('tokenBaseUrl')
  })

  it('passes the endpoint overrides through', async () => {
    const transport = createSdkTransport({
      appId: '1', appSecret: APP_SECRET, baseUrl: 'http://127.0.0.1:1', tokenBaseUrl: 'http://127.0.0.1:2', log: { debug: () => {}, warn: () => {} },
    })
    await transport.run(handlersOf().handlers, new AbortController().signal)
    expect(config()).toMatchObject({ baseUrl: 'http://127.0.0.1:1', tokenBaseUrl: 'http://127.0.0.1:2' })
  })

  it('keeps SDK chatter at debug, warnings and errors at warn, and scrubs the secret from every line', async () => {
    const debug: string[] = []
    const warn: string[] = []
    const transport = createSdkTransport({
      appId: '1', appSecret: APP_SECRET, log: { debug: (m) => { debug.push(m) }, warn: (m) => { warn.push(m) } },
    })
    await transport.run(handlersOf().handlers, new AbortController().signal)
    const { logger } = config()
    logger.info('gateway open')
    logger.debug(`token ${APP_SECRET}`)
    logger.warn('slow')
    logger.error(`failed with ${APP_SECRET}`)
    logger.info(42)
    expect(debug).toEqual(['gateway open', 'token ***', '42'])
    expect(warn).toEqual(['slow', 'failed with ***'])
  })

  it('delivers supported messages, drops unsupported ones, and reports ready, resumed and disconnected', async () => {
    const transport = createSdkTransport({ appId: '1', appSecret: APP_SECRET, log: { debug: () => {}, warn: () => {} } })
    const seen = handlersOf()
    await transport.run(seen.handlers, new AbortController().signal)
    const emit = (event: string, ...args: unknown[]): void => { sdk.listeners.get(event)!(...args) }
    emit('message', {}, { kind: 'c2c', senderId: 'u', messageId: 'm1', content: ' hi ', attachments: 'not a list' })
    emit('message', {}, { kind: 'guild', senderId: 'u', messageId: 'm2', content: 'noise' })
    emit('ready')
    emit('resumed')
    emit('disconnected', { code: 4009, secret: APP_SECRET })
    expect(seen.messages).toHaveLength(1)
    expect(seen.messages[0]).toMatchObject({ scope: 'c2c', senderId: 'u', messageId: 'm1', text: 'hi', attachments: 0 })
    expect(Number.isFinite(seen.messages[0]!.at)).toBe(true)
    expect(seen.events).toEqual(['ready', 'ready', 'disconnected {"code":4009,"secret":"***"}'])
  })

  it('logs an SDK error as a warning with the secret scrubbed', async () => {
    const warn: string[] = []
    const transport = createSdkTransport({ appId: '1', appSecret: APP_SECRET, log: { debug: () => {}, warn: (m) => { warn.push(m) } } })
    await transport.run(handlersOf().handlers, new AbortController().signal)
    sdk.listeners.get('error')!(new Error(`boom ${APP_SECRET}`))
    expect(warn).toEqual(['sdk error: boom ***'])
  })

  it('scrubs the secret from a start failure and keeps the original as its cause', async () => {
    const cause = new Error(`login failed for ${APP_SECRET}`)
    sdk.start = () => Promise.reject(cause)
    const transport = createSdkTransport({ appId: '1', appSecret: APP_SECRET, log: { debug: () => {}, warn: () => {} } })
    const error = await transport.run(handlersOf().handlers, new AbortController().signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('login failed for ***')
    expect((error as Error).cause).toBe(cause)
  })

  it('names a start failure that is not an Error by its text', async () => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the subject is a rejection that is not an Error
    sdk.start = () => Promise.reject(`refused ${APP_SECRET}`)
    const transport = createSdkTransport({ appId: '1', appSecret: APP_SECRET, log: { debug: () => {}, warn: () => {} } })
    await expect(transport.run(handlersOf().handlers, new AbortController().signal)).rejects.toThrow('refused ***')
  })

  it('hands the abort signal to the client and reuses one client for run and send', async () => {
    let received: AbortSignal | undefined
    sdk.start = (signal) => { received = signal; return Promise.resolve() }
    const transport = createSdkTransport({ appId: '1', appSecret: APP_SECRET, log: { debug: () => {}, warn: () => {} } })
    const controller = new AbortController()
    await transport.run(handlersOf().handlers, controller.signal)
    expect(received).toBe(controller.signal)
    await transport.send({ scope: 'group', id: 'g', msgId: 'm' }, 'hello')
    await transport.send({ scope: 'c2c', id: 'u' }, 'again')
    expect(sdk.constructed).toHaveLength(1)
    expect(sdk.sent).toEqual([
      [{ scope: 'group', targetId: 'g', msgId: 'm' }, 'hello'],
      [{ scope: 'c2c', targetId: 'u' }, 'again'],
    ])
  })
})
