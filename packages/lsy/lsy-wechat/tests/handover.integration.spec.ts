/**
 * `/new` against the real Schedule service and event bus: the owner's reminder and watch leave the old chat Session,
 * so archiving it finds no work, and the new chat Session shows them.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LsyEventBus from '@deepseek-ai/dsh-lsy-event-bus'
import OwnerRelay from '@deepseek-ai/dsh-owner-relay'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { harness as scheduleHarness } from '../../../schedule/schedule/tests/harness.ts'
import WechatChannel, { Config } from '../src/index.ts'
import { FakeIlink, textMessage } from './fake-ilink.ts'

const OWNER = 'owner@im.wechat'
let dir: string
const disposers: Array<() => Promise<void>> = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lsy-wechat-handover-'))
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-01T18:00:00.000Z'))
})

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

it('moves the old chat\'s reminder and watch to the new chat Session, so the old one archives cleanly', async () => {
  const ilink = new FakeIlink()
  vi.stubGlobal('fetch', ilink.fetch)
  const accountFile = join(dir, 'account.json')
  writeFileSync(accountFile, JSON.stringify({ botToken: 'token', botId: 'bot@im.bot', baseUrl: 'https://ilink.test', ownerUserId: OWNER, boundAt: '2026-10-21T00:00:00.000Z' }))
  const test = await scheduleHarness({ sessionController: false })
  const ctx = test.ctx
  disposers.push(() => ctx.fiber.dispose())
  let created = 0
  const injected: Array<[string, string]> = []
  ctx.provide('sessionController', {
    create: async () => ({ sessionId: `chat-${++created}` }),
    resolveAgent: async (sessionId: string) => ({ agent: {
      session: { id: sessionId },
      inject: (message: { content: Array<{ text?: string }> }) => { injected.push([sessionId, message.content[0]?.text ?? '']) },
    } }),
    prompt: async () => ({ accepted: true }),
  } as never)
  ctx.provide('permissionPresets', { resolve: () => ({}), set: () => {} } as never)
  ctx.provide('sessionTitle', { rename: () => {}, get: () => undefined } as never)
  await ctx.plugin(Timer)
  await ctx.plugin(OwnerRelay)
  await ctx.plugin(LsyEventBus, {
    subscriptions: [], suppress: { actors: [], markers: [] }, retainEvents: 100, retainBatches: 100,
    flowChangesKept: 200, maxTextChars: 2000,
    notifySessionResult: true, reportScheduledTurns: true, maxNoteEvents: 10,
  })
  await ctx.plugin(WechatChannel, Config({ accountFile, chat: { workspacePath: join(dir, 'work') } } as never))
  await vi.advanceTimersByTimeAsync(0)
  const ownerSays = async (text: string): Promise<void> => {
    ilink.updates([textMessage(OWNER, text)])
    await vi.advanceTimersByTimeAsync(0)
  }
  const activity = (sessionId: string) =>
    ctx.waterfall('workspace/session-activity', { sessionId: SessionId(sessionId) }, () => Promise.resolve([]))

  await ownerSays('remind me about the bootcamp homework every week')
  const old = SessionId('chat-1')
  const reminder = await ctx.schedule.create({
    title: 'TCH 数据科学 bootcamp 周作业', prompt: 'Remind the owner.',
    timing: { kind: 'rrule', rrule: 'DTSTART:20261102T140000Z\nRRULE:FREQ=WEEKLY' }, target: { kind: 'session', sessionId: old },
  }, old)
  await ctx.lsyEventBus.subscribe({
    id: 'harness-releases', sources: ['github'], kinds: ['github.release'], subjects: ['octo/repo'], action: 'notify', coalesceMs: 60_000, maxPerHour: 2,
  }, { createdBy: old })
  expect(await activity('chat-1')).toEqual([{ kind: 'schedule', items: [{ id: reminder.id, label: 'TCH 数据科学 bootcamp 周作业' }] }])

  await ownerSays('/new')

  expect(ilink.sent.at(-1)?.text).toBe('已开始新对话。上一个对话的 1 条定时提醒（TCH 数据科学 bootcamp 周作业）和 1 个 watch（harness-releases）已转到新对话。')
  expect(await activity('chat-1')).toEqual([])
  expect(await activity('chat-2')).toEqual([{ kind: 'schedule', items: [{ id: reminder.id, label: 'TCH 数据科学 bootcamp 周作业' }] }])
  expect(await ctx.schedule.view({ id: reminder.id })).toMatchObject({
    target: { kind: 'session', sessionId: 'chat-2' }, involvedSessionIds: ['chat-2'], status: 'active',
  })
  expect(ctx.lsyEventBus.listSubscriptions().find(view => view.id === 'harness-releases')?.createdBy).toBe('chat-2')
  expect(injected).toEqual([['chat-2', expect.stringContaining('schedule tasks "TCH 数据科学 bootcamp 周作业"; watches "harness-releases"')]])

  // A second /new hands the reminder on again, from every earlier chat.
  await ownerSays('/new')
  expect(await ctx.schedule.view({ id: reminder.id })).toMatchObject({ target: { kind: 'session', sessionId: 'chat-3' } })
})
