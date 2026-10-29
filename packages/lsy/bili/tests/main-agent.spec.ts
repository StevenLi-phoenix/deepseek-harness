/** Messages from the account's Session to the owner's main agent: the daily limit and the WeChat channel's answers. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LsyAgentMessage } from '@deepseek-ai/dsh-lsy-event-bus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BILI_AGENT_ORIGIN } from '../src/dm.ts'
import { MAIN_AGENT_MAX_CHARS } from '../src/index.ts'
import { allLogs, contexts, harness } from './harness.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bili-main-agent-'))
  vi.useFakeTimers()
  // Wed 2026-10-28 19:12 in New York (EDT).
  vi.setSystemTime(new Date('2026-10-28T23:12:00.000Z'))
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
  allLogs.splice(0)
})

/** A main agent that records what reached it and answers with its chat Session. */
function mainAgent() {
  const told: LsyAgentMessage[] = []
  return { told, tell: (message: LsyAgentMessage) => { told.push(message); return Promise.resolve('chat-1') } }
}

describe('BiliAccount.tellMainAgent', () => {
  it('hands the message to the main agent as the account\'s, trimmed, and says what is left today', async () => {
    const agent = mainAgent()
    const h = await harness({ workspace: dir, mainAgent: agent.tell })
    expect(await h.account.tellMainAgent('  人格卡能装，记忆照文件结构抄一份 https://www.bilibili.com/video/BV1sTnn6DEWv \n')).toEqual({
      outcome: 'sent',
      detail: 'the main agent got it and takes it up in a turn of its own; its answer goes to the owner on WeChat, not to you. 4 left today.',
    })
    expect(agent.told).toEqual([{ text: '人格卡能装，记忆照文件结构抄一份 https://www.bilibili.com/video/BV1sTnn6DEWv', from: BILI_AGENT_ORIGIN }])
    expect(h.logs.some(line => line.text === 'bili: told the main agent 60 chars in chat Session chat-1 (1/5 today)')).toBe(true)
    // Nothing goes to the owner from the account itself.
    expect(h.notes).toEqual([])
    expect(h.bili.sentMessages).toEqual([])
  })

  it('refuses an empty or overlong message before it counts', async () => {
    const agent = mainAgent()
    const h = await harness({ workspace: dir, mainAgent: agent.tell, config: { mainAgentPerDay: 1 } })
    expect(await h.account.tellMainAgent(' \n ')).toEqual({ outcome: 'refused', detail: 'the message is empty' })
    expect(await h.account.tellMainAgent('字'.repeat(MAIN_AGENT_MAX_CHARS + 1))).toEqual({
      outcome: 'refused', detail: `the message is ${MAIN_AGENT_MAX_CHARS + 1} characters; the limit is ${MAIN_AGENT_MAX_CHARS}`,
    })
    expect(await h.account.tellMainAgent('字'.repeat(MAIN_AGENT_MAX_CHARS))).toMatchObject({ outcome: 'sent' })
    expect(agent.told).toHaveLength(1)
  })

  it('stops at the daily limit and starts again the next day in the account\'s time zone', async () => {
    const agent = mainAgent()
    const h = await harness({ workspace: dir, mainAgent: agent.tell, config: { mainAgentPerDay: 2 } })
    expect(await h.account.tellMainAgent('one')).toMatchObject({ outcome: 'sent', detail: expect.stringMatching(/ 1 left today\.$/) as unknown })
    expect(await h.account.tellMainAgent('two')).toMatchObject({ outcome: 'sent', detail: expect.stringMatching(/ 0 left today\.$/) as unknown })
    expect(await h.account.tellMainAgent('three')).toEqual({ outcome: 'refused', detail: 'today\'s 2 message(s) to the main agent are used up' })
    // 23:59 in New York is still the same day.
    vi.setSystemTime(new Date('2026-10-29T03:59:00.000Z'))
    expect(await h.account.tellMainAgent('still today')).toMatchObject({ outcome: 'refused' })
    vi.setSystemTime(new Date('2026-10-29T04:01:00.000Z'))
    expect(await h.account.tellMainAgent('tomorrow')).toMatchObject({ outcome: 'sent', detail: expect.stringMatching(/ 1 left today\.$/) as unknown })
    expect(agent.told.map(message => message.text)).toEqual(['one', 'two', 'tomorrow'])
    expect(h.logs.some(line => line.text === 'bili: told the main agent 8 chars in chat Session chat-1 (1/2 today)')).toBe(true)
  })

  it('keeps the count across a restart', async () => {
    const agent = mainAgent()
    const first = await harness({ workspace: dir, mainAgent: agent.tell, config: { mainAgentPerDay: 1 } })
    expect(await first.account.tellMainAgent('one')).toMatchObject({ outcome: 'sent' })
    await first.ctx.fiber.dispose()
    const again = await harness({ workspace: dir, mainAgent: agent.tell, config: { mainAgentPerDay: 1 }, pool: first.pool })
    expect(await again.account.tellMainAgent('two')).toEqual({ outcome: 'refused', detail: 'today\'s 1 message(s) to the main agent are used up' })
  })

  it('is off at a daily limit of 0', async () => {
    const agent = mainAgent()
    const h = await harness({ workspace: dir, mainAgent: agent.tell, config: { mainAgentPerDay: 0 } })
    expect(await h.account.tellMainAgent('one')).toEqual({ outcome: 'refused', detail: 'today\'s 0 message(s) to the main agent are used up' })
    expect(agent.told).toEqual([])
  })

  it('refuses without a channel that reaches the main agent', async () => {
    const plain = await harness({ workspace: dir })
    const unreachable = { outcome: 'refused', detail: 'the owner\'s WeChat channel is not running, so the main agent cannot be reached' }
    expect(await plain.account.tellMainAgent('one')).toEqual(unreachable)
    await plain.ctx.fiber.dispose()
    const none = await harness({ workspace: dir, notifier: false })
    expect(await none.account.tellMainAgent('one')).toEqual(unreachable)
  })

  it('reports a message the channel could not queue, which does not count', async () => {
    let fail = true
    const told: string[] = []
    const tell = (message: LsyAgentMessage): Promise<string> => {
      if (fail) return Promise.reject(new Error('WeChat is not bound yet, so the main agent has no chat'))
      told.push(message.text)
      return Promise.resolve('chat-2')
    }
    const h = await harness({ workspace: dir, mainAgent: tell, config: { mainAgentPerDay: 1 } })
    expect(await h.account.tellMainAgent('one')).toEqual({
      outcome: 'refused', detail: 'the main agent could not take it: WeChat is not bound yet, so the main agent has no chat',
    })
    expect(h.logs.some(line => line.type === 'warn' && line.text === 'bili: the message to the main agent did not go out: WeChat is not bound yet, so the main agent has no chat')).toBe(true)
    fail = false
    expect(await h.account.tellMainAgent('two')).toMatchObject({ outcome: 'sent' })
    expect(told).toEqual(['two'])
  })
})
