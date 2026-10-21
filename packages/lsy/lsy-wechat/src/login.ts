/** QR login against iLink, the terminal login command, and the account file the channel reads. */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { renderUnicodeCompact } from 'uqr'
import { z } from 'zod'
import { ILINK_BASE_URL, IlinkClient, type BotQrcode, type QrStatus } from './api.ts'

/** Credentials of one bound bot; the file holding them is readable by its owner only. */
export interface WechatAccount {
  /** Bearer token of the bot; never logged or printed. */
  botToken: string
  /** `ilink_bot_id`. */
  botId: string
  /** API origin the login assigned to this bot. */
  baseUrl: string
  /** WeChat user who scanned the QR code; the only user the channel talks to. */
  ownerUserId: string
  /** ISO 8601 time of the login. */
  boundAt: string
}

const accountSchema = z.object({
  botToken: z.string().min(1),
  botId: z.string().min(1),
  baseUrl: z.url(),
  ownerUserId: z.string().min(1),
  boundAt: z.string(),
})

/** Result of reading the account file. */
export type AccountRead =
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'ok'; account: WechatAccount }

/**
 * Default account file: `<DSH_HOME>/lsy-wechat/account.json`.
 * @param env - environment holding `DSH_HOME`; defaults to `process.env`.
 * @returns absolute path.
 */
export function accountFilePath(env: Record<string, string | undefined> = process.env): string {
  return join(resolveDshHome(undefined, env), 'lsy-wechat', 'account.json')
}

/**
 * Read the account file. Synchronous: the file is a few hundred bytes and
 * the channel re-reads it between long-polls.
 * @param path - account file.
 * @returns the account, `missing`, or `invalid` with a reason that never quotes file content.
 */
export function readAccountFile(path: string): AccountRead {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'invalid', reason: `cannot read (${String(code)})` }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // JSON.parse messages quote the input, which holds the token.
    return { kind: 'invalid', reason: 'not valid JSON' }
  }
  const parsed = accountSchema.safeParse(value)
  if (!parsed.success) {
    return { kind: 'invalid', reason: `bad fields: ${parsed.error.issues.map(issue => issue.path.join('.') || '(root)').join(', ')}` }
  }
  return { kind: 'ok', account: parsed.data }
}

/**
 * Write the account atomically (temporary file + rename) with mode 0600 inside a 0700 directory.
 * @param path - account file.
 * @param account - credentials to store.
 */
export async function writeAccountFile(path: string, account: WechatAccount): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(account, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temp, path)
  } catch (error: unknown) {
    await rm(temp, { force: true })
    throw error
  }
}

/** Login ended without credentials; the message is meant for the person at the terminal. */
export class LoginError extends Error {
  /** @param message - what happened and what to do next. */
  constructor(message: string) {
    super(message)
    this.name = 'LoginError'
  }
}

/** Credentials a confirmed login returns. */
export type LoginResult = Omit<WechatAccount, 'boundAt'>

/** {@link loginWithQr} options. */
export interface LoginOptions {
  /** Show one QR code; `attempt` counts from 1 up to `maxQrCodes`. */
  showQrCode(url: string, attempt: number): void
  /** Ask for the number WeChat shows; `retry` is true after a wrong number. */
  readVerifyCode(retry: boolean): Promise<string>
  /** Progress for the person scanning: scanned, redirected, refreshed. */
  onProgress?(message: string): void
  /** `fetch` replacement. */
  fetch?: typeof fetch
  /** Login API origin; defaults to {@link ILINK_BASE_URL}. */
  baseUrl?: string
  /** Cancels the login. */
  signal?: AbortSignal
  /** QR codes shown before giving up on expiry; default 3. */
  maxQrCodes?: number
  /** Overall deadline in milliseconds; default 8 minutes. */
  timeoutMs?: number
  /** Pause between status polls in milliseconds; default 1000. */
  pollDelayMs?: number
  /** Client deadline of one status long-poll; default 35000. */
  statusTimeoutMs?: number
  /** Consecutive failed status polls before giving up; default 5. */
  maxFailures?: number
}

