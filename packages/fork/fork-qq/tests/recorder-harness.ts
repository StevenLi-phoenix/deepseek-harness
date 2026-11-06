/** Shared setup of the recorder-side specs: a configuration, a fake protocol end, and a recorder over a temp directory. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { QqRecorder, type RecorderLogger } from '../src/recorder.ts'
import { RecorderConfigDto, type RecorderConfig } from '../src/protocol.ts'
import { FakeOneBot } from './fake-onebot.ts'

export const TOKEN = 'onebot-token-0123456789abcdef'

/** Plain-object deep merge for test overrides. */
export type Partialize<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends readonly unknown[] ? T[K] : Partialize<T[K]>) : T[K] }

let revision = 0

/**
 * A complete recorder configuration with test-friendly values (no backfill pause), overridden field by field.
 * @param url - the fake protocol end's address.
 * @param over - overrides, merged one level deep.
 */
export function recorderConfig(url: string, over: Partialize<RecorderConfig> = {}): RecorderConfig {
  revision += 1
  const base: RecorderConfig = {
    revision: `r${revision}`,
    url,
    tokenEnv: 'FORK_QQ_ONEBOT_TOKEN',
    groups: ['123456789'],
    media: { images: true, maxImageBytes: 15 * 1024 * 1024, maxTotalBytes: 5 * 1024 ** 3, retainDays: 30, hostSuffixes: ['.qq.com', '.qpic.cn', '.gtimg.cn', '.qlogo.cn', '.myqcloud.com', '.nt.qq.com.cn'], timeoutMs: 30_000 },
    voice: { download: true, maxBytes: 10 * 1024 * 1024 },
    retention: { textDays: 30 },
    honorRecall: true,
    backfill: { enabled: true, maxMessages: 20, maxGroups: 5, gapMs: 0, skipWithinMs: 30 * 60_000, minIntervalMs: 30 * 60_000 },
    reconnectQuietMs: 10 * 60_000,
    login: { enabled: false, url: 'http://127.0.0.1:3002', timeoutMs: 5000 },
  }
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(over)) {
    const current = merged[key]
    merged[key] = typeof value === 'object' && value !== null && !Array.isArray(value) && typeof current === 'object' && current !== null
      ? { ...current, ...value }
      : value
  }
  return RecorderConfigDto.parse(merged)
}

/** One log line of the recorder. */
export interface LogLine { type: 'debug' | 'info' | 'error'; text: string }

/** A recorder over a temp directory with its log collected. */
export interface Booted {
  recorder: QqRecorder
  fake: FakeOneBot
  logs: LogLine[]
  dir: string
  dataDir: string
  /** Push a configuration the way the server does; `over` is merged onto the base configuration. */
  apply(over?: Partialize<RecorderConfig>): ReturnType<QqRecorder['applyConfig']>
}

const open: Array<() => Promise<void>> = []
const leaks: LogLine[] = []

/** Stop everything started by {@link bootRecorder}; call from `afterEach`. */
export async function shutdown(): Promise<LogLine[]> {
  await Promise.all(open.splice(0).map(close => close()))
  return leaks.splice(0).filter(line => line.text.includes(TOKEN))
}

/**
 * Boot a recorder against a fake protocol end.
 * @param options - an existing fake, the secrets, an existing data directory, a first configuration, and whether to connect at once.
 */
export async function bootRecorder(options: {
  fake?: FakeOneBot
  secrets?: Record<string, string>
  dir?: string
  config?: Partialize<RecorderConfig> | false
  start?: boolean
  fetch?: typeof fetch
  oneBot?: { requestTimeoutMs?: number; idleTimeoutMs?: number }
} = {}): Promise<Booted> {
  const fake = options.fake ?? new FakeOneBot(TOKEN)
  if (options.fake === undefined) {
    await fake.listen()
    open.push(() => fake.close())
  }
  fake.handlers.set('get_login_info', () => ({ user_id: 99999, nickname: 'bot' }))
  if (!fake.handlers.has('get_group_list')) {
    fake.handlers.set('get_group_list', () => [
      { group_id: 123456789, group_name: '技术群', member_count: 80 },
      { group_id: 987654321, group_name: '闲聊群', member_count: 300 },
    ])
  }
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'fork-qq-recorder-'))
  if (options.dir === undefined) open.push(() => { rmSync(dir, { recursive: true, force: true }); return Promise.resolve() })
  const dataDir = join(dir, 'data')
  const logs: LogLine[] = []
  const log = (type: LogLine['type']) => (text: string): void => {
    const line = { type, text }
    logs.push(line)
    leaks.push(line)
  }
  const logger: RecorderLogger = { debug: log('debug'), info: log('info'), error: log('error') }
  const secrets = options.secrets ?? { FORK_QQ_ONEBOT_TOKEN: TOKEN }
  const recorder = new QqRecorder({
    dataDir, logger, secret: name => secrets[name],
    ...options.fetch === undefined ? {} : { fetch: options.fetch },
    ...options.oneBot === undefined ? {} : { oneBot: options.oneBot },
  })
  open.unshift(() => recorder.stop())
  const apply = (over: Partialize<RecorderConfig> = {}) => recorder.applyConfig(recorderConfig(fake.url, over))
  if (options.config !== false && options.start !== false) {
    recorder.start()
    apply(options.config ?? {})
  } else if (options.start !== false) {
    recorder.start()
  }
  return { recorder, fake, logs, dir, dataDir, apply }
}

/** Wait until `check` holds. */
export async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Wait for the recorder to be connected and finished with its first group list and backfill. */
export async function connected(h: Booted): Promise<void> {
  await until(() => h.logs.some(line => line.text.includes('logged in as')), 'the connection')
  await new Promise(resolve => setTimeout(resolve, 150))
}

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
export { vi }
