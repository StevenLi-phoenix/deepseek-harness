import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QqObserver as Observer } from '../src/index.ts'
import { FakeOneBot, groupMessage } from './fake-onebot.ts'

const TOKEN = 'onebot-token-0123456789abcdef'
const A = '123456789'
const B = '987654321'
const C = '555666777'
const USER = '10001'

let dir: string
const contexts: Context[] = []
const servers: FakeOneBot[] = []

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lsy-qq-groups-')) })
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(servers.splice(0).map(server => server.close()))
  rmSync(dir, { recursive: true, force: true })
})

async function until(check: () => boolean, what: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Boot an observer whose `groups` reference the test can move, as the Settings form does. */
async function boot(initial: string[]) {
  const fake = new FakeOneBot(TOKEN)
  servers.push(fake)
  await fake.listen()
  fake.handlers.set('get_login_info', () => ({ user_id: 99999, nickname: 'bot' }))
  fake.handlers.set('get_group_list', () => [
    { group_id: Number(A), group_name: '技术群', member_count: 80 },
    { group_id: Number(B), group_name: '闲聊群', member_count: 300 },
    { group_id: Number(C), group_name: '安静群', member_count: 12 },
  ])
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
    url: fake.url, groups: initial, dataDir: join(dir, 'data'), digest: { enabled: false, workspacePath: join(dir, 'digest') }, login: { enabled: false },
  })
  await until(() => logs.some(line => line.includes('logged in as')) && logs.some(line => line.includes('the account is in')), 'the connection')
  // What the loader does when the Settings form saves a volatile field: commit the new value into the running reference, then emit.
  const move = (groups: string[]) => {
    const live = (ctx.lsyQq as unknown as { config: { groups: Parameters<typeof updateVolatile>[0] } }).config.groups
    updateVolatile(live, createVolatile(groups))
    ctx.emit('loader/volatile-update' as never)
  }
  return { ctx, observer: ctx.lsyQq, fake, logs, move }
}

describe('QQ groups follow the Settings form', () => {
  it('starts recording a group added at run time, without a restart, and fetches what it missed', async () => {
    const h = await boot([A])
    h.fake.push(groupMessage(B, USER, '加入前'))
    await until(() => h.observer.unlistedActivity().length === 1, 'the dropped message')
    expect(h.observer.recordedGroups()).toBe(1)
    h.move([A, B])
    expect(h.observer.recordedGroups()).toBe(2)
    h.fake.push(groupMessage(B, USER, '加入后'))
    await until(() => h.observer.recentMessages(B, { hours: 24 * 365 * 10, limit: 10 }).length === 1, 'the recorded message')
    expect(h.observer.recentMessages(B, { hours: 24 * 365 * 10, limit: 10 })[0]?.text).toBe('加入后')
    await until(() => h.fake.callsOf('get_group_msg_history').some(call => call['group_id'] === Number(B)), 'the backfill of the added group')
    expect(h.logs.some(line => line.includes(`now recording group ${B}`))).toBe(true)
  })

  it('stops recording a group removed at run time, and keeps what it already stored until retention', async () => {
    const h = await boot([A, B])
    h.fake.push(groupMessage(B, USER, '移除前'))
    await until(() => h.observer.recentMessages(B, { hours: 24 * 365 * 10, limit: 10 }).length === 1, 'the first message')
    h.move([A])
    expect(h.observer.recordedGroups()).toBe(1)
    h.fake.push(groupMessage(B, USER, '移除后'))
    await until(() => h.observer.unlistedActivity().some(group => group.groupId === B), 'the dropped message')
    expect(h.observer.store.recent(B, { limit: 10 }).map(row => row.text)).toEqual(['移除前'])
    expect(h.logs.some(line => line.includes(`no longer recording group ${B}`))).toBe(true)
  })

  it('offers the groups the account is in: recorded ones first, then the others by how busy they were', async () => {
    const h = await boot([A])
    h.fake.push(groupMessage(B, USER, '热闹'))
    h.fake.push(groupMessage(B, USER, '热闹二'))
    await until(() => h.observer.unlistedActivity().some(group => group.messages === 2), 'the dropped messages')
    expect(h.observer.groupChoices()).toEqual([
      { groupId: A, name: '技术群', memberCount: 80, recorded: true, seen: 0 },
      { groupId: B, name: '闲聊群', memberCount: 300, recorded: false, seen: 2 },
      { groupId: C, name: '安静群', memberCount: 12, recorded: false, seen: 0 },
    ])
  })

  it('reads the list live for everything that checks a group', async () => {
    const h = await boot([A])
    expect(h.observer.isRecorded(B)).toBe(false)
    h.move([A, B])
    expect(h.observer.isRecorded(B)).toBe(true)
    expect(h.observer.groupOverview().find(group => group.groupId === B)?.recorded).toBe(true)
  })
})
