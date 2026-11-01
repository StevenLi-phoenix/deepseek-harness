import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { equalExceptVolatile } from '../../../../vendor/loader/src/config/diff.ts'
import { Config, QqObserver as Observer } from '../src/index.ts'
import { FakeOneBot } from './fake-onebot.ts'

const TOKEN = 'onebot-token-0123456789abcdef'
const GROUP = '123456789'
const MINUTE = 60_000

let dir: string
const contexts: Context[] = []
const servers: FakeOneBot[] = []

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fork-qq-restart-')) })
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(servers.splice(0).map(server => server.close()))
  rmSync(dir, { recursive: true, force: true })
})

async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const stateFile = () => join(dir, 'data', 'connection-state.json')
const seed = (state: Record<string, number>) => {
  mkdirSync(join(dir, 'data'), { recursive: true })
  writeFileSync(stateFile(), JSON.stringify(state))
}
const readState = () => JSON.parse(readFileSync(stateFile(), 'utf8')) as { lastAliveAt?: number; lastGroupListAt?: number }

/** Boot the observer, as a plugin restart would: the data directory may already hold what the last process left. */
async function boot(config: Record<string, unknown> = {}) {
  const fake = new FakeOneBot(TOKEN)
  servers.push(fake)
  await fake.listen()
  fake.handlers.set('get_login_info', () => ({ user_id: 99999, nickname: 'bot' }))
  fake.handlers.set('get_group_list', () => [{ group_id: Number(GROUP), group_name: '技术群', member_count: 80 }])
  fake.handlers.set('get_group_msg_history', () => ({ messages: [] }))
  const ctx = new Context()
  contexts.push(ctx)
  const logs: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (m) => { logs.push(String(m.args[0])) } })
  ctx.provide('credentials', { resolve: () => Promise.resolve({ value: TOKEN }) } as never)
  ctx.provide('sessionController', { create: vi.fn(), resolveAgent: vi.fn(), prompt: vi.fn(), selectModel: vi.fn() } as never)
  ctx.provide('permissionPresets', { resolve: vi.fn(), set: vi.fn() } as never)
  ctx.provide('sessionTitle', { rename: vi.fn(), get: vi.fn() } as never)
  await ctx.plugin(Observer, {
    url: fake.url, groups: [GROUP], dataDir: join(dir, 'data'), digest: { enabled: false, workspacePath: join(dir, 'digest') },
    login: { enabled: false }, backfill: { gapMs: 0 }, ...config,
  })
  await until(() => logs.some(line => line.includes('logged in as')), 'the connection')
  await new Promise(resolve => setTimeout(resolve, 150))
  return { ctx, observer: ctx.forkQq, fake, logs }
}

describe('a plugin restart does not repeat the connection work', () => {
  it('fetches the group list and the history on a first start, and remembers when', async () => {
    const before = Date.now()
    const h = await boot()
    expect(h.fake.callsOf('get_group_list')).toHaveLength(1)
    expect(h.fake.callsOf('get_group_msg_history')).toHaveLength(1)
    const state = readState()
    expect(state.lastAliveAt).toBeGreaterThanOrEqual(before)
    expect(state.lastGroupListAt).toBeGreaterThanOrEqual(before)
  })

  it('skips the group list and the backfill when the last process was connected under ten minutes ago', async () => {
    seed({ lastAliveAt: Date.now() - MINUTE, lastGroupListAt: Date.now() - 5 * MINUTE })
    const h = await boot()
    expect(h.fake.callsOf('get_login_info')).toHaveLength(1)
    expect(h.fake.callsOf('get_group_list')).toEqual([])
    expect(h.fake.callsOf('get_group_msg_history')).toEqual([])
    expect(h.logs.some(line => line.includes('was connected') && line.includes('not backfilling'))).toBe(true)
  })

  it('does both again once the last connection is older than reconnectQuietMs, and the list is older than an hour', async () => {
    seed({ lastAliveAt: Date.now() - 11 * MINUTE, lastGroupListAt: Date.now() - 2 * 60 * MINUTE })
    const h = await boot()
    expect(h.fake.callsOf('get_group_list')).toHaveLength(1)
    expect(h.fake.callsOf('get_group_msg_history')).toHaveLength(1)
  })

  it('never asks for the group list more than once an hour, even when the history is due', async () => {
    seed({ lastAliveAt: Date.now() - 11 * MINUTE, lastGroupListAt: Date.now() - 30 * MINUTE })
    const h = await boot()
    expect(h.fake.callsOf('get_group_list')).toEqual([])
    expect(h.fake.callsOf('get_group_msg_history')).toHaveLength(1)
  })

  it('moves the quiet window with the setting, and 0 turns it off', async () => {
    seed({ lastAliveAt: Date.now() - 20 * MINUTE, lastGroupListAt: Date.now() - 20 * MINUTE })
    const h = await boot({ reconnectQuietMs: 30 * MINUTE })
    expect(h.fake.callsOf('get_group_msg_history')).toEqual([])
    const off = await boot({ reconnectQuietMs: 0, dataDir: join(dir, 'other') })
    expect(off.fake.callsOf('get_group_msg_history')).toHaveLength(1)
  })

  it('notes when the connection ended, so a restart right after a drop counts the drop', async () => {
    const h = await boot()
    const before = Date.now()
    h.fake.drop()
    await until(() => h.logs.some(line => line.includes('connection closed')), 'the drop')
    await until(() => (readState().lastAliveAt ?? 0) >= before, 'the note')
  })
})

describe('a settings change does not restart the plugin, and so does not drop the connection, unless it concerns the connection', () => {
  const base = { url: 'ws://127.0.0.1:3001', groups: ['123456789'], digest: { workspacePath: '/tmp/x' } }
  const same = (next: Record<string, unknown>) => equalExceptVolatile(base, { ...base, ...next }, Config)

  it.each([
    ['backfill', { backfill: { enabled: false } }],
    ['media.images', { media: { images: false } }],
    ['voice.download', { voice: { download: false } }],
    ['asr.enabled', { asr: { enabled: true } }],
    ['retention.textDays', { retention: { textDays: 7 } }],
    ['honorRecall', { honorRecall: false }],
    ['offlineNoticeMs', { offlineNoticeMs: 0 }],
    ['settingsUrl', { settingsUrl: 'https://dsh.example.test/' }],
    ['reconnectQuietMs', { reconnectQuietMs: 0 }],
    ['groups', { groups: ['123456789', '987654321'] }],
  ])('keeps the plugin running when only %s changes', (_name, change) => {
    expect(same(change)).toBe(true)
  })

  it.each([
    ['url', { url: 'ws://127.0.0.1:3002' }],
    ['digest', { digest: { workspacePath: '/tmp/x', model: 'other' } }],
    ['send', { send: { enabled: true } }],
    ['login', { login: { enabled: false } }],
    ['dataDir', { dataDir: '/tmp/y' }],
  ])('restarts it when %s changes', (_name, change) => {
    expect(same(change)).toBe(false)
  })
})
