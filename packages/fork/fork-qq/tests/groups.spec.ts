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

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fork-qq-groups-')) })
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
async function boot(initial: string[], history: () => unknown = () => ({ messages: [] })) {
  const fake = new FakeOneBot(TOKEN)
  servers.push(fake)
  await fake.listen()
  fake.handlers.set('get_login_info', () => ({ user_id: 99999, nickname: 'bot' }))
  fake.handlers.set('get_group_list', () => [
    { group_id: Number(A), group_name: '技术群', member_count: 80 },
    { group_id: Number(B), group_name: '闲聊群', member_count: 300 },
    { group_id: Number(C), group_name: '安静群', member_count: 12 },
  ])
  fake.handlers.set('get_group_msg_history', history)
  const ctx = new Context()
  contexts.push(ctx)
  const logs: string[] = []
  const warnings: string[] = []
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (m) => {
      logs.push(String(m.args[0]))
      if (m.type === 'warn') warnings.push(String(m.args[0]))
    },
  })
  ctx.provide('credentials', { resolve: () => Promise.resolve({ value: TOKEN }) } as never)
  ctx.provide('sessionController', { create: vi.fn(), resolveAgent: vi.fn(), prompt: vi.fn(), selectModel: vi.fn() } as never)
  ctx.provide('permissionPresets', { resolve: vi.fn(), set: vi.fn() } as never)
  ctx.provide('sessionTitle', { rename: vi.fn(), get: vi.fn() } as never)
  await ctx.plugin(Observer, {
    url: fake.url, groups: initial, dataDir: join(dir, 'data'), digest: { enabled: false, workspacePath: join(dir, 'digest') }, login: { enabled: false }, backfill: { gapMs: 0 },
  })
  await until(() => logs.some(line => line.includes('logged in as')) && logs.some(line => line.includes('the account is in')), 'the connection')
  // What the loader does when the Settings form saves a volatile field: commit the new value into the running reference, then emit.
  const move = (groups: string[]) => {
    const live = (ctx.forkQq as unknown as { config: { groups: Parameters<typeof updateVolatile>[0] } }).config.groups
    updateVolatile(live, createVolatile(groups))
    ctx.emit('loader/volatile-update' as never)
  }
  return { ctx, observer: ctx.forkQq, fake, logs, warnings, move }
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

  it('ignores an entry that is not a group number when the list changes at run time, and says so once', async () => {
    const h = await boot([A])
    h.move([A, B, 'abc', '12', '9'.repeat(21), ' 123456 '])
    expect(h.observer.recordedGroups()).toBe(2)
    expect(h.observer.isRecorded('abc')).toBe(false)
    expect(h.observer.groupChoices().filter(group => group.recorded).map(group => group.groupId).sort()).toEqual([A, B].sort())
    h.move([A, B, 'abc', '12', '9'.repeat(21), ' 123456 '])
    const warned = h.logs.filter(line => line.includes('ignoring') && line.includes('not a group number'))
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('abc')
  })

  it('reads the list live for everything that checks a group', async () => {
    const h = await boot([A])
    expect(h.observer.isRecorded(B)).toBe(false)
    h.move([A, B])
    expect(h.observer.isRecorded(B)).toBe(true)
    expect(h.observer.groupOverview().find(group => group.groupId === B)?.recorded).toBe(true)
  })

  it('does not call a group without history a failed backfill', async () => {
    const empty = () => { throw new Error('消息undefined不存在') }
    const h = await boot([A], empty)
    await until(() => h.fake.callsOf('get_group_msg_history').length >= 1, 'the backfill')
    await until(() => h.logs.some(line => line.includes('has no history to backfill')), 'the note')
    expect(h.warnings.filter(line => line.includes('backfill of group'))).toEqual([])
  })

  it('still warns when the backfill fails for any other reason', async () => {
    const h = await boot([A], () => { throw new Error('网络错误') })
    await until(() => h.warnings.some(line => line.includes(`backfill of group ${A} failed`)), 'the warning')
  })

  describe('evidenceOf', () => {
    const post = async (h: Awaited<ReturnType<typeof boot>>, group: string, user: string, id: number) => {
      h.fake.push(groupMessage(group, user, `消息${id}`, { message_id: id, time: Math.floor(Date.now() / 1000) }))
      await until(() => h.observer.store.byMessageId(group, String(id)) !== undefined, `message ${id}`)
    }

    it('answers with a stable sender key and the time, never the QQ number, only for messages the group holds', async () => {
      const h = await boot([A, B])
      await post(h, A, '10001', 7001)
      await post(h, A, '10002', 7002)
      await post(h, A, '10001', 7003)
      await post(h, B, '10001', 7004)
      const found = h.observer.evidenceOf(A, ['7001', '7002', '7003', '7004', '9999'])
      expect(found.map(entry => entry.messageId)).toEqual(['7001', '7002', '7003'])
      expect(found[0]!.senderKey).toBe(found[2]!.senderKey)
      expect(found[0]!.senderKey).not.toBe(found[1]!.senderKey)
      expect(found[0]!.senderKey).toMatch(/^[0-9a-f]{16}$/)
      expect(JSON.stringify(found)).not.toContain('10001')
      expect(found.every(entry => typeof entry.at === 'number')).toBe(true)
      // The same member has another key in another group, so keys cannot be joined across groups.
      expect(h.observer.evidenceOf(B, ['7004'])[0]!.senderKey).not.toBe(found[0]!.senderKey)
    })

    it('answers nothing for a group that is not recorded, a recalled message, or a message past retention', async () => {
      const h = await boot([A])
      await post(h, A, '10001', 7101)
      expect(h.observer.evidenceOf(C, ['7101'])).toEqual([])
      h.observer.store.recall(A, '7101')
      expect(h.observer.evidenceOf(A, ['7101'])).toEqual([])
      await post(h, A, '10001', 7102)
      expect(h.observer.evidenceOf(A, ['7102'])).toHaveLength(1)
      h.observer.now = () => Date.now() + 31 * 86_400_000
      expect(h.observer.evidenceOf(A, ['7102'])).toEqual([])
    })

    it('looks at 200 ids at most', async () => {
      const h = await boot([A])
      await post(h, A, '10001', 7201)
      const ids = [...Array.from({ length: 200 }, (_unused, index) => `none${index}`), '7201']
      expect(h.observer.evidenceOf(A, ids)).toEqual([])
    })
  })
})
