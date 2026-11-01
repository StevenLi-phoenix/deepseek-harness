import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, QqObserver as Observer } from '../src/index.ts'
import { FakeOneBot, groupMessage } from './fake-onebot.ts'

const TOKEN = 'onebot-token-0123456789abcdef'
const GROUPS = ['111111', '222222', '333333']

let dir: string
const contexts: Context[] = []
const servers: FakeOneBot[] = []

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fork-qq-backfill-')) })
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(servers.splice(0).map(server => server.close()))
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Boot an observer over a fake protocol end that answers every history request with `history`. */
async function boot(backfill: Record<string, unknown>, history: (params: Record<string, unknown>) => unknown = () => ({ messages: [] })) {
  const fake = new FakeOneBot(TOKEN)
  servers.push(fake)
  await fake.listen()
  const calls: Array<{ at: number; group: number; count: unknown }> = []
  fake.handlers.set('get_login_info', () => ({ user_id: 99999, nickname: 'bot' }))
  fake.handlers.set('get_group_list', () => GROUPS.map(id => ({ group_id: Number(id), group_name: `群${id}`, member_count: 10 })))
  fake.handlers.set('get_group_msg_history', (params) => {
    calls.push({ at: Date.now(), group: Number(params['group_id']), count: params['count'] })
    return history(params)
  })
  const ctx = new Context()
  contexts.push(ctx)
  const logs: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (m) => { logs.push(String(m.args[0])) } })
  ctx.provide('credentials', { resolve: () => Promise.resolve({ value: TOKEN }) } as never)
  ctx.provide('sessionController', { create: vi.fn(), resolveAgent: vi.fn(), prompt: vi.fn(), selectModel: vi.fn() } as never)
  ctx.provide('permissionPresets', { resolve: vi.fn(), set: vi.fn() } as never)
  ctx.provide('sessionTitle', { rename: vi.fn(), get: vi.fn() } as never)
  await ctx.plugin(Observer, {
    url: fake.url, groups: GROUPS, dataDir: join(dir, 'data'), digest: { enabled: false, workspacePath: join(dir, 'digest') },
    login: { enabled: false }, backfill: { gapMs: 0, ...backfill },
  })
  return { ctx, observer: ctx.forkQq, fake, calls, logs }
}

const groupsCalled = (calls: Array<{ group: number }>) => calls.map(call => String(call.group))

/** Drop the connection and let the observer believe `ms` passed before it reconnects. */
async function dropAndWait(h: Awaited<ReturnType<typeof boot>>, ms: number): Promise<void> {
  const connections = h.fake.connections
  h.fake.drop()
  await until(() => h.logs.some(line => line.includes('connection closed')), 'the drop')
  await new Promise(resolve => setTimeout(resolve, 100))
  h.observer.now = () => Date.now() + ms
  await until(() => h.fake.connections === connections + 1, 'the reconnect', 6000)
}

describe('backfill is gentle by default', () => {
  it('asks for one small page per group, a few groups per connection, with a pause between them', () => {
    const config = Config({ dataDir: join(dir, 'x'), digest: { workspacePath: join(dir, 'd') } })
    expect(config.backfill).toEqual({ enabled: true, maxMessages: 20, maxGroups: 5, gapMs: 5000, skipWithinMs: 30 * 60_000 })
  })

  it('requests no more messages than maxMessages in one page', async () => {
    const h = await boot({ maxMessages: 20 })
    await until(() => h.calls.length >= 3, 'the backfill')
    expect(h.calls.every(call => call.count === 20)).toBe(true)
    const small = await boot({ maxMessages: 7 })
    await until(() => small.calls.length >= 3, 'the second backfill')
    expect(small.calls.every(call => call.count === 7)).toBe(true)
  })

  it('pauses between two groups, with jitter on top', async () => {
    const h = await boot({ gapMs: 200 })
    await until(() => h.calls.length === 3, 'three groups', 8000)
    const gaps = h.calls.slice(1).map((call, index) => call.at - h.calls[index]!.at)
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(190)
    expect(Math.max(...gaps)).toBeLessThan(900)
  })

  it('catches up at most maxGroups groups per connection and continues with the others on the next one', async () => {
    const h = await boot({ maxGroups: 2 })
    await until(() => h.calls.length === 2, 'the first turn')
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(groupsCalled(h.calls)).toEqual(['111111', '222222'])
    expect(h.logs.some(line => line.includes('backfilling 2 of 3 group(s) now'))).toBe(true)
    await dropAndWait(h, 31 * 60_000)
    await until(() => h.calls.length === 4, 'the second turn')
    expect(groupsCalled(h.calls)).toEqual(['111111', '222222', '333333', '111111'])
  })

  it('fetches nothing after a reconnect that follows the previous drop closely', async () => {
    const h = await boot({})
    await until(() => h.calls.length === 3, 'the first backfill')
    await dropAndWait(h, 0)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(h.calls).toHaveLength(3)
    expect(h.logs.some(line => line.includes('not backfilling this time'))).toBe(true)
  })

  it('fetches again once the previous drop is long enough ago, and skipWithinMs 0 never skips', async () => {
    const h = await boot({})
    await until(() => h.calls.length === 3, 'the first backfill')
    await dropAndWait(h, 31 * 60_000)
    await until(() => h.calls.length === 6, 'the second backfill')

    const never = await boot({ skipWithinMs: 0 })
    await until(() => never.calls.length === 3, 'the first backfill')
    await dropAndWait(never, 0)
    await until(() => never.calls.length === 6, 'the backfill after a quick reconnect')
  })

  it('does not download the files of a backfilled message, but does of a live one', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('offline')))
    vi.stubGlobal('fetch', fetch)
    const image = [{ type: 'image', data: { url: 'https://multimedia.nt.qq.com.cn/a.png', file: 'a.png' } }]
    const old = groupMessage('111111', '10001', image, { message_id: 7001 })
    const h = await boot({ maxGroups: 1 }, () => ({ messages: [old] }))
    await until(() => h.observer.store.recent('111111', { limit: 10 }).length === 1, 'the backfilled message')
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(fetch).not.toHaveBeenCalled()
    h.fake.push(groupMessage('111111', '10001', image, { message_id: 7002 }))
    await until(() => fetch.mock.calls.length > 0, 'the live download attempt')
  })
})
