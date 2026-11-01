/**
 * The Settings route `/api/lsy.wechat`: the channel's binding and health for the Settings page, and
 * the three things the owner can do there without a shell on the Host: bind by QR code (the flow of
 * `runLoginCli`, see {@link LoginSessions}), answer WeChat's verification number, and unbind. The
 * route sits under `/api`, so the connection's sign-in check guards it. Nothing it answers or logs
 * carries a bot token, a message text, or a QR payload; ids are masked.
 */
import { access, rename } from 'node:fs/promises'
import z from '@deepseek-ai/schemastery'
import { LoginSessions, type LoginTransport } from './login-session.ts'
import { readAccountFile, type WechatAccount } from './login.ts'
import {
  maskId, VERIFY_CODE_PATTERN, WECHAT_PATH,
  type BindingView, type ChannelStatus, type LoginSnapshot, type WechatAction, type WechatAnswer, type WechatView,
} from './view.ts'

/** The slice of the connection service the route uses. */
export interface SettingsConnection {
  readonly fetch: {
    register(route: SettingsRoute): () => Promise<void>
  }
}

/** One route registration. */
export interface SettingsRoute {
  readonly path: string
  readonly methods: readonly ('GET' | 'POST')[]
  readonly requestBody: 'buffered'
  readonly fetch: (request: Request) => Promise<Response>
}

/** What the route needs of the channel. */
export interface SettingsChannel {
  /** Health, window, and outbox; see `WechatChannel.status`. */
  status(): ChannelStatus
  /** Read the account file again now. */
  reloadAccount(reason: string): void
}

/** Settings options. */
export interface WechatSettingsOptions {
  /** The account file the channel reads. */
  accountFile: string
  /** IANA zone the page shows times in. */
  timeZone: string
  channel: SettingsChannel
  logger: { info(message: string): void; warn(message: string): void }
  /** Login transport overrides, for tests. */
  login?: LoginTransport
  /** Overall deadline of one login in milliseconds, for tests. */
  loginTimeoutMs?: number
  /** Clock, replaceable in tests. */
  now?: () => number
}

/** Request bodies; a field outside this schema is ignored. */
const actionSchema = z.union([
  z.object({ action: z.const('login.start').required() }),
  z.object({ action: z.const('login.poll').required(), key: z.string().required() }),
  z.object({ action: z.const('login.code').required(), key: z.string().required(), code: z.string().required() }),
  z.object({ action: z.const('login.cancel').required(), key: z.string().required() }),
  z.object({ action: z.const('unbind').required(), confirm: z.const('unbind').required() }),
])

const HEADERS = { 'cache-control': 'no-store' }

/** A JSON error answer; its text never repeats request data. */
function failure(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: HEADERS })
}

/** `YYYYMMDDHHMMSS` of an instant in UTC, for backup file names. */
function stamp(ms: number): string {
  return new Date(ms).toISOString().replaceAll(/[-:T]/gu, '').slice(0, 14)
}

/** Whether a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    // access() rejects for a missing path; any other reason also means there is nothing to overwrite safely.
    return false
  }
}

/**
 * The route's logic, kept apart from the channel so it can be tested with a fake one.
 */
export class WechatSettings {
  private readonly logins: LoginSessions
  private readonly now: () => number

  /** @param options - account file, channel, logger, and test overrides. */
  constructor(private readonly options: WechatSettingsOptions) {
    this.now = options.now ?? Date.now
    this.logins = new LoginSessions({
      accountFile: options.accountFile,
      logger: options.logger,
      onBound: (account: WechatAccount) => { options.channel.reloadAccount(`bound bot ${account.botId}`) },
      ...options.login === undefined ? {} : { login: options.login },
      ...options.loginTimeoutMs === undefined ? {} : { timeoutMs: options.loginTimeoutMs },
      now: this.now,
    })
  }

  /**
   * The route for the connection service.
   * @returns the registration.
   */
  route(): SettingsRoute {
    return { path: WECHAT_PATH, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: request => this.handle(request) }
  }

