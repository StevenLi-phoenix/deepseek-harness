/** The account's DM channel with the plugins around it: the owner relay, the event bus, and the WeChat channel. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WechatChannel, { Config as WechatConfig } from '@deepseek-ai/dsh-lsy-wechat'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeIlink, textMessage } from '../../lsy-wechat/tests/fake-ilink.ts'
import { FakeBiliSvc } from './fake-bili-svc.ts'
import { allLogs, contexts, credentialStore, fakeSessions, harness } from './harness.ts'

const OWNER = 200000001
const WECHAT_OWNER = 'owner@im.wechat'
/** How the WeChat chat Session reads a fallback copy of the account's answer. */
const ORIGIN = 'the Bilibili account\'s Session (its answer could not go out as a Bilibili message)'
let dir: string
let svc: FakeBiliSvc

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bili-channels-'))
  svc = new FakeBiliSvc()
  vi.useFakeTimers()
  // Fri 2026-10-23 10:00 in New York (EDT).
  vi.setSystemTime(new Date('2026-10-23T14:00:00.000Z'))
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
  allLogs.splice(0)
})

function assistant(text: string): unknown {
  return { type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } } }
}

function turnEnd(turn: number): unknown {
  return { type: 'turn/end', seq: 9, data: { turn, reason: { kind: 'completed' } } }
}

/** The owner's main account writes once; the next message check (within ten minutes) prompts the Session. */
async function ownerWrites(text: string): Promise<void> {
  const key = String(6_984_393_491_767_670_000n + BigInt(svc.ownerMessages.length + 1))
  svc.ownerMessages.push({ sender: OWNER, text, key, at: Math.floor(Date.now() / 1000) })
  svc.unread.follow = 1
  await vi.advanceTimersByTimeAsync(600_000)
}

/** A Host-schedule reminder message, as the schedule service frames it. */
const REMINDER = {
  type: 'user/message',
  seq: 10,
  data: { role: 'user', content: [{ type: 'text', text: 'reminder_prompt_json: "Look at the following feed"' }], source: { kind: 'schedule' } },
}

