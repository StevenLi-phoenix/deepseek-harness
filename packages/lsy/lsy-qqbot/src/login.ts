/**
 * QR login against the QQ Open Platform's bind service: the owner scans a code with the phone's QQ and the
 * platform hands this process the bot's AppID and AppSecret, encrypted with a key only this process holds,
 * together with the openid the scanner has for that bot. The terminal command writes both credentials into
 * `<DSH_HOME>/.env` and prints the AppID and the openid, never the AppSecret.
 */
import { createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { encode, renderUnicodeCompact } from 'uqr'

/** Origin of the Open Platform's bind service. */
export const QQ_BIND_ORIGIN = 'https://q.qq.com'

/** Status codes of `poll_bind_result`. */
const STATUS_COMPLETED = 2
const STATUS_EXPIRED = 3

/** A bind task the platform opened, and the key its answer is encrypted with. */
export interface BindTask {
  taskId: string
  /** Base64 of 32 random bytes; never leaves this process. */
  key: string
}

/** What a finished login yields. */
export interface QqLogin {
  appId: string
  /** Never logged or printed. */
  appSecret: string
  /** The scanner's openid for this bot, when the platform sent one: the first entry for `allow.users`. */
  userOpenid?: string | undefined
}

/** A login that did not finish; the message never contains the AppSecret. */
export class LoginError extends Error {}

/** Human-readable error text. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The `fetch` the login uses, replaceable in tests. */
type Fetch = typeof fetch

/** POST a JSON body and return the platform's `data`, or throw with its message. */
async function post(
  fetchImpl: Fetch, origin: string, path: string, body: unknown, signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify(body),
    signal: signal === undefined ? AbortSignal.timeout(10_000) : AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${path}`)
  const payload = await response.json() as { retcode?: unknown; msg?: unknown; data?: Record<string, unknown> }
  if (payload.retcode !== 0) throw new Error(typeof payload.msg === 'string' && payload.msg !== '' ? payload.msg : `${path} failed`)
  return payload.data ?? {}
}

/**
 * Open a bind task.
 * @returns the task id and the key to decrypt its answer with.
 * @throws when the platform refuses or cannot be reached.
 */
export async function createBindTask(fetchImpl: Fetch = fetch, origin = QQ_BIND_ORIGIN, signal?: AbortSignal): Promise<BindTask> {
  const key = randomBytes(32).toString('base64')
  const data = await post(fetchImpl, origin, '/lite/create_bind_task', { key }, signal)
  if (typeof data['task_id'] !== 'string' || data['task_id'] === '') throw new Error('create_bind_task: no task_id in the answer')
  return { taskId: data['task_id'], key }
}

/** One poll of a bind task. */
export type BindPoll =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'completed'; appId: string; encryptedSecret: string; userOpenid?: string | undefined }

/** Ask the platform whether a bind task was scanned. */
export async function pollBindResult(
  taskId: string, fetchImpl: Fetch = fetch, origin = QQ_BIND_ORIGIN, signal?: AbortSignal,
): Promise<BindPoll> {
  const data = await post(fetchImpl, origin, '/lite/poll_bind_result', { task_id: taskId }, signal)
  if (data['status'] === STATUS_EXPIRED) return { status: 'expired' }
  if (data['status'] !== STATUS_COMPLETED) return { status: 'pending' }
  const appId = String(data['bot_appid'] ?? '')
  const encryptedSecret = typeof data['bot_encrypt_secret'] === 'string' ? data['bot_encrypt_secret'] : ''
  if (appId === '' || appId === '0' || encryptedSecret === '') throw new Error('poll_bind_result: completed without credentials')
  const openid = data['user_openid']
  return { status: 'completed', appId, encryptedSecret, ...typeof openid === 'string' && openid !== '' ? { userOpenid: openid } : {} }
}

/**
 * Decrypt the AppSecret: AES-256-GCM, the blob being a 12-byte nonce, the ciphertext, and a 16-byte tag, in base64.
 * @throws when the blob does not authenticate under the key.
 */
export function decryptSecret(blob: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64')
  const raw = Buffer.from(blob, 'base64')
  if (raw.length < 12 + 16 + 1) throw new Error('the encrypted secret is too short')
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(raw.length - 16))
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8')
}

/** The page the phone opens for a task. */
export function connectUrl(taskId: string, origin = QQ_BIND_ORIGIN): string {
  return `${origin}/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(taskId)}&source=dsh-lsy&_wv=2`
}

/** {@link loginWithQr} options. */
export interface LoginOptions {
  fetch?: Fetch
  origin?: string
  /** Called with the URL to show as a QR code, for the first code and for each refresh. */
  showQrCode(url: string, attempt: number): void | Promise<void>
  onProgress?(message: string): void
  /** QR codes tried before giving up; one expires after a few minutes. */
  maxQrCodes?: number
  /** Whole login deadline in milliseconds. */
  timeoutMs?: number
  pollDelayMs?: number
  /** Consecutive failed polls before giving up. */
  maxFailures?: number
  signal?: AbortSignal | undefined
}

/** Resolve after `ms`, or reject when `signal` aborts. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = (): void => { clearTimeout(timer); reject(signal?.reason as Error) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Show a QR code, wait for the scan, and return the bot's credentials. An expired code is replaced by a new one.
 * @throws {@link LoginError} on timeout, on too many expiries or failed polls, or when the secret does not decrypt.
 */
export async function loginWithQr(options: LoginOptions): Promise<QqLogin> {
  const fetchImpl = options.fetch ?? fetch
  const origin = options.origin ?? QQ_BIND_ORIGIN
  const signal = options.signal
  const maxQrCodes = options.maxQrCodes ?? 3
  const pollDelayMs = options.pollDelayMs ?? 2000
  const maxFailures = options.maxFailures ?? 10
  const deadline = Date.now() + (options.timeoutMs ?? 600_000)
  const progress = (message: string): void => { options.onProgress?.(message) }

  let attempt = 1
  let task: BindTask
  try {
    task = await createBindTask(fetchImpl, origin, signal)
  } catch (error: unknown) {
    throw new LoginError(`could not open a bind task: ${errorText(error)}`)
  }
  await options.showQrCode(connectUrl(task.taskId, origin), attempt)
  let failures = 0
  while (Date.now() < deadline) {
    let poll: BindPoll
    try {
      poll = await pollBindResult(task.taskId, fetchImpl, origin, signal)
      failures = 0
    } catch (error: unknown) {
      signal?.throwIfAborted()
      failures += 1
      if (failures >= maxFailures) throw new LoginError(`checking the QR code failed ${failures} times in a row: ${errorText(error)}`)
      await delay(pollDelayMs, signal)
      continue
    }
    if (poll.status === 'completed') {
      let appSecret: string
      try {
        appSecret = decryptSecret(poll.encryptedSecret, task.key)
      } catch {
        throw new LoginError('the platform answered, but the AppSecret did not decrypt with this login\'s key')
      }
      return { appId: poll.appId, appSecret, userOpenid: poll.userOpenid }
    }
    if (poll.status === 'expired') {
      if (attempt >= maxQrCodes) throw new LoginError(`the QR code expired ${attempt} times; run the login again`)
      attempt += 1
      try {
        task = await createBindTask(fetchImpl, origin, signal)
      } catch (error: unknown) {
        throw new LoginError(`could not open a new bind task: ${errorText(error)}`)
      }
      progress('二维码已过期，已刷新。')
      await options.showQrCode(connectUrl(task.taskId, origin), attempt)
    }
    await delay(pollDelayMs, signal)
  }
  throw new LoginError('timed out waiting for the QR code to be scanned')
}

/**
 * Render text as a QR code PNG (black on white, 8-bit grayscale).
 * @param scale - pixels per module.
 * @param margin - quiet zone in modules.
 */
export function qrPng(text: string, scale = 8, margin = 4): Buffer {
  const modules = encode(text, { ecc: 'M', border: 0 }).data
  const size = modules.length
  const side = (size + margin * 2) * scale
  const rows = Buffer.alloc((side + 1) * side, 0xff)
  for (let y = 0; y < side; y += 1) {
    const rowStart = y * (side + 1)
    rows[rowStart] = 0
    const my = Math.floor(y / scale) - margin
    if (my < 0 || my >= size) continue
    for (let x = 0; x < side; x += 1) {
      const mx = Math.floor(x / scale) - margin
      if (mx >= 0 && mx < size && modules[my]?.[mx] === true) rows[rowStart + 1 + x] = 0
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(side, 0)
  header.writeUInt32BE(side, 4)
  header[8] = 8 // bit depth
  header[9] = 0 // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Set `name=value` lines in a dotenv file, replacing existing ones and keeping every other line, by writing a
 * sibling file with mode 0600 and renaming it over the original.
 * @returns the names written, never the values.
 */
export async function upsertEnvFile(path: string, entries: Record<string, string>): Promise<string[]> {
  let existing = ''
  try {
    existing = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const names = Object.keys(entries)
  const kept = existing.split('\n').filter(line => line !== '' && !names.some(name => line.startsWith(`${name}=`)))
  const lines = [...names.map(name => `${name}=${entries[name]}`), ...kept]
  const temporary = `${path}.new`
  await writeFile(temporary, `${lines.join('\n')}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
  return names
}

