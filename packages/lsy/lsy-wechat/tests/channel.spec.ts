import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import type { SessionCreateRequest, SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import WechatChannel, { Config, type ChatConfig } from '../src/index.ts'
import type { WechatAccount } from '../src/login.ts'
import { wechatDomain } from '../src/storage.ts'
import { FakeIlink, textMessage } from './fake-ilink.ts'

const OWNER = 'owner@im.wechat'
const TOKEN = 'bot-token-secret'
const FOOTER = '\n\n（消息额度已用完，回复任意消息继续接收）'

/** A log line the channel wrote. */
interface LogLine {
  type: string
  text: string
}

/** Session Controller double: Sessions are live once created unless told otherwise. */
function fakeSessions(onPrompt: () => void = () => {}) {
  const state = {
    created: [] as SessionCreateRequest[],
    prompts: [] as SessionPromptRequest[],
    live: new Set<string>(),
    /** Error code resolveAgent returns for one Session id. */
    errors: new Map<string, string>(),
    /** Newly created Sessions fail to resolve. */
    brokenCreate: false,
    promptError: undefined as unknown,
    /** Prompts wait for their abort signal. */
    holdPrompts: false,
    onPrompt,
  }
  const controller = {
    create: async (request: SessionCreateRequest) => {
      state.created.push(request)
      const sessionId = `chat-${state.created.length}`
      if (!state.brokenCreate) state.live.add(sessionId)
      return { sessionId }
    },
    resolveAgent: async (sessionId: string) => {
      const code = state.errors.get(sessionId) ?? (state.live.has(sessionId) ? undefined : 'session/not-found')
      return code === undefined
        ? { agent: { session: { id: sessionId } } }
        : { error: Object.assign(new Error(`${code}: ${sessionId}`), { code }) }
    },
    prompt: async (request: SessionPromptRequest, signal: AbortSignal) => {
      state.prompts.push(request)
      state.onPrompt()
      if (state.promptError !== undefined) throw state.promptError
      if (state.holdPrompts) {
        await new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { reject(new Error('prompt aborted')) }) })
      }
      return { accepted: true }
    },
  }
  return { state, controller }
}

let dir: string
const contexts: Context[] = []
const allLogs: LogLine[] = []

function writeAccount(path: string, overrides: Partial<WechatAccount> = {}): void {
  const account: WechatAccount = {
    botToken: TOKEN,
    botId: 'bot@im.bot',
    baseUrl: 'https://ilink.test',
    ownerUserId: OWNER,
    boundAt: '2026-10-21T00:00:00.000Z',
    ...overrides,
  }
  writeFileSync(path, JSON.stringify(account))
}

/** Mount the memory storage backend and the domain facility on `ctx`. */
async function mountStorage(ctx: Context, pool: MemoryMediaPool): Promise<DomainFacility> {
  await ctx.plugin(Timer)
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  ctx.effect(() => async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => { await facility.closeAll(); unmount() }
  })
  return facility
}

type ConfigOverrides = Partial<Omit<Config, 'chat'>> & { chat?: Partial<ChatConfig> }

/** Resolve loose configuration input through the schema, as the plugin loader does. */
function resolveConfig(input: Record<string, unknown>): Config {
  return Config(input as never)
}

