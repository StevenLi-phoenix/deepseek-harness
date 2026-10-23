import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import type { LsyNote } from '@deepseek-ai/dsh-lsy-event-bus'
import { afterEach, describe, expect, it } from 'vitest'
import OwnerRelay, { type RelayAnswer, type RelayChannel, type RelayDelivery } from '../src/index.ts'

/** A log line the relay wrote. */
interface LogLine {
  type: string
  text: string
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Let pending deliveries, fallbacks, and settle hooks run. */
async function drain(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await setImmediate()
}

/** Mount the relay with a recording notifier unless `notifier` is false. */
async function mount(options: { notifier?: false | ((note: LsyNote) => Promise<void>) } = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const logs: LogLine[] = []
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (message) => { logs.push({ type: message.type, text: String(message.args[0]) }) },
  })
  const notes: LsyNote[] = []
  if (options.notifier !== false) {
    const send = options.notifier ?? (async (note: LsyNote) => { notes.push(note) })
    ctx.provide('lsyNotifier', { send } as never)
  }
  await ctx.plugin(OwnerRelay)
  const relay = ctx.ownerRelay
  const emit = (sessionId: string, event: unknown): void => { (ctx.emit as (...args: unknown[]) => void)('session/event', { id: sessionId }, event) }
  return { ctx, relay, notes, logs, emit }
}

/** A channel double that records its hooks and the answers it gets, in order. */
function recorder(name: string, options: { fallbackLabel?: string; deliver?: (answer: RelayAnswer) => Promise<RelayDelivery> } = {}) {
  const calls: string[] = []
  const answers: RelayAnswer[] = []
  const channel: RelayChannel = {
    name,
    ...(options.fallbackLabel === undefined ? {} : { fallbackLabel: options.fallbackLabel }),
    deliver: async (answer) => {
      calls.push(`deliver:${answer.sessionId}`)
      answers.push(answer)
      return options.deliver === undefined ? 'sent' : await options.deliver(answer)
    },
    onTurnStart: (sessionId) => { calls.push(`start:${sessionId}`) },
    onTurnEnd: (sessionId) => { calls.push(`end:${sessionId}`) },
    onTurnSettled: (sessionId) => { calls.push(`settled:${sessionId}`) },
  }
  return { channel, calls, answers }
}

const turnStart = { type: 'turn/start', seq: 0, data: { turn: 1 } }
function assistant(text: string): unknown {
  return { type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } } }
}
function turnEnd(reason: Record<string, unknown> = { kind: 'completed' }): unknown {
  return { type: 'turn/end', seq: 9, data: { turn: 1, reason } }
}
/** One turn of `sessionId`: start, an optional final text, and the end. */
async function turn(
  emit: (id: string, event: unknown) => void, sessionId: string, text: string | undefined, reason?: Record<string, unknown>,
): Promise<void> {
  emit(sessionId, turnStart)
  if (text !== undefined) emit(sessionId, assistant(text))
  emit(sessionId, turnEnd(reason))
  await drain()
}