/** Hostname with an optional port; anything else in `redirect_host` is ignored. */
const HOST = /^[A-Za-z0-9.-]+(?::\d+)?$/

/** Wait `ms`; an abort ends the wait early and throws the abort reason. */
async function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
  signal?.throwIfAborted()
}

/** Human-readable error text. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Credentials of a confirmed status, or a LoginError when the server left some out. */
function confirmedResult(status: QrStatus, fallbackBaseUrl: string): LoginResult {
  if (status.botToken === undefined || status.botId === undefined || status.ownerUserId === undefined) {
    throw new LoginError('login was confirmed but the server returned no bot credentials; run the login again')
  }
  const baseUrl = status.baseUrl === undefined
    ? fallbackBaseUrl
    : status.baseUrl.includes('://') ? status.baseUrl : `https://${status.baseUrl}`
  return { botToken: status.botToken, botId: status.botId, baseUrl, ownerUserId: status.ownerUserId }
}

/**
 * Bind a bot by QR code: show the code, follow the status long-poll through
 * scanning, host redirects, verification numbers, and expiry, and return the
 * credentials once the owner confirms in WeChat.
 * @param options - QR display, verification input, transport, and limits.
 * @returns the bot credentials.
 * @throws {LoginError} on expiry, blocked verification, an existing binding, a timeout, or repeated poll failures.
 */
export async function loginWithQr(options: LoginOptions): Promise<LoginResult> {
  const baseUrl = options.baseUrl ?? ILINK_BASE_URL
  const signal = options.signal
  const maxQrCodes = options.maxQrCodes ?? 3
  const pollDelayMs = options.pollDelayMs ?? 1000
  const statusTimeoutMs = options.statusTimeoutMs ?? 35_000
  const maxFailures = options.maxFailures ?? 5
  const progress = (message: string): void => { options.onProgress?.(message) }
  const transport = options.fetch === undefined ? {} : { fetch: options.fetch }
  const root = new IlinkClient({ baseUrl, ...transport })
  const deadline = Date.now() + (options.timeoutMs ?? 480_000)

  let qr: BotQrcode = await root.getBotQrcode(signal)
  let attempt = 1
  options.showQrCode(qr.url, attempt)
  let poller = root
  let verifyCode: string | undefined
  let scanned = false
  let failures = 0
  while (Date.now() < deadline) {
    let status: QrStatus
    try {
      status = await poller.getQrcodeStatus(qr.qrcode, verifyCode, statusTimeoutMs, signal)
      failures = 0
    } catch (error: unknown) {
      signal?.throwIfAborted()
      failures += 1
      if (failures >= maxFailures) throw new LoginError(`checking the QR code failed ${failures} times in a row: ${errorText(error)}`)
      await delay(pollDelayMs, signal)
      continue
    }
    switch (status.status) {
      case 'confirmed':
        return confirmedResult(status, baseUrl)
      case 'scaned':
        verifyCode = undefined
        if (!scanned) progress('已扫码，请在手机微信上确认。')
        scanned = true
        break
      case 'scaned_but_redirect':
        if (status.redirectHost !== undefined && HOST.test(status.redirectHost)) {
          poller = new IlinkClient({ baseUrl: `https://${status.redirectHost}`, ...transport })
          progress(`已扫码，切换到 ${status.redirectHost} 继续确认。`)
        }
        break
      case 'need_verifycode':
        verifyCode = (await options.readVerifyCode(verifyCode !== undefined)).trim()
        continue
      case 'expired':
      case 'verify_code_blocked': {
        verifyCode = undefined
        if (attempt >= maxQrCodes) {
          throw new LoginError(status.status === 'expired'
            ? `the QR code expired ${attempt} times; run the login again`
            : 'too many wrong verification numbers; wait a while and run the login again')
        }
        attempt += 1
        qr = await root.getBotQrcode(signal)
        poller = root
        scanned = false
        progress(status.status === 'expired' ? '二维码已过期，已刷新。' : '验证数字错误次数过多，已换新二维码。')
        options.showQrCode(qr.url, attempt)
        break
      }
      case 'binded_redirect':
        throw new LoginError('this WeChat account already has the bot bound to another client; remove that binding in WeChat and run the login again')
      default:
        // `wait` and statuses this client does not know keep polling.
        break
    }
    await delay(pollDelayMs, signal)
  }
  throw new LoginError('timed out waiting for the QR code to be scanned and confirmed')
}