async function harness(options: {
  config?: ConfigOverrides
  pool?: MemoryMediaPool
  account?: Partial<WechatAccount> | false
  ilink?: FakeIlink
  sessions?: ReturnType<typeof fakeSessions>
  /** Leave `accountFile` unset so the channel derives it from DSH_HOME. */
  defaultAccountFile?: boolean
} = {}) {
  const ilink = options.ilink ?? new FakeIlink()
  vi.stubGlobal('fetch', ilink.fetch)
  const accountFile = join(dir, 'account.json')
  if (options.account !== false) writeAccount(accountFile, options.account)
  const ctx = new Context()
  contexts.push(ctx)
  const logs: LogLine[] = []
  ctx.logger.exporter({
    // Every severity, debug included.
    levels: { default: 3 },
    export: (message) => {
      const line = { type: message.type, text: String(message.args[0]) }
      logs.push(line)
      allLogs.push(line)
    },
  })
  const pool = options.pool ?? new MemoryMediaPool()
  await mountStorage(ctx, pool)
  const sentAtPrompt: number[] = []
  const sessions = options.sessions ?? fakeSessions()
  sessions.state.onPrompt = () => { sentAtPrompt.push(ilink.sent.length) }
  ctx.provide('sessionController', sessions.controller as never)
  const presets = {
    resolve: vi.fn((name: string) => {
      if (name === 'missing') throw new Error('permission: unknown preset "missing"')
      return {}
    }),
    set: vi.fn(),
  }
  ctx.provide('permissionPresets', presets as never)
  const titles = { rename: vi.fn() }
  ctx.provide('sessionTitle', titles as never)
  const { chat, ...rest } = options.config ?? {}
  const config: Config = {
    ...(options.defaultAccountFile === true ? {} : { accountFile }),
    chat: { workspacePath: join(dir, 'work'), agentPreset: 'unattended', permissionPreset: 'danger-full-access', title: '微信', timeZone: 'America/New_York', ...chat },
    maxMessageChars: 3000,
    maxReplyParts: 3,
    repliesPerToken: 10,
    contextTtlMs: 84_600_000,
    outboxLimit: 50,
    accountPollMs: 30_000,
    longPollTimeoutMs: 35_000,
    requestTimeoutMs: 15_000,
    ...rest,
  }
  await ctx.plugin(WechatChannel, config)
  await vi.advanceTimersByTimeAsync(0)
  const channel = ctx.lsyNotifier as WechatChannel
  const emit = (sessionId: string, event: unknown): void => { (ctx.emit as (...args: unknown[]) => void)('session/event', { id: sessionId }, event) }
  /** Deliver one owner message through the long-poll and let the channel handle it. */
  const ownerSays = async (text: string, token = `ctx-${text}`): Promise<void> => {
    ilink.updates([textMessage(OWNER, text, token)])
    await vi.advanceTimersByTimeAsync(0)
  }
  /** Finish one turn of a Session with a final assistant text. */
  const finishTurn = async (sessionId: string, text: string | undefined, kind = 'completed'): Promise<void> => {
    if (text !== undefined) emit(sessionId, assistant(text))
    emit(sessionId, { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind } } })
    await vi.advanceTimersByTimeAsync(0)
  }
  return {
    ctx, channel, ilink, sessions: sessions.state, presets, titles, logs, emit, ownerSays, finishTurn, accountFile, pool, sentAtPrompt,
  }
}

function assistant(text: string): unknown {
  return { type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } } }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lsy-wechat-channel-'))
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-21T18:00:00.000Z'))
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
  // The bot token must never reach a log line.
  expect(allLogs.splice(0).filter(line => line.text.includes(TOKEN))).toEqual([])
})

