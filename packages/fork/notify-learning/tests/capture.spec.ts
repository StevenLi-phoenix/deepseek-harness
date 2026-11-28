/** The capture: proactive messages and the owner's replies, read from committed Session events only. */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { untrustedRequestId } from '@deepseek-ai/dsh-turn-taint/origin'
import { describe, expect, it } from 'vitest'
import { AGENT_CHARS, Capture, OWNER_CHARS, SENT_CHARS } from '../src/capture.ts'
import type { Exchange, Reply } from '../src/records.ts'

const AT = new Date('2026-11-27T10:00:00Z')

function harness(owners: Record<string, string> = { wechat: 'wechat' }) {
  const outputs: Exchange[] = []
  const replies: Reply[] = []
  const capture = new Capture('wechat', id => owners[id], { output: item => outputs.push(item), reply: item => replies.push(item) }, () => AT)
  const session = (id = 'wechat', origin?: string): Session => ({ id, header: origin === undefined ? {} : { origin } }) as never
  const feed = (target: Session, ...events: Array<{ type: string; data?: unknown }>): void => {
    for (const event of events) capture.observe(target, event as SessionEvent)
  }
  return { capture, outputs, replies, session, feed }
}

const start = { type: 'turn/start', data: {} }
const end = { type: 'turn/end', data: {} }
const user = (source: unknown, text: string) => ({ type: 'user/message', data: { source, content: [{ type: 'text', text }] } })
const answer = (...blocks: Array<{ type: string; text?: string }>) => ({ type: 'assistant/message', data: { message: { content: blocks } } })
const text = (value: string) => answer({ type: 'text', text: value })
const send = (args: string, name = 'wechat_send') => ({ type: 'tool/call', data: { name, arguments: args } })

const OWNER = { kind: 'user', rpcId: 'web' }
const SCHEDULE = { kind: 'schedule' }
const NOTE = { kind: 'user', rpcId: untrustedRequestId('note') }

describe('Capture', () => {
  it('keeps a reminder turn\'s answer as a proactive message, with what started it', () => {
    const h = harness()
    h.feed(h.session(), start, user(SCHEDULE, '[reminder] 交作业'), user({ kind: 'time-gap' }, 'Time check'), text('魔女大人，作业今晚截止'), end)
    const [kept] = h.outputs
    expect(kept?.id).toMatch(/^x[0-9a-f]{8}$/u)
    expect(h.outputs).toEqual([{ id: kept?.id, session: 'wechat', at: AT.toISOString(), trigger: 'scheduled', sent: '魔女大人，作业今晚截止', replies: [] }])
    expect(h.replies).toEqual([])
  })

  it('joins wechat_send texts and the answer, and drops a final NO_REPLY', () => {
    const h = harness()
    h.feed(h.session(), start, user(NOTE, 'note'), user(SCHEDULE, 'also due'),
      send(JSON.stringify({ text: '  CI 失败：build #12 ' })), send('{"text":'), send('null'), send(JSON.stringify({ text: ' ' })), send(JSON.stringify({ text: 'x' }), 'bash'),
      answer({ type: 'thinking' }, { type: 'text', text: '已经发了' }), text('NO_REPLY'), end)
    expect(h.outputs.map(item => [item.trigger, item.sent])).toEqual([['peer:note+scheduled', 'CI 失败：build #12']])
  })

  it('keeps the answers when the last one is not NO_REPLY', () => {
    const h = harness()
    h.feed(h.session(), start, user({ kind: 'webhook' }, 'event'), text('第一段'), answer({ type: 'text', text: '  ' }), text('第二段'), end)
    expect(h.outputs.map(item => item.sent)).toEqual(['第一段\n第二段'])
  })

  it('keeps nothing when a proactive turn sent nothing', () => {
    const h = harness()
    h.feed(h.session(), start, user({ kind: 'tool-monitor' }, 'line'), text('NO_REPLY'), end)
    expect(h.outputs).toEqual([])
  })

  it('reports the owner\'s own turn as a reply, with the agent\'s answer', () => {
    const h = harness()
    h.feed(h.session(), start, user(OWNER, '这种别发了'), user(OWNER, ''), user(OWNER, '真的'), text('好，记下了'), end)
    expect(h.replies).toEqual([{ at: AT.toISOString(), owner: '这种别发了\n真的', agent: '好，记下了' }])
    expect(h.outputs).toEqual([])
  })

  it('reports no reply for an owner turn with no words, such as a picture alone', () => {
    const h = harness()
    h.feed(h.session(), start, { type: 'user/message', data: { source: OWNER, content: [{ type: 'image' }] } }, text('收到图片'), end)
    expect(h.replies).toEqual([])
  })

  it('counts a turn the owner joined, or a guest spoke in, as neither', () => {
    const h = harness()
    h.feed(h.session(), start, user(SCHEDULE, 'r'), user(OWNER, '我在'), text('a'), end)
    h.feed(h.session(), start, user(SCHEDULE, 'r'), user({ kind: 'user', principal: 'guest-1' }, 'hi'), text('b'), end)
    expect(h.outputs).toEqual([])
    expect(h.replies).toEqual([])
  })

  it('ignores a turn of only host context, Sessions no channel or another channel claims, and subagents', () => {
    const h = harness({ wechat: 'wechat', bili: 'bili-dm' })
    h.feed(h.session(), start, user({ kind: 'time-gap' }, 'Time check'), text('a'), end)
    h.feed(h.session('web-chat'), start, user(SCHEDULE, 'r'), text('b'), end)
    h.feed(h.session('bili'), start, user(SCHEDULE, 'r'), text('c'), end)
    h.feed(h.session('wechat', 'subagent'), start, user(SCHEDULE, 'r'), text('d'), end)
    expect(h.outputs).toEqual([])
  })

  it('ignores events outside a turn and events that carry nothing it needs', () => {
    const h = harness()
    h.feed(h.session(), user(SCHEDULE, 'before'), text('before'), end)
    h.feed(h.session(), start, user(SCHEDULE, 'r'), { type: 'tool/result', data: {} }, text('ok'), end)
    expect(h.outputs.map(item => item.sent)).toEqual(['ok'])
  })

  it('clips what it keeps by characters', () => {
    const h = harness()
    h.feed(h.session(), start, user(SCHEDULE, 'r'), text('通'.repeat(SENT_CHARS + 5)), end)
    h.feed(h.session(), start, user(OWNER, '话'.repeat(OWNER_CHARS + 1)), text('答'.repeat(AGENT_CHARS + 1)), end)
    expect(h.outputs[0]!.sent).toBe(`${'通'.repeat(SENT_CHARS)}…`)
    expect(h.replies[0]).toMatchObject({ owner: `${'话'.repeat(OWNER_CHARS)}…`, agent: `${'答'.repeat(AGENT_CHARS)}…` })
  })
})