describe('OwnerRelay rules', () => {
  it('relays the latest text of a completed turn to the channel that claimed the Session', async () => {
    const h = await mount()
    const wechat = recorder('wechat')
    h.relay.registerChannel(wechat.channel)
    h.relay.claim('chat-1', 'wechat')
    h.emit('chat-1', turnStart)
    h.emit('chat-1', assistant('draft'))
    h.emit('chat-1', { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'thinking', thinking: 'hm' }] } } })
    h.emit('chat-1', { type: 'tool/result', seq: 3, data: {} })
    h.emit('chat-1', assistant('Final answer.'))
    h.emit('chat-1', turnEnd())
    await drain()
    expect(wechat.answers).toEqual([{ sessionId: 'chat-1', text: 'Final answer.', outcome: 'completed' }])
    expect(h.logs.some(line => line.type === 'info' && line.text === 'owner-relay: Session chat-1 ended a turn (completed); relaying 13 chars through wechat')).toBe(true)
    expect(h.logs.some(line => line.text === 'owner-relay: wechat sent the answer of Session chat-1')).toBe(true)
    // Bodies stay out of the logs.
    expect(h.logs.filter(line => line.text.includes('Final answer.') || line.text.includes('draft'))).toEqual([])
    expect(h.notes).toEqual([])
  })

  it('sends nothing for NO_REPLY, a turn the owner stopped, or a completed turn without text, and says why', async () => {
    const h = await mount()
    const wechat = recorder('wechat')
    h.relay.registerChannel(wechat.channel)
    h.relay.claim('chat-1', 'wechat')
    await turn(h.emit, 'chat-1', ' NO_REPLY\n')
    await turn(h.emit, 'chat-1', 'half an answer', { kind: 'aborted', reason: { kind: 'user' } })
    await turn(h.emit, 'chat-1', undefined)
    expect(wechat.answers).toEqual([])
    expect(h.notes).toEqual([])
    const reasons = h.logs.filter(line => line.type === 'info' && line.text.startsWith('owner-relay: Session chat-1 ended a turn')).map(line => line.text)
    expect(reasons).toEqual([
      'owner-relay: Session chat-1 ended a turn (completed) that answered NO_REPLY; nothing is relayed',
      'owner-relay: Session chat-1 ended a turn (aborted) the owner stopped; nothing is relayed',
      'owner-relay: Session chat-1 ended a turn (completed) without text; nothing is relayed',
    ])
    // Every turn still ends and settles, so typing and per-turn state clear.
    expect(wechat.calls).toEqual(['start:chat-1', 'end:chat-1', 'settled:chat-1', 'start:chat-1', 'end:chat-1', 'settled:chat-1', 'start:chat-1', 'end:chat-1', 'settled:chat-1'])
  })

  it('relays an unfinished turn with a warning and the failure reason', async () => {
    const h = await mount()
    const wechat = recorder('wechat')
    h.relay.registerChannel(wechat.channel)
    h.relay.claim('chat-1', 'wechat')
    await turn(h.emit, 'chat-1', 'partial', { kind: 'aborted', reason: { kind: 'legacy' } })
    await turn(h.emit, 'chat-1', undefined, { kind: 'error', error: { code: 'AUTH', message: '401 User not found.', status: 401 } })
    expect(wechat.answers).toEqual([
      { sessionId: 'chat-1', text: 'partial\n\n⚠️ 本轮未完成（aborted）', outcome: 'aborted' },
      { sessionId: 'chat-1', text: '⚠️ 本轮未完成（error）\n原因：AUTH: 401 User not found.', outcome: 'error', detail: 'AUTH: 401 User not found.' },
    ])
    expect(h.logs.some(line => line.text.startsWith('owner-relay: Session chat-1 ended a turn (error: AUTH: 401 User not found.); relaying'))).toBe(true)
  })

  it('ignores Sessions nobody claimed', async () => {
    const h = await mount()
    const wechat = recorder('wechat')
    h.relay.registerChannel(wechat.channel)
    await turn(h.emit, 'other', 'not mine')
    expect(wechat.calls).toEqual([])
    expect(h.logs.filter(line => line.text.includes('other'))).toEqual([])
  })
})

describe('OwnerRelay claims', () => {
  it('claims, moves, and releases Sessions', async () => {
    const h = await mount()
    const wechat = recorder('wechat')
    const bili = recorder('bili-dm', { fallbackLabel: 'the Bilibili account\'s Session' })
    h.relay.registerChannel(wechat.channel)
    h.relay.registerChannel(bili.channel)
    expect(h.relay.ownerOf('s1')).toBeUndefined()
    h.relay.claim('s1', 'wechat')
    expect(h.relay.ownerOf('s1')).toBe('wechat')
    h.relay.claim('s1', 'bili-dm')
    expect(h.relay.ownerOf('s1')).toBe('bili-dm')
    await turn(h.emit, 's1', 'to bili')
    expect(bili.answers.map(answer => answer.text)).toEqual(['to bili'])
    expect(wechat.answers).toEqual([])
    expect(h.relay.release('s1')).toBe(true)
    expect(h.relay.release('s1')).toBe(false)
    expect(h.relay.ownerOf('s1')).toBeUndefined()
    await turn(h.emit, 's1', 'nobody relays this')
    expect(bili.answers).toHaveLength(1)
  })

  it('releases a channel\'s claims when the channel goes away, and refuses a second channel of the same name', async () => {
    const h = await mount()
    const first = recorder('wechat')
    const dispose = h.relay.registerChannel(first.channel)
    expect(() => h.relay.registerChannel(recorder('wechat').channel)).toThrow('owner-relay: a channel named wechat is already registered')
    h.relay.claim('chat-1', 'wechat')
    h.relay.claim('chat-2', 'wechat')
    dispose()
    expect(h.relay.ownerOf('chat-1')).toBeUndefined()
    expect(h.relay.ownerOf('chat-2')).toBeUndefined()
    const second = recorder('wechat')
    h.relay.registerChannel(second.channel)
    h.relay.claim('chat-1', 'wechat')
    await turn(h.emit, 'chat-1', 'after re-registering')
    expect(second.answers).toHaveLength(1)
    expect(first.answers).toEqual([])
  })

  it('relays nothing for a Session whose channel is not registered, and says so', async () => {
    const h = await mount()
    h.relay.claim('s1', 'bili-dm')
    await turn(h.emit, 's1', 'lost')
    expect(h.notes).toEqual([])
    expect(h.logs.some(line => line.type === 'warn' && line.text === 'owner-relay: Session s1 ended a turn (completed), but its channel bili-dm is not registered; nothing is relayed')).toBe(true)
  })
})