describe('WechatChannel chat', () => {
  it('forwards an owner message into a new chat Session and relays the final answer', async () => {
    const h = await harness()
    await h.ownerSays('hello')
    expect(h.sessions.created).toEqual([{ cwd: join(dir, 'work'), agentPreset: 'unattended' }])
    expect(existsSync(join(dir, 'work'))).toBe(true)
    expect(h.presets.set).toHaveBeenCalledWith({ id: 'chat-1' }, 'danger-full-access')
    expect(h.titles.rename).toHaveBeenCalledWith({ id: 'chat-1' }, '微信')
    expect(h.sessions.prompts).toEqual([{
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      sessionId: 'chat-1',
      mode: 'queue',
      content: [{ type: 'text', text: 'hello' }],
      clientTimeZone: 'America/New_York',
    }])
    expect(h.channel.ownsSession('chat-1')).toBe(true)
    expect(h.channel.ownsSession('other')).toBe(false)

    h.emit('chat-1', assistant('draft'))
    h.emit('chat-1', { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'thinking', thinking: 'hm' }] } } })
    h.emit('chat-1', { type: 'tool/result', seq: 3, data: {} })
    await h.finishTurn('chat-1', 'Final answer.')
    expect(h.ilink.sent).toEqual([{ to: OWNER, text: 'Final answer.', contextToken: 'ctx-hello' }])
    expect(h.logs.some(line => line.text === 'lsy-wechat: created chat Session chat-1 in ' + join(dir, 'work') + ' (unattended, danger-full-access)')).toBe(true)
    // Bodies stay out of info logs.
    expect(h.logs.filter(line => line.text.includes('Final answer.'))).toEqual([])

    // The next long-poll carries the persisted cursor.
    expect(h.ilink.requestsTo('ilink/bot/getupdates').map(request => (request.body as { get_updates_buf: string }).get_updates_buf)).toEqual(['', 'buf-1'])
  })

  it('reuses the chat Session across messages and restarts', async () => {
    const pool = new MemoryMediaPool()
    const sessions = fakeSessions()
    const first = await harness({ pool, sessions })
    await first.ownerSays('one')
    await first.ownerSays('two')
    await first.ctx.fiber.dispose()

    const ilink = new FakeIlink()
    const second = await harness({ pool, sessions, ilink })
    expect((ilink.requests[0]!.body as { get_updates_buf: string }).get_updates_buf).toBe('buf-2')
    expect(second.channel.ownsSession('chat-1')).toBe(true)
    await second.ownerSays('three')
    expect(sessions.state.created).toHaveLength(1)
    expect(sessions.state.prompts.map(prompt => [prompt.sessionId, prompt.content])).toEqual([
      ['chat-1', [{ type: 'text', text: 'one' }]],
      ['chat-1', [{ type: 'text', text: 'two' }]],
      ['chat-1', [{ type: 'text', text: 'three' }]],
    ])
  })

  it('starts a new chat Session when the stored one no longer resolves', async () => {
    const h = await harness()
    await h.ownerSays('one')
    h.sessions.live.delete('chat-1')
    await h.ownerSays('two')
    expect(h.sessions.prompts.map(prompt => prompt.sessionId)).toEqual(['chat-1', 'chat-2'])
    expect(h.logs.some(line => line.text === 'lsy-wechat: chat Session chat-1 is unavailable (session/not-found); starting a new one')).toBe(true)
    expect(h.channel.ownsSession('chat-1')).toBe(true)
  })

  it('keeps the chat Session on a transient resolve failure and tells the owner', async () => {
    const h = await harness()
    await h.ownerSays('one')
    h.sessions.errors.set('chat-1', 'session/writer-held')
    await h.ownerSays('two')
    expect(h.sessions.created).toHaveLength(1)
    expect(h.ilink.sent.map(sent => sent.text)).toEqual(['⚠️ 消息没能交给 agent：session/writer-held: chat-1'])
    h.sessions.errors.delete('chat-1')
    await h.ownerSays('three')
    expect(h.sessions.prompts.map(prompt => prompt.sessionId)).toEqual(['chat-1', 'chat-1'])
  })

  it('reports failed prompts, failed creations, and unknown presets to the owner', async () => {
    const h = await harness()
    h.sessions.promptError = new Error('prompt rejected')
    await h.ownerSays('one')
    h.sessions.promptError = 'plain failure'
    await h.ownerSays('one again')
    h.sessions.promptError = undefined
    h.sessions.live.delete('chat-1')
    h.sessions.brokenCreate = true
    await h.ownerSays('two')
    expect(h.ilink.sent.map(sent => sent.text)).toEqual([
      '⚠️ 消息没能交给 agent：prompt rejected',
      '⚠️ 消息没能交给 agent：plain failure',
      '⚠️ 消息没能交给 agent：session/not-found: chat-2',
    ])
    expect(h.logs.some(line => line.type === 'warn' && line.text === 'lsy-wechat: forwarding the owner message failed: prompt rejected')).toBe(true)

    const presetless = await harness({ config: { chat: { permissionPreset: 'missing' } } })
    await presetless.ownerSays('three')
    expect(presetless.sessions.created).toEqual([])
    expect(presetless.ilink.sent.map(sent => sent.text)).toEqual(['⚠️ 消息没能交给 agent：permission: unknown preset "missing"'])
  })

  it('accepts only user messages from the owner', async () => {
    const h = await harness()
    h.ilink.updates([
      textMessage('stranger@im.wechat', 'hi'),
      { message_type: 1, item_list: [{ type: 1, text_item: { text: 'anonymous' } }] },
      textMessage(OWNER, 'echo', 'ctx-echo', { message_type: 2 }),
      { from_user_id: OWNER },
    ])
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sessions.prompts).toEqual([])
    expect(h.ilink.requestsTo('ilink/bot/sendmessage')).toEqual([])
    expect(h.logs.filter(line => line.text.includes('who is not the owner')).map(line => line.text)).toEqual([
      'lsy-wechat: dropped a message from stranger@im.wechat, who is not the owner',
      'lsy-wechat: dropped a message from an unknown user, who is not the owner',
    ])
    // A stranger's message opened no reply window.
    await h.channel.send({ title: 'note' })
    expect(h.channel.outbox()).toHaveLength(1)
  })

  it('opens a reply window for a message with nothing to forward', async () => {
    const h = await harness()
    h.ilink.updates([{ from_user_id: OWNER, message_type: 1, context_token: 'ctx-sticker', item_list: [{ type: 99 }] }])
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sessions.prompts).toEqual([])
    await h.channel.send({ title: 'note' })
    expect(h.ilink.sent).toEqual([{ to: OWNER, text: 'note', contextToken: 'ctx-sticker' }])
  })

  it('starts a fresh chat on /new and keeps relaying earlier chat Sessions', async () => {
    const h = await harness()
    await h.ownerSays('/new')
    await h.ownerSays('one')
    await h.ownerSays(' /new ')
    await h.ownerSays('two')
    expect(h.sessions.prompts.map(prompt => prompt.sessionId)).toEqual(['chat-1', 'chat-2'])
    expect(h.ilink.sent.map(sent => sent.text)).toEqual(['已开始新对话。', '已开始新对话。'])
    expect(h.logs.filter(line => line.text === 'lsy-wechat: owner started a new chat')).toHaveLength(1)
    expect(h.channel.ownsSession('chat-1')).toBe(true)
    await h.finishTurn('chat-1', 'late answer')
    expect(h.ilink.sent.at(-1)!.text).toBe('late answer')
  })

  it('stays silent for NO_REPLY and empty turns and reports unfinished ones', async () => {
    const h = await harness()
    await h.ownerSays('one')
    await h.finishTurn('chat-1', 'NO_REPLY')
    await h.finishTurn('chat-1', undefined)
    await h.finishTurn('chat-1', undefined, 'error')
    await h.finishTurn('chat-1', 'partial', 'aborted')
    await h.finishTurn('other-session', 'not mine')
    expect(h.ilink.sent.map(sent => sent.text)).toEqual(['⚠️ 本轮未完成（error）', 'partial\n\n⚠️ 本轮未完成（aborted）'])
  })

  it('tells the owner and the log why a turn failed', async () => {
    const h = await harness()
    await h.ownerSays('one')
    h.emit('chat-1', { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'error', error: { code: 'AUTH', message: '401 User not found.', status: 401 } } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.ilink.sent.map(sent => sent.text)).toEqual(['⚠️ 本轮未完成（error）\n原因：AUTH: 401 User not found.'])
    expect(h.logs.some(line => line.text.startsWith('lsy-wechat: Session chat-1 ended a turn (error: AUTH: 401 User not found.); relaying'))).toBe(true)
  })

  it('splits long replies into labeled parts', async () => {
    const h = await harness({ config: { maxMessageChars: 200 } })
    await h.ownerSays('one')
    await h.finishTurn('chat-1', 'x'.repeat(400))
    expect(h.ilink.sent.map(sent => sent.text.slice(0, 6))).toEqual(['[1/3]\n', '[2/3]\n', '[3/3]\n'])
    for (const sent of h.ilink.sent) expect(Array.from(sent.text).length).toBeLessThanOrEqual(200)
  })
})