/** Minimal writable used for terminal output. */
export interface TextSink {
  write(chunk: string): unknown
}

/** {@link runLoginCli} options; every field defaults to the real process. */
export interface LoginCliOptions {
  stdout?: TextSink
  stderr?: TextSink
  stdin?: NodeJS.ReadableStream
  /** Environment holding `DSH_HOME`. */
  env?: Record<string, string | undefined>
  /** Account file; defaults to {@link accountFilePath}. */
  accountFile?: string
  /** Login options passed through: transport, origin, and pacing. */
  login?: Pick<LoginOptions, 'fetch' | 'baseUrl' | 'pollDelayMs' | 'timeoutMs' | 'statusTimeoutMs' | 'maxFailures' | 'signal'>
}

/** Lines typed on stdin; the reader attaches only when a line is first needed. */
class LineReader {
  private lines: AsyncIterator<string> | undefined
  private reader: Interface | undefined

  /** @param input - stream to read lines from. */
  constructor(private readonly input: NodeJS.ReadableStream) {}

  /** Next line, or a LoginError once input ends. */
  async next(): Promise<string> {
    if (this.lines === undefined) {
      this.reader = createInterface({ input: this.input, terminal: false })
      this.lines = this.reader[Symbol.asyncIterator]()
    }
    const line = await this.lines.next()
    if (line.done === true) throw new LoginError('input ended before the verification number was entered')
    return line.value
  }

  /** Release stdin so the process can exit. */
  close(): void {
    this.reader?.close()
  }
}

/**
 * Terminal login: render the QR code, ask for the verification number when
 * WeChat shows one, and save the account file. Prints the bot id and owner id,
 * never the token.
 * @param options - streams, environment, and login overrides for tests.
 * @returns process exit code: 0 when the account was saved, 1 otherwise.
 */
export async function runLoginCli(options: LoginCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const path = options.accountFile ?? accountFilePath(options.env)
  const lines = new LineReader(options.stdin ?? process.stdin)
  try {
    stdout.write('微信 bot 登录（iLink）\n')
    const result = await loginWithQr({
      ...options.login,
      showQrCode: (url, attempt) => {
        stdout.write(`\n用手机微信扫描下面的二维码${attempt > 1 ? `（第 ${attempt} 张）` : ''}：\n\n`)
        stdout.write(`${renderUnicodeCompact(url)}\n`)
        stdout.write(`二维码显示不全时，用微信打开这个链接：\n${url}\n`)
      },
      readVerifyCode: async (retry) => {
        stdout.write(retry ? '数字不匹配，请重新输入手机微信上显示的数字：' : '输入手机微信上显示的数字：')
        return lines.next()
      },
      onProgress: (message) => { stdout.write(`${message}\n`) },
    })
    await writeAccountFile(path, { ...result, boundAt: new Date().toISOString() })
    stdout.write(`\n已绑定 bot ${result.botId}，owner ${result.ownerUserId}。\n账号已保存到 ${path}（仅本用户可读）。\n运行中的服务会在下一次检查时自动读取。\n`)
    return 0
  } catch (error: unknown) {
    stderr.write(`\n微信登录失败：${errorText(error)}\n`)
    return 1
  } finally {
    lines.close()
  }
}