  /** End the open login while the channel stops. */
  dispose(): void {
    this.logins.dispose()
  }

  /**
   * Read the account file.
   * @returns the binding, with ids masked.
   */
  binding(): BindingView {
    const read = readAccountFile(this.options.accountFile)
    if (read.kind === 'missing') return { state: 'unbound' }
    if (read.kind === 'invalid') return { state: 'invalid', reason: read.reason }
    const boundAt = Date.parse(read.account.boundAt)
    return { state: 'bound', botId: maskId(read.account.botId), ownerId: maskId(read.account.ownerUserId), boundAt: Number.isNaN(boundAt) ? null : boundAt }
  }

  /**
   * Compose the answer of a read.
   * @returns the binding, the channel's status, and whether a login is open.
   */
  view(): WechatView {
    return { binding: this.binding(), ...this.options.channel.status(), loginActive: this.logins.active, timeZone: this.options.timeZone }
  }

  private answer(login: LoginSnapshot | null = null): Response {
    const body: WechatAnswer = { view: this.view(), login }
    return Response.json(body, { headers: HEADERS })
  }

  /** One request: a read, or one validated action; each action is logged with its outcome and duration. */
  private async handle(request: Request): Promise<Response> {
    if (request.method !== 'POST') return this.answer()
    if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return failure(415, 'expected application/json')
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return failure(400, 'body is not JSON')
    }
    let action: WechatAction
    try {
      action = actionSchema(body as never)
    } catch {
      // The validation message quotes the body, which may hold a verification number.
      return failure(400, 'unknown action or missing field')
    }
    const startedAt = this.now()
    const response = await this.perform(action)
    const outcome = response.status < 300 ? 'ok' : `refused (${response.status})`
    if (action.action !== 'login.poll') {
      // Polls are frequent and their phases are logged by the login itself.
      this.options.logger.info(`lsy-wechat: settings ${action.action} ${outcome} (${this.now() - startedAt} ms)`)
    }
    return response
  }

  private async perform(action: WechatAction): Promise<Response> {
    switch (action.action) {
      case 'login.start':
        return this.answer(await this.logins.start())
      case 'login.poll': {
        const login = this.logins.poll(action.key)
        return login === undefined ? failure(404, 'that login is gone') : this.answer(login)
      }
      case 'login.code': {
        const code = action.code.trim()
        if (!VERIFY_CODE_PATTERN.test(code)) return failure(400, 'the number is digits only')
        const login = this.logins.code(action.key, code)
        if (login === undefined) return failure(404, 'that login is gone')
        if (login === 'not-waiting') return failure(409, 'the login is not asking for a number')
        return this.answer(login)
      }
      case 'login.cancel':
        return this.logins.cancel(action.key) ? this.answer(this.logins.poll(action.key) ?? null) : failure(404, 'that login is gone or already over')
      case 'unbind':
        return this.unbind()
      default:
        return failure(400, 'unknown action')
    }
  }

  /**
   * Move the account file aside to `account.json.bak.<timestamp>` (kept, never deleted) and have the
   * channel read the file again, so it goes idle and queues what it cannot send.
   */
  private async unbind(): Promise<Response> {
    const path = this.options.accountFile
    if (readAccountFile(path).kind === 'missing') return failure(409, 'no bot is bound')
    this.logins.end('the account is being unbound')
    const base = `${path}.bak.${stamp(this.now())}`
    let backup = base
    for (let n = 1; await exists(backup); n += 1) backup = `${base}-${n}`
    try {
      await rename(path, backup)
    } catch (error: unknown) {
      this.options.logger.warn(`lsy-wechat: settings unbind failed to move the account file (${(error as NodeJS.ErrnoException).code ?? 'error'})`)
      return failure(500, 'the account file could not be moved')
    }
    this.options.logger.info(`lsy-wechat: settings unbind moved the account file to ${backup}`)
    this.options.channel.reloadAccount('unbound from Settings')
    return this.answer()
  }
}