describe('WechatChannel delivery', () => {
  it('queues notes until the owner writes, then sends them as a digest before forwarding', async () => {
    const h = await harness()
    await h.channel.send({ title: 'Release v1', body: 'notes', url: 'https://example.com/v1' })
    await h.channel.send({ title: 'Release v2' })
    expect(h.channel.outbox().map(row => row.text)).toEqual(['Release v1\n\nnotes\n\nhttps://example.com/v1', 'Release v2'])
    expect(h.logs.some(line => line.text === 'lsy-wechat: queued 41 chars (the owner has not written yet); 1 waiting')).toBe(true)

    await h.ownerSays('hi')
    expect(h.ilink.sent).toHaveLength(1)
    expect(h.ilink.sent[0]!.text).toBe([
      '📬 未送达的 2 条消息',
      '──────── 10/21 14:00\nRelease v1\n\nnotes\n\nhttps://example.com/v1',
      '──────── 10/21 14:00\nRelease v2',
    ].join('\n\n'))
    expect(h.sentAtPrompt).toEqual([1])
    expect(h.channel.outbox()).toEqual([])
  })

  it('sends several digests but keeps the last slot for the reply', async () => {
    const h = await harness({ config: { maxMessageChars: 200, repliesPerToken: 3 } })
    for (const n of [1, 2, 3, 4]) await h.channel.send({ title: `${n}`.repeat(150) })
    await h.ownerSays('hi')
    expect(h.ilink.sent).toHaveLength(2)
    expect(h.channel.outbox().map(row => row.text[0])).toEqual(['3', '4'])
    await h.finishTurn('chat-1', 'reply')
    expect(h.ilink.sent.at(-1)!.text).toBe(`reply${FOOTER}`)
  })

  it('marks the last slot with a footer and queues once the quota is used up', async () => {
    const h = await harness({ config: { repliesPerToken: 2 } })
    await h.ownerSays('hi')
    await h.channel.send({ title: 'a' })
    await h.channel.send({ title: 'b' })
    await h.channel.send({ title: 'c' })
    expect(h.ilink.sent.map(sent => sent.text)).toEqual(['a', `b${FOOTER}`])
    expect(h.channel.outbox().map(row => row.text)).toEqual(['c'])
    expect(h.logs.some(line => line.text.includes('(reply quota used up)'))).toBe(true)

    await h.ownerSays('again')
    expect(h.ilink.sent.at(-1)!.text).toContain('📬 未送达的 1 条消息')
    expect(h.ilink.sent.at(-1)!.contextToken).toBe('ctx-again')
  })

  it('queues once the reply window expires', async () => {
    const h = await harness({ config: { contextTtlMs: 60_000 } })
    await h.ownerSays('hi')
    await vi.advanceTimersByTimeAsync(61_000)
    await h.channel.send({ title: 'late' })
    expect(h.ilink.sent).toEqual([])
    expect(h.logs.some(line => line.text.includes('(reply window expired)'))).toBe(true)
  })

  it('closes the window on ret -2 and keeps the text', async () => {
    const h = await harness()
    await h.ownerSays('hi')
    h.ilink.reply('ilink/bot/sendmessage', { body: { ret: -2, errmsg: 'quota' } })
    await h.channel.send({ title: 'a' })
    await h.channel.send({ title: 'b' })
    expect(h.ilink.requestsTo('ilink/bot/sendmessage')).toHaveLength(1)
    expect(h.channel.outbox().map(row => row.text)).toEqual(['a', 'b'])
    expect(h.logs.some(line => line.text.includes('(rejected by WeChat (ret -2))'))).toBe(true)
    await h.ownerSays('again')
    expect(h.ilink.sent.map(sent => sent.text.startsWith('📬 未送达的 2 条消息'))).toEqual([true])
  })

  it('queues on network failures and keeps the window open', async () => {
    const h = await harness()
    await h.ownerSays('hi')
    h.ilink.reply('ilink/bot/sendmessage', new TypeError('fetch failed'))
    await h.channel.send({ title: 'a' })
    await h.channel.send({ title: 'b' })
    expect(h.ilink.sent.map(sent => sent.text)).toEqual(['b'])
    expect(h.channel.outbox().map(row => row.text)).toEqual(['a'])
    expect(h.logs.some(line => line.type === 'warn' && line.text === 'lsy-wechat: send failed: iLink ilink/bot/sendmessage: request failed: fetch failed')).toBe(true)
  })

  it('stops flushing when a digest fails', async () => {
    const h = await harness()
    await h.channel.send({ title: 'a' })
    h.ilink.reply('ilink/bot/sendmessage', new TypeError('fetch failed'))
    await h.ownerSays('hi')
    expect(h.channel.outbox().map(row => row.text)).toEqual(['a'])
    expect(h.sessions.prompts).toHaveLength(1)
  })

  it('drops the oldest texts beyond outboxLimit', async () => {
    const h = await harness({ config: { outboxLimit: 2 } })
    for (const title of ['a', 'b', 'c']) await h.channel.send({ title })
    expect(h.channel.outbox().map(row => row.text)).toEqual(['b', 'c'])
    expect(h.logs.some(line => line.type === 'warn' && line.text === 'lsy-wechat: outbox full; dropped the 1 oldest text(s)')).toBe(true)
  })

  it('queues replies to a message without a context token', async () => {
    const h = await harness()
    await h.channel.send({ title: 'queued' })
    h.ilink.updates([{ from_user_id: OWNER, message_type: 1, item_list: [{ type: 1, text_item: { text: 'hi' } }] }])
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sessions.prompts).toHaveLength(1)
    await h.finishTurn('chat-1', 'answer')
    expect(h.ilink.sent).toEqual([])
    expect(h.channel.outbox().map(row => row.text)).toEqual(['queued', 'answer'])
  })

  it('logs a relay whose storage write fails', async () => {
    const h = await harness()
    await h.ownerSays('hi')
    await vi.advanceTimersByTimeAsync(0)
    h.ilink.reply('ilink/bot/sendmessage', new TypeError('fetch failed'))
    h.pool.failNextWrites = 1
    await h.finishTurn('chat-1', 'answer')
    expect(h.logs.some(line => line.type === 'warn' && line.text.startsWith('lsy-wechat: background work failed:'))).toBe(true)
  })
})