describe('the account\'s DM channel and the owner relay', () => {
  it('claims the account\'s Session with the relay, again after a restart', async () => {
    const credentials = credentialStore()
    const sessions = fakeSessions()
    const first = await harness({ svc, credentials, sessions, workspace: dir, config: { inboxPollMs: 600_000 } })
    await vi.advanceTimersByTimeAsync(600_000)
    expect(first.ctx.ownerRelay.ownerOf('bili-1')).toBeUndefined()
    await ownerWrites('在吗')
    expect(first.ctx.ownerRelay.ownerOf('bili-1')).toBe('bili-dm')
    await first.ctx.fiber.dispose()

    const again = await harness({ svc, credentials, sessions, pool: first.pool, workspace: dir })
    expect(again.ctx.ownerRelay.ownerOf('bili-1')).toBe('bili-dm')
    expect(again.logs.some(line => line.text === 'bili: the relay carries 1 Session(s) through channel bili-dm')).toBe(true)
  })

  it('forgets the reply mark when its turn sends nothing, so a later Web UI turn stays in the Session', async () => {
    const h = await harness({ svc, workspace: dir, config: { inboxPollMs: 600_000 } })
    await vi.advanceTimersByTimeAsync(600_000)
    await ownerWrites('嗯')
    h.emit('bili-1', assistant('NO_REPLY'))
    h.emit('bili-1', turnEnd(1))
    h.emit('bili-1', assistant('a Web UI answer'))
    h.emit('bili-1', turnEnd(2))
    await vi.advanceTimersByTimeAsync(1000)
    expect(svc.replies).toEqual([])
    expect(h.notes).toEqual([])
    expect(h.logs.some(line => line.text === 'bili: Session bili-1 ended a turn the owner\'s messages did not start (completed); its answer stays in the Session')).toBe(true)
  })

  it('keeps the event bus from reporting a reminder turn of the account\'s Session', async () => {
    const h = await harness({ svc, workspace: dir, bus: true, config: { inboxPollMs: 600_000 } })
    await vi.advanceTimersByTimeAsync(600_000)
    await ownerWrites('今天看什么了')
    h.emit('bili-1', assistant('今天看到一只会开门的猫'))
    h.emit('bili-1', turnEnd(1))
    await vi.advanceTimersByTimeAsync(1000)
    expect(svc.replies.map(reply => reply.message)).toEqual(['今天看到一只会开门的猫'])

    // A reminder turn in the same Session: the DM channel claimed it, so the bus stays out and nothing reaches WeChat.
    h.emit('bili-1', REMINDER)
    h.emit('bili-1', assistant('the reminder\'s answer'))
    h.emit('bili-1', turnEnd(2))
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.notes).toEqual([])
    expect(svc.replies).toHaveLength(1)
    expect(h.logs.some(line => line.text === 'lsy-event-bus: Session bili-1 is relayed by bili-dm; its ⏰ turn is not reported')).toBe(true)
    expect(h.logs.some(line => line.text === 'bili: Session bili-1 ended a turn the owner\'s messages did not start (completed); its answer stays in the Session')).toBe(true)
  })

  it('shares an answer that fell back to WeChat with the WeChat chat Session, framed as the account\'s', async () => {
    svc.replyStatus = ['held']
    const sessions = fakeSessions()
    const h = await harness({ svc, sessions, workspace: dir, notifier: false, config: { inboxPollMs: 600_000 } })
    // The real WeChat channel is the notifier; its iLink double and the Bilibili double share fetch.
    const ilink = new FakeIlink()
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      return url.startsWith('https://ilink.test') ? ilink.fetch(input, init) : svc.fetch(input, init)
    })
    const accountFile = join(dir, 'account.json')
    writeFileSync(accountFile, JSON.stringify({ botToken: 'bot-token', botId: 'bot@im.bot', baseUrl: 'https://ilink.test', ownerUserId: WECHAT_OWNER, boundAt: '2026-10-21T00:00:00.000Z' }))
    await h.ctx.plugin(WechatChannel, WechatConfig({ accountFile, chat: { workspacePath: join(dir, 'chat') } } as never))
    await vi.advanceTimersByTimeAsync(0)
    ilink.updates([textMessage(WECHAT_OWNER, 'hi', 'ctx-hi')])
    await vi.advanceTimersByTimeAsync(0)
    expect(sessions.state.prompts.map(prompt => prompt.sessionId)).toEqual(['chat-1'])

    await vi.advanceTimersByTimeAsync(600_000)
    await ownerWrites('在吗')
    h.emit('bili-1', assistant('在的，刚看完一个视频'))
    h.emit('bili-1', turnEnd(1))
    await vi.advanceTimersByTimeAsync(1000)
    expect(svc.replies).toHaveLength(1)
    const note = '📺 B站：这条没能用 B站私信发出，改发微信\n\n在的，刚看完一个视频\n\n原因：bili-svc\'s Reply Gate answered held (r-1)'
    expect(ilink.sent.map(sent => sent.text)).toContain(note)
    const shared = sessions.state.injected.filter(([sessionId]) => sessionId === 'chat-1').map(([, text]) => text)
    expect(shared).toHaveLength(1)
    expect(shared[0]).toMatch(/^At Fri 2026-10-23 \d\d:\d\d \(America\/New_York\), /)
    expect(shared[0]).toContain(`, ${ORIGIN} sent the owner this message on WeChat. It is context, not the owner speaking`)
    expect(shared[0]!.endsWith(`\n${note}`)).toBe(true)
  })

  it('passes a message to the WeChat main agent, whose answer goes to the owner on WeChat', async () => {
    const sessions = fakeSessions()
    const h = await harness({ svc, sessions, workspace: dir, notifier: false })
    const ilink = new FakeIlink()
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      return url.startsWith('https://ilink.test') ? ilink.fetch(input, init) : svc.fetch(input, init)
    })
    const accountFile = join(dir, 'account.json')
    writeFileSync(accountFile, JSON.stringify({ botToken: 'bot-token', botId: 'bot@im.bot', baseUrl: 'https://ilink.test', ownerUserId: WECHAT_OWNER, boundAt: '2026-10-21T00:00:00.000Z' }))
    await h.ctx.plugin(WechatChannel, WechatConfig({ accountFile, chat: { workspacePath: join(dir, 'chat') } } as never))
    await vi.advanceTimersByTimeAsync(0)
    ilink.updates([textMessage(WECHAT_OWNER, 'hi', 'ctx-hi')])
    await vi.advanceTimersByTimeAsync(0)

    expect(await h.account.tellMainAgent('魔女大人让我告诉你：人格卡能装 https://www.bilibili.com/video/BV1sTnn6DEWv')).toMatchObject({ outcome: 'sent' })
    const prompt = sessions.state.prompts.at(-1)!
    expect(prompt).toMatchObject({ sessionId: 'chat-1', mode: 'queue' })
    const text = prompt.content[0]?.type === 'text' ? prompt.content[0].text : ''
    expect(text).toContain(', the Bilibili account\'s Session (the agent that lives on its own Bilibili account and reads public Bilibili content) sent you, the owner\'s main agent, the message below.')
    expect(text.endsWith('\n<agent_message trust="untrusted">\n魔女大人让我告诉你：人格卡能装 https://www.bilibili.com/video/BV1sTnn6DEWv\n</agent_message>')).toBe(true)

    h.emit('chat-1', assistant('猫猫说人格卡能装，我看了一下，装的话要重启 dsh。要装吗？'))
    h.emit('chat-1', turnEnd(2))
    await vi.advanceTimersByTimeAsync(0)
    expect(ilink.sent.map(sent => sent.text)).toEqual(['猫猫说人格卡能装，我看了一下，装的话要重启 dsh。要装吗？'])
    expect(svc.replies).toEqual([])
  })
})