describe('OwnerRelay delivery', () => {
  it('calls onTurnStart before deliver and onTurnSettled only once deliver resolves', async () => {
    const h = await mount()
    let finish: (delivery: RelayDelivery) => void = () => {}
    const wechat = recorder('wechat', { deliver: () => new Promise((resolve) => { finish = resolve }) })
    h.relay.registerChannel(wechat.channel)
    h.relay.claim('chat-1', 'wechat')
    await turn(h.emit, 'chat-1', 'slow')
    expect(wechat.calls).toEqual(['start:chat-1', 'end:chat-1', 'deliver:chat-1'])
    finish('sent')
    await drain()
    expect(wechat.calls).toEqual(['start:chat-1', 'end:chat-1', 'deliver:chat-1', 'settled:chat-1'])
  })

  it('takes a channel\'s kept answer as final: no fallback', async () => {
    const h = await mount()
    const bili = recorder('bili-dm', { fallbackLabel: 'the Bilibili account\'s Session', deliver: async () => 'kept' })
    h.relay.registerChannel(bili.channel)
    h.relay.claim('bili-1', 'bili-dm')
    await turn(h.emit, 'bili-1', 'a Web UI answer')
    expect(bili.answers).toHaveLength(1)
    expect(h.notes).toEqual([])
    expect(h.logs.some(line => line.type === 'info' && line.text === 'owner-relay: bili-dm kept the answer of Session bili-1 in the Session')).toBe(true)
    expect(bili.calls.at(-1)).toBe('settled:bili-1')
  })

  it('falls back to the notifier with the channel\'s label when deliver rejects, then settles', async () => {
    const h = await mount()
    const label = 'the Bilibili account\'s Session (its answer could not go out as a Bilibili message)'
    const bili = recorder('bili-dm', { fallbackLabel: label, deliver: () => Promise.reject(new Error('the write guard failed')) })
    h.relay.registerChannel(bili.channel)
    h.relay.claim('bili-1', 'bili-dm')
    await turn(h.emit, 'bili-1', 'a share')
    expect(h.notes).toEqual([{ title: '↪️ 这条回答没能从原渠道发出，改发这里', body: 'a share\n\n原因：the write guard failed', origin: label }])
    expect(h.logs.some(line => line.type === 'warn' && line.text === 'owner-relay: bili-dm could not deliver the answer of Session bili-1: the write guard failed')).toBe(true)
    expect(h.logs.some(line => line.type === 'info' && line.text === 'owner-relay: sent the answer of Session bili-1 to lsyNotifier instead of bili-dm')).toBe(true)
    expect(bili.calls.at(-1)).toBe('settled:bili-1')
  })

  it('has no fallback for the notifier\'s own channel, nor without a notifier, and survives a failing one', async () => {
    const own = await mount()
    const wechat = recorder('wechat', { deliver: () => Promise.reject(new Error('storage closed')) })
    own.relay.registerChannel(wechat.channel)
    own.relay.claim('chat-1', 'wechat')
    await turn(own.emit, 'chat-1', 'answer')
    expect(own.notes).toEqual([])
    expect(own.logs.some(line => line.text === 'owner-relay: wechat has no fallback label (it is the notifier\'s own channel); the answer of Session chat-1 was not delivered')).toBe(true)
    expect(wechat.calls.at(-1)).toBe('settled:chat-1')

    const bare = await mount({ notifier: false })
    bare.relay.registerChannel(recorder('bili-dm', { fallbackLabel: 'x', deliver: () => Promise.reject(new Error('down')) }).channel)
    bare.relay.claim('bili-1', 'bili-dm')
    await turn(bare.emit, 'bili-1', 'answer')
    expect(bare.logs.some(line => line.text === 'owner-relay: no lsyNotifier is mounted; the answer of Session bili-1 was not delivered')).toBe(true)

    const failing = await mount({ notifier: () => Promise.reject(new Error('wechat down')) })
    const bili = recorder('bili-dm', { fallbackLabel: 'x', deliver: () => Promise.reject(new Error('down')) })
    failing.relay.registerChannel(bili.channel)
    failing.relay.claim('bili-1', 'bili-dm')
    await turn(failing.emit, 'bili-1', 'answer')
    expect(failing.logs.some(line => line.text === 'owner-relay: the fallback of Session bili-1 failed too: wechat down')).toBe(true)
    expect(bili.calls.at(-1)).toBe('settled:bili-1')
  })

  it('keeps relaying when a channel hook throws', async () => {
    const h = await mount()
    const answers: string[] = []
    h.relay.registerChannel({
      name: 'wechat',
      deliver: async (answer) => { answers.push(answer.text); return 'sent' },
      onTurnStart: () => { throw new Error('typing broke') },
    })
    h.relay.claim('chat-1', 'wechat')
    await turn(h.emit, 'chat-1', 'still relayed')
    expect(answers).toEqual(['still relayed'])
    expect(h.logs.some(line => line.type === 'warn' && line.text === 'owner-relay: wechat onTurnStart failed for Session chat-1: typing broke')).toBe(true)
  })
})