describe('WechatChannel account', () => {
  it('waits for the account file and picks it up without a restart', async () => {
    const h = await harness({ account: false })
    await h.channel.send({ title: 'early' })
    expect(h.ilink.requests).toEqual([])
    expect(h.logs.filter(line => line.text.startsWith('lsy-wechat: no account at'))).toHaveLength(1)
    expect(h.logs.some(line => line.text.includes('(no bound account)'))).toBe(true)

    writeFileSync(h.accountFile, '{"botToken":')
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.logs.filter(line => line.type === 'warn' && line.text.endsWith('is unusable: not valid JSON'))).toHaveLength(1)

    writeAccount(h.accountFile)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.ilink.requestsTo('ilink/bot/getupdates')[0]!.headers['authorization']).toBe(`Bearer ${TOKEN}`)
    expect(h.logs.some(line => line.text === `lsy-wechat: bot bot@im.bot active for owner ${OWNER}`)).toBe(true)
  })

  it('pauses on a stale token and resumes with a new login', async () => {
    const h = await harness()
    await h.ownerSays('hi')
    h.ilink.reply('ilink/bot/getupdates', { body: { ret: -14, errmsg: 'session timeout' } })
    await vi.advanceTimersByTimeAsync(0)
    const polls = h.ilink.requestsTo('ilink/bot/getupdates').length
    await vi.advanceTimersByTimeAsync(90_000)
    expect(h.ilink.requestsTo('ilink/bot/getupdates')).toHaveLength(polls)
    expect(h.logs.filter(line => line.type === 'error' && line.text.includes('is stale (errcode -14)'))).toHaveLength(1)
    await h.channel.send({ title: 'while stale' })
    expect(h.channel.outbox().map(row => row.text)).toEqual(['while stale'])

    writeAccount(h.accountFile, { botToken: 'fresh-token', boundAt: '2026-10-21T19:00:00.000Z' })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.ilink.requestsTo('ilink/bot/getupdates').at(-1)!.headers['authorization']).toBe('Bearer fresh-token')
  })

  it('marks the token stale when a send reports -14', async () => {
    const h = await harness()
    await h.ownerSays('hi')
    h.ilink.reply('ilink/bot/sendmessage', { body: { ret: -14 } })
    await h.channel.send({ title: 'a' })
    expect(h.channel.outbox().map(row => row.text)).toEqual(['a'])
    // The held long-poll then also reports -14; the error is logged once.
    h.ilink.reply('ilink/bot/getupdates', { body: { errcode: -14 } })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.logs.filter(line => line.type === 'error')).toHaveLength(1)
    await h.channel.send({ title: 'b' })
    expect(h.logs.some(line => line.text.includes('(bot token is stale)'))).toBe(true)
  })

  it('reads the default account file under DSH_HOME', async () => {
    vi.stubEnv('DSH_HOME', dir)
    const h = await harness({ account: false, defaultAccountFile: true })
    expect(h.logs.some(line => line.text.startsWith(`lsy-wechat: no account at ${join(dir, 'lsy-wechat', 'account.json')}`))).toBe(true)
  })
})