/** Minimal writable used for terminal output. */
export interface TextSink {
  write(chunk: string): unknown
}

/** {@link runLoginCli} options; every field defaults to the real process. */
export interface LoginCliOptions {
  stdout?: TextSink
  stderr?: TextSink
  /** Command-line arguments after the script name. */
  argv?: string[]
  /** Environment holding `DSH_HOME`. */
  env?: Record<string, string | undefined>
  /** Login options passed through: transport, origin, and pacing. */
  login?: Pick<LoginOptions, 'fetch' | 'origin' | 'pollDelayMs' | 'timeoutMs' | 'maxFailures' | 'maxQrCodes' | 'signal'>
}

/** Names of the credentials the channel reads. */
const APP_ID_VARIABLE = 'LSY_QQBOT_APP_ID'
const APP_SECRET_VARIABLE = 'LSY_QQBOT_APP_SECRET'

/** The value following a flag, or undefined. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag)
  return at >= 0 ? argv[at + 1] : undefined
}

/**
 * Terminal login: render the QR code (and, with `--qr-png <file>`, save it as a PNG, mode 0600, rewritten on each
 * refresh), wait for the scan, and write `LSY_QQBOT_APP_ID` and `LSY_QQBOT_APP_SECRET` into `<DSH_HOME>/.env` (or
 * `--env-file <file>`). Prints the AppID and the scanner's openid, never the AppSecret.
 * @returns process exit code: 0 when the credentials were saved, 1 otherwise.
 */