describe('WechatChannel long-poll', () => {
  it('backs off after failures and recovers', async () => {
    const h = await harness()
    h.ilink.reply('ilink/bot/getupdates', { status: 500 }, new TypeError('fetch failed'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.logs.filter(line => line.type === 'warn').map(line => line.text)).toEqual([
      'lsy-wechat: long-poll failed (1 in a row): iLink ilink/bot/getupdates: HTTP 500; retrying in 2s',
    ])
    await vi.advanceTimersByTimeAsync(2000)
    expect(h.logs.filter(line => line.type === 'warn').at(-1)!.text).toBe('lsy-wechat: long-poll failed (2 in a row): iLink ilink/bot/getupdates: request failed: fetch failed; retrying in 4s')
    await vi.advanceTimersByTimeAsync(4000)
    await h.ownerSays('back')
    expect(h.sessions.prompts).toHaveLength(1)
  })

  it('uses the server-suggested long-poll deadline and keeps an unchanged cursor', async () => {
    const h = await harness()
    h.ilink.reply('ilink/bot/getupdates', { body: { ret: 0, msgs: [{ message_type: 'x' }], get_updates_buf: 'same', longpolling_timeout_ms: 5000 } })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.logs.some(line => line.text === 'lsy-wechat: dropped 1 malformed message(s)')).toBe(true)
    const polls = h.ilink.requestsTo('ilink/bot/getupdates').length
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.ilink.requestsTo('ilink/bot/getupdates')).toHaveLength(polls + 1)
    h.ilink.reply('ilink/bot/getupdates', { body: { ret: 0, get_updates_buf: 'same' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.ilink.requestsTo('ilink/bot/getupdates').at(-1)!.body).toMatchObject({ get_updates_buf: 'same' })
  })

  it('aborts the in-flight long-poll and a pending prompt on shutdown', async () => {
    const h = await harness()
    h.sessions.holdPrompts = true
    await h.ownerSays('hi')
    expect(h.ilink.waiting('ilink/bot/getupdates')).toBe(0)
    await h.ctx.fiber.dispose()
    expect(h.ilink.requestsTo('ilink/bot/sendmessage')).toEqual([])

    const idle = await harness()
    expect(idle.ilink.waiting('ilink/bot/getupdates')).toBe(1)
    await idle.ctx.fiber.dispose()
    expect(idle.ilink.waiting('ilink/bot/getupdates')).toBe(0)
  })

  it('reads as empty before its storage domain opens', async () => {
    // Not registered for teardown: disposal would wait for the never-opening domain.
    const ctx = new Context()
    ctx.provide('storageDomain', { open: () => new Promise(() => {}) } as never)
    for (const name of ['sessionController', 'permissionPresets', 'sessionTitle']) ctx.provide(name, {} as never)
    await ctx.plugin(WechatChannel, resolveConfig({ accountFile: join(dir, 'account.json'), chat: { workspacePath: dir } }))
    const channel = ctx.lsyNotifier as WechatChannel
    expect(channel.ownsSession('chat-1')).toBe(false)
    expect(channel.outbox()).toEqual([])
  })
})

describe('WechatChannel chat Session bookkeeping', () => {
  it('remembers at most 200 chat Sessions', async () => {
    const pool = new MemoryMediaPool()
    const seedCtx = new Context()
    const facility = await mountStorage(seedCtx, pool)
    await vi.advanceTimersByTimeAsync(0)
    const domain = await facility.open(wechatDomain)
    for (let n = 0; n < 200; n += 1) await domain.table('sessions').put(`old-${n}`, { ownerUserId: OWNER, createdAt: n })
    await domain.close()
    await seedCtx.fiber.dispose()

    const h = await harness({ pool })
    expect(h.channel.ownsSession('old-0')).toBe(true)
    await h.ownerSays('hi')
    expect(h.channel.ownsSession('chat-1')).toBe(true)
    expect(h.channel.ownsSession('old-0')).toBe(false)
    expect(h.channel.ownsSession('old-1')).toBe(true)
  })
})

describe('WechatChannel configuration', () => {
  it('applies defaults', () => {
    expect(resolveConfig({})).toEqual({
      chat: { workspacePath: '/Users/dsh-runtime/work', agentPreset: 'unattended', permissionPreset: 'danger-full-access', title: '微信', timeZone: 'America/New_York' },
      maxMessageChars: 3000,
      maxReplyParts: 3,
      repliesPerToken: 10,
      contextTtlMs: 84_600_000,
      outboxLimit: 50,
      accountPollMs: 30_000,
      longPollTimeoutMs: 35_000,
      requestTimeoutMs: 15_000,
    })
    expect(() => resolveConfig({ repliesPerToken: 1 })).toThrow()
    expect(() => resolveConfig({ maxMessageChars: 50 })).toThrow()
  })

  it.each([
    ['a relative account file', { accountFile: 'account.json' }, /accountFile must be an absolute path/],
    ['a relative workspace', { chat: { workspacePath: 'work' } }, /chat.workspacePath must be an absolute path/],
    ['a blank title', { chat: { title: ' ' } }, /chat.title must be non-empty/],
    ['an unknown time zone', { chat: { timeZone: 'Mars/Olympus' } }, /chat.timeZone "Mars\/Olympus" is not a valid IANA time zone/],
  ])('rejects %s at load', (_label, overrides: Record<string, unknown>, message) => {
    const base = resolveConfig({ accountFile: '/tmp/account.json' })
    const config = Object.assign({}, base, overrides, { chat: Object.assign({}, base.chat, overrides['chat']) }) as Config
    expect(() => new WechatChannel(new Context(), config)).toThrow(message)
  })
})