export async function runLoginCli(options: LoginCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const argv = options.argv ?? process.argv.slice(2)
  const envFile = flagValue(argv, '--env-file') ?? join(resolveDshHome(undefined, options.env ?? process.env), '.env')
  const pngFile = flagValue(argv, '--qr-png')
  const minutes = Number(flagValue(argv, '--timeout-min') ?? '')
  try {
    stdout.write('QQ 机器人登录（QQ 开放平台）\n')
    const result = await loginWithQr({
      ...options.login,
      ...Number.isFinite(minutes) && minutes > 0 ? { timeoutMs: minutes * 60_000 } : {},
      showQrCode: async (url, attempt) => {
        if (pngFile !== undefined) {
          await writeFile(pngFile, qrPng(url), { mode: 0o600 })
          await chmod(pngFile, 0o600)
          stdout.write(`二维码图片已保存到 ${pngFile}\n`)
        }
        stdout.write(`\n用手机 QQ 扫描下面的二维码${attempt > 1 ? `（第 ${attempt} 张）` : ''}：\n\n`)
        stdout.write(`${renderUnicodeCompact(url)}\n`)
        stdout.write(`二维码显示不全时，用手机 QQ 打开这个链接：\n${url}\n`)
      },
      onProgress: (message) => { stdout.write(`${message}\n`) },
    })
    await upsertEnvFile(envFile, { [APP_ID_VARIABLE]: result.appId, [APP_SECRET_VARIABLE]: result.appSecret })
    stdout.write(`\n已绑定机器人，AppID ${result.appId}。\nAppID 和 AppSecret 已写入 ${envFile}（仅本用户可读，AppSecret 不显示）；重启服务后生效。\n`)
    if (result.userOpenid !== undefined) {
      stdout.write(`扫码用户在这个机器人上的 openid：${result.userOpenid}\n要让这个 QQ 号能和 agent 聊天，把它加进 profile patch：\n- id: lsy-qqbot\n  config:\n    allow:\n      users: ['${result.userOpenid}']\n      groups: []\n`)
    }
    return 0
  } catch (error: unknown) {
    stderr.write(`\nQQ 登录失败：${errorText(error)}\n`)
    return 1
  }
}
