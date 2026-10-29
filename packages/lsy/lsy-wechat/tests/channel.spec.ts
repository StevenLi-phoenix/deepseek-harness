import { createCipheriv } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import type { SessionCreateRequest, SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller'
import OwnerRelay from '@deepseek-ai/dsh-owner-relay'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import WechatChannel, { Config, type ChatConfig } from '../src/index.ts'
import { downloadMedia } from '../src/media.ts'
import type { WechatAccount } from '../src/login.ts'
import { wechatDomain } from '../src/storage.ts'
import { FakeIlink, imageMessage, textMessage } from './fake-ilink.ts'

const OWNER = 'owner@im.wechat'
const TOKEN = 'bot-token-secret'
const CDN = 'https://cdn.test/c2c'
const MEDIA_KEY = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('sticker')])

function encryptMedia(data: Uint8Array): Buffer {
  const cipher = createCipheriv('aes-128-ecb', MEDIA_KEY, null)
  return Buffer.concat([cipher.update(data), cipher.final()])
}
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
    /** Messages injected into chat Sessions, as [sessionId, text]. */
    injected: [] as [string, string][],
    prompts: [] as SessionPromptRequest[],
    /** What reached chat Sessions, in order: `inject:<text>` and `prompt:<text>`. */
    order: [] as string[],
    live: new Set<string>(),
    /** Error code resolveAgent returns for one Session id. */
    errors: new Map<string, string>(),
    /** Newly created Sessions fail to resolve. */
    brokenCreate: false,
    promptError: undefined as unknown,
    /** Errors thrown by the next prompts, one each, before {@link promptError}. */
    promptErrorsOnce: [] as unknown[],
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
        ? { agent: { session: { id: sessionId }, inject: (message: { content: { type: string; text?: string }[] }) => {
          const text = message.content[0]?.text ?? ''
          state.injected.push([sessionId, text])
          state.order.push(`inject:${text}`)
        } } }
        : { error: Object.assign(new Error(`${code}: ${sessionId}`), { code }) }
    },
    prompt: async (request: SessionPromptRequest, signal: AbortSignal) => {
      state.prompts.push(request)
      state.order.push(`prompt:${request.content[0]?.type === 'text' ? request.content[0].text : ''}`)
      state.onPrompt()
      if (state.promptErrorsOnce.length > 0) throw state.promptErrorsOnce.shift()
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
  /** Live root agents the Host registry reports; omitted means no registry. */
  agents?: FakeAgent[]
  /** Session titles by id. */
  titles?: Record<string, string>
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
  const titleById = options.titles ?? {}
  const titleOf = (session: { id: string }): { title: string | undefined } | undefined =>
    (session.id in titleById ? { title: titleById[session.id] } : undefined)
  const titles = { rename: vi.fn(), get: vi.fn(titleOf) }
  ctx.provide('sessionTitle', titles as never)
  if (options.agents !== undefined) {
    const agents = options.agents
    ctx.provide('agents', { roots: () => [...agents], get: (id: string) => agents.find(agent => agent.session.id === id) } as never)
  }
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
    cdnBaseUrl: CDN,
    maxMediaBytes: 4096,
    mediaTimeoutMs: 60_000,
    timeGapMs: 1_800_000,
    ...rest,
  }
  // The relay carries the chat Sessions' answers to the channel, as the event bundle mounts it.
  await ctx.plugin(OwnerRelay)
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

/** A live root agent as the Host registry lists it. */
interface FakeAgent {
  session: { id: string; header: Record<string, unknown> }
  status: 'idle' | 'running'
  cancel: ReturnType<typeof vi.fn>
}

function fakeAgent(id: string, status: 'idle' | 'running'): FakeAgent {
  return { session: { id, header: {} }, status, cancel: vi.fn() }
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
      mode: 'steer',
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
    expect((ilink.requestsTo('ilink/bot/getupdates')[0]!.body as { get_updates_buf: string }).get_updates_buf).toBe('buf-2')
    expect(second.channel.ownsSession('chat-1')).toBe(true)
    await second.ownerSays('three')
    expect(sessions.state.created).toHaveLength(1)
    expect(sessions.state.prompts.map(prompt => [prompt.sessionId, prompt.content])).toEqual([
      ['chat-1', [{ type: 'text', text: 'one' }]],
      ['chat-1', [{ type: 'text', text: 'two' }]],
      ['chat-1', [{ type: 'text', text: 'three' }]],
    ])
  })

  it('recreates a removed workspace before prompting the stored Session', async () => {
    const h = await harness()
    await h.ownerSays('one')
    rmSync(join(dir, 'work'), { recursive: true })
    await h.ownerSays('two')
    expect(h.sessions.created).toHaveLength(1)
    expect(h.sessions.prompts.map(prompt => prompt.sessionId)).toEqual(['chat-1', 'chat-1'])
    expect(existsSync(join(dir, 'work'))).toBe(true)
  })

  it('hands a received image to the Session and keeps a private copy in the inbox', async () => {
    const h = await harness()
    h.ilink.cdn.set('img-1', encryptMedia(PNG))
    h.ilink.updates([imageMessage(OWNER, 'img-1', MEDIA_KEY.toString('hex'))])
    // Downloads write real files, which fake timers cannot advance.
    await vi.waitFor(() => { expect(h.sessions.prompts).toHaveLength(1) })
    const inbox = join(dir, 'work', '.wechat-inbox')
    const [saved] = readdirSync(inbox).filter(name => !name.startsWith('.'))
    expect(saved).toMatch(/^\d{8}-\d{6}-[0-9a-f]{8}-image\.png$/)
    expect(readFileSync(join(inbox, saved!))).toEqual(PNG)
    expect(statSync(join(inbox, saved!)).mode & 0o777).toBe(0o600)
    expect(statSync(inbox).mode & 0o777).toBe(0o700)
    expect(h.sessions.prompts).toHaveLength(1)
    expect(h.sessions.prompts[0]!.content).toEqual([
      { type: 'text', text: `[图片]\n\nWeChat attachments:\n- image (image/png, 15 B) saved at ${join(inbox, saved!)}; it is attached to this message.` },
      { type: 'image', mediaType: 'image/png', data: PNG.toString('base64'), name: 'image.png' },
    ])
    // The CDN never sees the bot token, and the logs never see the CDN parameter.
    expect(h.ilink.requestsTo('cdn/download')[0]!.headers['authorization']).toBeUndefined()
    expect(h.logs.filter(line => line.text.includes('img-1'))).toEqual([])
    expect(h.logs.some(line => line.text === 'lsy-wechat: forwarded 4 chars and 1 image(s) to Session chat-1')).toBe(true)
  })

  it('falls back to the saved path when the Session refuses images', async () => {
    const h = await harness()
    h.sessions.promptErrorsOnce.push(Object.assign(new Error('Model "m" does not support image input.'), { code: 'session/attachment-invalid' }))
    h.ilink.cdn.set('img-2', encryptMedia(PNG))
    h.ilink.updates([imageMessage(OWNER, 'img-2', MEDIA_KEY.toString('hex'))])
    await vi.waitFor(() => { expect(h.sessions.prompts).toHaveLength(2) })
    expect(h.sessions.prompts).toHaveLength(2)
    expect(h.sessions.prompts[1]!.requestId).not.toBe(h.sessions.prompts[0]!.requestId)
    expect(h.sessions.prompts[1]!.content).toEqual([
      { type: 'text', text: expect.stringMatching(/saved at .*-image\.png; the current model does not accept images\.$/) as unknown },
    ])
    expect(h.ilink.sent).toEqual([])
    expect(h.logs.some(line => line.type === 'warn' && line.text.includes('refused the image parts'))).toBe(true)
  })

  it('tells the agent which attachments could not be received and saves the rest', async () => {
    const h = await harness()
    h.ilink.cdn.set('gone', 404)
    h.ilink.cdn.set('doc', encryptMedia(Buffer.from('%PDF-1.7 tiny')))
    const fileKey = Buffer.from(MEDIA_KEY.toString('hex')).toString('base64')
    h.ilink.updates([{
      from_user_id: OWNER, message_type: 1, context_token: 'ctx-mixed',
      item_list: [
        { type: 1, text_item: { text: '看看这两个' } },
        { type: 2, image_item: { aeskey: MEDIA_KEY.toString('hex'), media: { encrypt_query_param: 'gone' } } },
        { type: 4, file_item: { file_name: 'report.pdf', media: { encrypt_query_param: 'doc', aes_key: fileKey } } },
      ],
    }])
    await vi.waitFor(() => { expect(h.sessions.prompts).toHaveLength(1) })
    const [saved] = readdirSync(join(dir, 'work', '.wechat-inbox')).filter(name => !name.startsWith('.'))
    expect(saved).toMatch(/-report\.pdf$/)
    expect(h.sessions.prompts[0]!.content).toEqual([{ type: 'text', text: [
      '看看这两个\n[图片]\n[文件 report.pdf]',
      '',
      'WeChat attachments:',
      '- image could not be received (CDN download failed with HTTP 404); its content is unavailable, so do not look for it on disk.',
      `- file "report.pdf" (application/pdf, 13 B) saved at ${join(dir, 'work', '.wechat-inbox', saved!)}.`,
    ].join('\n') }])
    expect(h.logs.some(line => line.type === 'warn' && line.text === 'lsy-wechat: could not receive image: CDN download failed with HTTP 404')).toBe(true)
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

  it('copies what an earlier chat Session relays into the current one, so a reply has its context', async () => {
    const h = await harness()
    await h.ownerSays('one')
    await h.finishTurn('chat-1', 'first answer')
    await h.ownerSays('/new')
    await h.ownerSays('two')
    await h.finishTurn('chat-2', 'second answer')
    expect(h.sessions.injected).toEqual([])
    // A reminder the first chat Session set up fires after /new: its answer reaches the owner and the current chat.
    await h.finishTurn('chat-1', 'weekly job done')
    expect(h.ilink.sent.at(-1)!.text).toBe('weekly job done')
    expect(h.sessions.injected).toHaveLength(1)
    const [sessionId, text] = h.sessions.injected[0]!
    expect(sessionId).toBe('chat-2')
    expect(text.startsWith('At Wed 2026-10-21 14:00 (America/New_York), '
      + 'an earlier chat Session (before /new; a reminder or monitor it set up) sent the owner this message on WeChat.')).toBe(true)
    expect(text.endsWith('\nweekly job done')).toBe(true)
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
    expect(h.logs.some(line => line.text.startsWith('owner-relay: Session chat-1 ended a turn (error: AUTH: 401 User not found.); relaying'))).toBe(true)
  })

  it('recovers the text of a quoted bot message from what it sent', async () => {
    const h = await harness()
    await h.ownerSays('hi')
    await h.finishTurn('chat-1', 'the disk is at 92%')
    const sentAt = Date.now()
    vi.setSystemTime(new Date('2026-10-21T19:00:00.000Z'))
    await h.channel.send({ title: 'a later note' })
    h.ilink.updates([{ from_user_id: OWNER, message_type: 1, context_token: 'ctx-q', item_list: [
      { type: 1, text_item: { text: '这个怎么办' }, ref_msg: { message_item: { type: 8, create_time_ms: sentAt + 300 } } },
    ] }])
    await vi.advanceTimersByTimeAsync(0)
    const last = h.sessions.prompts.at(-1)!.content[0]
    expect(last).toEqual({ type: 'text', text: '[引用] the disk is at 92%\n这个怎么办' })
  })

  it('replaces unpaired surrogates the server would refuse', async () => {
    const h = await harness()
    await h.ownerSays('one')
    await h.finishTurn('chat-1', 'cut \ud83d here')
    expect(h.ilink.sent.map(sent => sent.text)).toEqual(['cut \ufffd here'])
  })

  it('splits long replies into labeled parts', async () => {
    const h = await harness({ config: { maxMessageChars: 200 } })
    await h.ownerSays('one')
    await h.finishTurn('chat-1', 'x'.repeat(400))
    expect(h.ilink.sent.map(sent => sent.text.slice(0, 6))).toEqual(['[1/3]\n', '[2/3]\n', '[3/3]\n'])
    for (const sent of h.ilink.sent) expect(Array.from(sent.text).length).toBeLessThanOrEqual(200)
  })
})

describe('WechatChannel notes in the chat Session', () => {
  it('copies a note another Session sent into the chat Session without starting a turn', async () => {
    const h = await harness()
    await h.channel.send({ title: 'before any chat' })
    expect(h.sessions.injected).toEqual([])
    await h.ownerSays('hi')
    const prompts = h.sessions.prompts.length
    await h.channel.send({ title: '✅ operator: watch globe errors', body: 'monitor mon-ac1fa1 is running' })
    expect(h.sessions.injected).toHaveLength(1)
    const [sessionId, text] = h.sessions.injected[0]!
    expect(sessionId).toBe('chat-1')
    expect(text).toContain('It is context, not the owner speaking')
    expect(text).toMatch(/^At Wed 2026-10-21 14:00 \(America\/New_York\), another session/)
    expect(text).not.toContain('just')
    expect(text).toContain('✅ operator: watch globe errors\n\nmonitor mon-ac1fa1 is running')
    expect(h.sessions.prompts).toHaveLength(prompts)
  })

  it('names the sender a note gives as its origin, which the owner never sees', async () => {
    const h = await harness()
    await h.ownerSays('hi')
    const origin = 'the Bilibili account\'s Session (its answer could not go out as a Bilibili message)'
    await h.channel.send({ title: '📺 B站：这条没能用 B站私信发出，改发微信', body: 'a share', origin })
    expect(h.ilink.sent.map(sent => sent.text)).toEqual(['📺 B站：这条没能用 B站私信发出，改发微信\n\na share'])
    const [sessionId, text] = h.sessions.injected[0]!
    expect(sessionId).toBe('chat-1')
    expect(text.startsWith(`At Wed 2026-10-21 14:00 (America/New_York), ${origin} sent the owner this message on WeChat.`)).toBe(true)
    expect(text.endsWith('\n📺 B站：这条没能用 B站私信发出，改发微信\n\na share')).toBe(true)
  })
})

describe('WechatChannel messages for the main agent', () => {
  const from = 'the Bilibili account\'s Session (the agent that lives on its own Bilibili account and reads public Bilibili content)'

  it('queues another Session\'s message in the chat Session as untrusted data, after the owner\'s turn', async () => {
    const h = await harness()
    await h.ownerSays('hi')
    const sessionId = await h.channel.tellMainAgent({ text: '人格卡能装 https://www.bilibili.com/video/BV1sTnn6DEWv', from })
    expect(sessionId).toBe('chat-1')
    const prompt = h.sessions.prompts.at(-1)!
    expect(prompt).toMatchObject({ sessionId: 'chat-1', mode: 'queue', clientTimeZone: 'America/New_York' })
    const text = prompt.content[0]?.type === 'text' ? prompt.content[0].text : ''
    expect(text.startsWith(`At Wed 2026-10-21 14:00 (America/New_York), ${from} sent you, the owner's main agent, the message below.`)).toBe(true)
    expect(text).toContain('It is not the owner speaking')
    expect(text).toContain('waits until the owner asks for it here')
    expect(text.endsWith('\n<agent_message trust="untrusted">\n人格卡能装 https://www.bilibili.com/video/BV1sTnn6DEWv\n</agent_message>')).toBe(true)
    expect(h.sessions.created).toHaveLength(1)
    expect(h.logs.some(line => line.text === 'lsy-wechat: queued a 49-char message from another Session for chat Session chat-1')).toBe(true)

    // The turn it starts is a chat turn: its answer goes to the owner like any other.
    await h.finishTurn('chat-1', '猫猫查了人格卡，能装')
    expect(h.ilink.sent.map(sent => sent.text)).toEqual(['猫猫查了人格卡，能装'])
  })

  it('starts the chat Session when the owner has not written yet', async () => {
    const h = await harness()
    expect(await h.channel.tellMainAgent({ text: 'a find', from })).toBe('chat-1')
    expect(h.sessions.created).toMatchObject([{ agentPreset: 'unattended' }])
    expect(h.ctx.ownerRelay.ownerOf('chat-1')).toBe('wechat')
  })

  it('refuses without a bound account, and passes on a refused prompt', async () => {
    const unbound = await harness({ account: false })
    await expect(unbound.channel.tellMainAgent({ text: 'a find', from })).rejects.toThrow('WeChat is not bound yet, so the main agent has no chat')
    expect(unbound.sessions.prompts).toEqual([])
    await unbound.ctx.fiber.dispose()

    const refused = await harness()
    refused.sessions.promptError = new Error('session/agent-busy')
    await expect(refused.channel.tellMainAgent({ text: 'a find', from })).rejects.toThrow('session/agent-busy')
  })
})

describe('WechatChannel typing indicator', () => {
  const turnStart =(h: { emit: (id: string, event: unknown) => void }, id: string): void => {
    h.emit(id, { type: 'turn/start', seq: 2, data: { turn: 1 } })
  }

  it('shows typing while the chat Session works and clears it after the reply', async () => {
    const h = await harness()
    await h.ownerSays('hi')
    expect(h.ilink.requestsTo('ilink/bot/getconfig').map(request => request.body)).toMatchObject([{ ilink_user_id: OWNER, context_token: 'ctx-hi' }])
    expect(h.ilink.typing).toEqual([1])
    turnStart(h, 'chat-1')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.ilink.typing).toEqual([1, 1, 1])
    await h.finishTurn('chat-1', 'hello')
    expect(h.ilink.sent.map(sent => sent.text)).toEqual(['hello'])
    expect(h.ilink.typing).toEqual([1, 1, 1, 2])
    // The cancel follows the reply, so the bubble never disappears before the answer shows.
    const order = h.ilink.requests.map(request => request.endpoint)
    expect(order.lastIndexOf('ilink/bot/sendmessage')).toBeLessThan(order.lastIndexOf('ilink/bot/sendtyping'))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(h.ilink.typing).toEqual([1, 1, 1, 2])
    expect(h.ilink.requestsTo('ilink/bot/getconfig')).toHaveLength(1)
  })

  it('types for a turn the owner did not start and clears it when the turn sends nothing', async () => {
    const h = await harness()
    await h.ownerSays('hi')
    await h.finishTurn('chat-1', 'hello')
    turnStart(h, 'chat-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.ilink.typing).toEqual([1, 2, 1])
    await h.finishTurn('chat-1', 'NO_REPLY')
    expect(h.ilink.typing).toEqual([1, 2, 1, 2])
    expect(h.ilink.sent.map(sent => sent.text)).toEqual(['hello'])
    turnStart(h, 'other-session')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.ilink.typing).toEqual([1, 2, 1, 2])
  })

  it('keeps typing while more messages join a running turn', async () => {
    const h = await harness()
    await h.ownerSays('one')
    turnStart(h, 'chat-1')
    await h.ownerSays('two')
    await vi.advanceTimersByTimeAsync(4_000)
    expect(h.ilink.typing).toEqual([1])
    await h.finishTurn('chat-1', 'both answered')
    expect(h.ilink.typing).toEqual([1, 2])
  })

  it('never lets a typing failure delay or block the reply, and backs off', async () => {
    const h = await harness()
    h.ilink.reply('ilink/bot/getconfig', { body: { ret: -1, errmsg: 'busy' } })
    await h.ownerSays('one')
    await h.finishTurn('chat-1', 'answer one')
    await h.ownerSays('two')
    expect(h.ilink.requestsTo('ilink/bot/getconfig')).toHaveLength(1)
    expect(h.ilink.typing).toEqual([])
    expect(h.ilink.sent.map(sent => sent.text)).toEqual(['answer one'])
    expect(h.logs.filter(line => line.text.startsWith('lsy-wechat: typing unavailable'))).toHaveLength(1)
    await h.finishTurn('chat-1', 'answer two')
    await vi.advanceTimersByTimeAsync(60_000)
    h.ilink.reply('ilink/bot/sendtyping', { body: { ret: -2 } })
    await h.ownerSays('three')
    expect(h.ilink.requestsTo('ilink/bot/getconfig')).toHaveLength(2)
    await h.finishTurn('chat-1', 'answer three')
    expect(h.ilink.sent.map(sent => sent.text)).toEqual(['answer one', 'answer two', 'answer three'])
  })

  it('gives up typing after an hour even when the turn never ends', async () => {
    const h = await harness()
    await h.ownerSays('hi')
    await vi.advanceTimersByTimeAsync(61 * 60_000)
    const sent = h.ilink.typing.length
    expect(h.ilink.typing.at(-1)).toBe(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.ilink.typing).toHaveLength(sent)
  })

  it('fetches a new typing ticket after a day', async () => {
    const h = await harness()
    await h.ownerSays('one')
    await h.finishTurn('chat-1', 'a')
    vi.setSystemTime(new Date('2026-10-22T19:00:00.000Z'))
    await h.ownerSays('two')
    expect(h.ilink.requestsTo('ilink/bot/getconfig').map(request => (request.body as { context_token: string }).context_token)).toEqual(['ctx-one', 'ctx-two'])
  })
})

describe('WechatChannel commands', () => {
  it('answers /help without involving the agent', async () => {
    const h = await harness()
    await h.ownerSays('/help')
    await h.ownerSays(' /HELP ')
    expect(h.sessions.prompts).toEqual([])
    expect(h.ilink.typing).toEqual([])
    const [help] = h.ilink.sent.map(sent => sent.text)
    expect(help).toContain('/stop')
    expect(help).toContain('/new')
    expect(help).toContain('/help')
    expect(h.ilink.sent).toHaveLength(2)
  })

  it('stops every running task on /stop, clears the queue, and reports what it stopped', async () => {
    const chat = fakeAgent('chat-1', 'running')
    const task = fakeAgent('webhook-1', 'running')
    const idle = fakeAgent('webhook-2', 'idle')
    const h = await harness({ agents: [chat, task, idle], titles: { 'webhook-1': 'operator: 重新挂监控' } })
    await h.ownerSays('hi')
    h.emit('chat-1', { type: 'turn/start', seq: 2, data: { turn: 1 } })
    await h.ownerSays('/stop')
    expect(chat.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(task.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(idle.cancel).not.toHaveBeenCalled()
    expect(h.sessions.prompts).toHaveLength(1)
    expect(h.ilink.sent.map(sent => sent.text)).toEqual(['⏹ 已停下 2 个正在运行的任务：\n• 微信对话\n• operator: 重新挂监控\n\n监控和定时提醒不受影响；要停它们，直接告诉我。'])
    expect(h.ilink.typing.at(-1)).toBe(2)
    // The cancelled turn ends as aborted by the user: the /stop answer already said so.
    h.emit('chat-1', assistant('half an answer'))
    h.emit('chat-1', { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.ilink.sent).toHaveLength(1)
    expect(h.logs.some(line => line.text === 'lsy-wechat: /stop cancelled 2 running Session(s): chat-1, webhook-1')).toBe(true)
  })

  it('says so when /stop finds nothing running', async () => {
    const h = await harness({ agents: [fakeAgent('chat-1', 'idle')] })
    await h.ownerSays('/stop')
    const bare = await harness({ ilink: new FakeIlink() })
    await bare.ownerSays('/stop')
    expect(h.ilink.sent.map(sent => sent.text)).toEqual(['现在没有正在运行的任务。'])
    expect(bare.ilink.sent.map(sent => sent.text)).toEqual(['现在没有正在运行的任务。'])
  })

  it('sends nothing for a turn the owner stopped from the Web UI either, but reports any other abort', async () => {
    const h = await harness()
    await h.ownerSays('hi')
    // The Web UI's stop cancels with cause `user`, as /stop does: the owner already knows.
    h.emit('chat-1', { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.ilink.sent).toEqual([])
    h.emit('chat-1', { type: 'turn/end', seq: 12, data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'legacy' } } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.ilink.sent.map(sent => sent.text)).toEqual(['⚠️ 本轮未完成（aborted）'])
  })
})

describe('WechatChannel lifecycle notices', () => {
  it('tells iLink when the bot goes online and offline, clearing typing first', async () => {
    const h = await harness()
    expect(h.ilink.requestsTo('ilink/bot/msg/notifystart')).toHaveLength(1)
    await h.ownerSays('hi')
    await contexts.splice(0).at(0)!.fiber.dispose()
    expect(h.ilink.typing).toEqual([1, 2])
    expect(h.ilink.requestsTo('ilink/bot/msg/notifystop')).toHaveLength(1)
  })

  it('tells the owner when a restart cuts off a chat turn', async () => {
    const h = await harness()
    await h.ownerSays('hi')
    h.emit('chat-1', { type: 'turn/start', seq: 2, data: { turn: 1 } })
    await contexts.splice(0).at(0)!.fiber.dispose()
    expect(h.ilink.sent.map(sent => sent.text)).toEqual(['⚠️ dsh 正在重启，这一轮被打断了，没有完成。重启后（约半分钟）需要的话再发一次。'])
    expect(h.ilink.typing).toEqual([1, 2])

    const quiet = await harness({ ilink: new FakeIlink() })
    await quiet.ownerSays('hi')
    await quiet.finishTurn('chat-1', 'done')
    await contexts.splice(0).at(0)!.fiber.dispose()
    expect(quiet.ilink.sent.map(sent => sent.text)).toEqual(['done'])
  })

  it('logs once when a typing ticket is fetched', async () => {
    const h = await harness()
    await h.ownerSays('one')
    await h.ownerSays('two')
    expect(h.logs.filter(line => line.text === 'lsy-wechat: typing ticket fetched')).toHaveLength(1)
  })

  it('keeps running when a lifecycle notice fails', async () => {
    const ilink = new FakeIlink()
    ilink.reply('ilink/bot/msg/notifystart', new Error('offline'))
    const h = await harness({ ilink })
    await h.ownerSays('hi')
    expect(h.sessions.prompts).toHaveLength(1)
    expect(h.logs.some(line => line.text.startsWith('lsy-wechat: notifystart failed'))).toBe(true)
  })
})

describe('WechatChannel time awareness', () => {
  /** Move the wall clock without firing the long-poll timers. */
  const at = (iso: string): void => { vi.setSystemTime(new Date(iso)) }
  const gapNotices = (h: { sessions: { injected: [string, string][] } }): string[] =>
    h.sessions.injected.map(([, text]) => text).filter(text => text.startsWith('Time check:'))

  it('dates a relayed note and tells the chat Session how long the chat was quiet', async () => {
    const h = await harness()
    await h.ownerSays('hi')
    await h.finishTurn('chat-1', 'hello')
    at('2026-10-22T07:10:00.000Z')
    await h.channel.send({ title: 'host-alerts: 1 event(s)', body: '• Internal 磁盘已用 91.9%' })
    at('2026-10-22T12:49:00.000Z')
    await h.ownerSays('早上好')

    const [note, notice] = h.sessions.injected.map(([, text]) => text)
    expect(note).toMatch(/^At Thu 2026-10-22 03:10 \(America\/New_York\), another session/)
    expect(notice).toBe(
      'Time check: the owner sent the message below at Thu 2026-10-22 08:49 (America/New_York), after 5 h 39 min of silence in this WeChat chat.'
      + ' The last message before it was a note another session (an event, reminder, monitor, or operator task) sent the owner, at Thu 2026-10-22 03:10;'
      + ' the owner last wrote at Wed 2026-10-21 14:00 (18 h 49 min ago).'
      + ' Read the new message on its own terms: it starts a new exchange unless it clearly refers back to something earlier.',
    )
    // The notice reaches the chat Session just before the message it describes.
    expect(h.sessions.order.slice(-2)).toEqual([`inject:${notice!}`, 'prompt:早上好'])
    expect(h.logs.some(line => line.text === 'lsy-wechat: told chat Session chat-1 the chat was quiet for 5 h 39 min')).toBe(true)
  })

  it('adds nothing to the first message or while the chat is active', async () => {
    const h = await harness()
    await h.ownerSays('one')
    await h.finishTurn('chat-1', 'reply one')
    at('2026-10-21T18:25:00.000Z')
    await h.ownerSays('two')
    expect(gapNotices(h)).toEqual([])
    expect(h.sessions.prompts).toHaveLength(2)
  })

  it('measures from the reply, not from a digest flushed by the new message', async () => {
    const h = await harness({ config: { contextTtlMs: 3_600_000 } })
    await h.ownerSays('one')
    await h.finishTurn('chat-1', 'reply one')
    at('2026-10-21T20:00:00.000Z')
    // The window expired: the note waits in the outbox and goes out as a digest when the owner writes.
    await h.channel.send({ title: 'queued note' })
    at('2026-10-21T21:00:00.000Z')
    await h.ownerSays('two')
    expect(h.ilink.sent.at(-1)!.text).toContain('queued note')
    expect(gapNotices(h)).toHaveLength(1)
    expect(gapNotices(h)[0]).toContain('after 3 h of silence')
    expect(gapNotices(h)[0]).toContain('The last message before it was your reply, at Wed 2026-10-21 14:00;')
  })

  it('remembers the chat across a host restart', async () => {
    const pool = new MemoryMediaPool()
    const sessions = fakeSessions()
    const first = await harness({ pool, sessions })
    await first.ownerSays('one')
    await first.finishTurn('chat-1', 'reply one')
    await contexts.splice(0).at(0)!.fiber.dispose()
    at('2026-10-21T20:00:00.000Z')
    const second = await harness({ pool, sessions })
    await second.ownerSays('two')
    expect(gapNotices(second)).toHaveLength(1)
    expect(gapNotices(second)[0]).toContain('after 2 h of silence')
  })

  it('is off with timeGapMs 0', async () => {
    const h = await harness({ config: { timeGapMs: 0 } })
    await h.ownerSays('one')
    at('2026-10-23T18:00:00.000Z')
    await h.ownerSays('two')
    expect(gapNotices(h)).toEqual([])
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
    const diagnosis = /WeChat rejected a send \(ret -2\) of \d+ chars, \d+ bytes, after \d+\/10 sends with this token/
    expect(h.logs.some(line => diagnosis.test(line.text))).toBe(true)
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
    expect(h.logs.some(line => line.type === 'warn' && line.text.startsWith('owner-relay: wechat could not deliver the answer of Session chat-1:'))).toBe(true)
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

  it('claims its chat Sessions with the relay, again after a restart, and releases those it forgets', async () => {
    const pool = new MemoryMediaPool()
    const seedCtx = new Context()
    const facility = await mountStorage(seedCtx, pool)
    await vi.advanceTimersByTimeAsync(0)
    const domain = await facility.open(wechatDomain)
    for (let n = 0; n < 200; n += 1) await domain.table('sessions').put(`old-${n}`, { ownerUserId: OWNER, createdAt: n })
    await domain.close()
    await seedCtx.fiber.dispose()

    const sessions = fakeSessions()
    const first = await harness({ pool, sessions })
    expect(first.ctx.ownerRelay.ownerOf('old-0')).toBe('wechat')
    await first.ownerSays('hi')
    expect(first.ctx.ownerRelay.ownerOf('chat-1')).toBe('wechat')
    expect(first.ctx.ownerRelay.ownerOf('old-0')).toBeUndefined()
    expect(first.ctx.ownerRelay.ownerOf('old-1')).toBe('wechat')
    expect(first.ctx.ownerRelay.ownerOf('other')).toBeUndefined()
    await first.ctx.fiber.dispose()

    const second = await harness({ pool, sessions, ilink: new FakeIlink() })
    expect(second.ctx.ownerRelay.ownerOf('chat-1')).toBe('wechat')
    await second.finishTurn('chat-1', 'after the restart')
    expect(second.logs.some(line => line.text === 'owner-relay: wechat sent the answer of Session chat-1')).toBe(true)
  })
})

describe('WechatChannel sendFile', () => {
  const file = (name: string, data: Uint8Array | string): string => {
    const path = join(dir, name)
    writeFileSync(path, data)
    return path
  }

  it('uploads a picture and sends it to the owner through the open window', async () => {
    const h = await harness()
    await h.ownerSays('来张图')
    const path = file('sticker.png', PNG)
    expect(await h.channel.sendFile(path)).toEqual({ sent: 'image', name: 'sticker.png', bytes: PNG.byteLength })
    const upload = h.ilink.requestsTo('ilink/bot/getuploadurl')[0]!.body as Record<string, unknown>
    expect(upload).toMatchObject({ media_type: 1, to_user_id: OWNER, rawsize: PNG.byteLength, no_need_thumb: true })
    expect(h.ilink.requestsTo('ilink/bot/getuploadurl')[0]!.headers['authorization']).toBe(`Bearer ${TOKEN}`)
    // The CDN never sees the bot token.
    expect(h.ilink.requestsTo('cdn/upload')[0]!.headers['authorization']).toBeUndefined()
    const sent = h.ilink.sentItems.at(-1)!
    expect(sent).toMatchObject({ to: OWNER, contextToken: 'ctx-来张图', item: { type: 2, image_item: { media: { encrypt_query_param: 'dl-1', encrypt_type: 1 } } } })
    // The uploaded bytes decrypt back to the file.
    const media = await downloadMedia(sent.item, { cdnBaseUrl: CDN, maxBytes: 4096, timeoutMs: 5000, fetch: h.ilink.fetch })
    expect(media.data).toEqual(PNG)
    expect(h.logs.some(line => line.text === `lsy-wechat: sent image sticker.png (${PNG.byteLength} bytes) from ${path} (1/10 of this window)`)).toBe(true)
  })

  it('sends documents as files and never queues them', async () => {
    const h = await harness()
    expect(await h.channel.sendFile(file('a.pdf', '%PDF-1.7'))).toEqual({ notSent: 'the owner has not written yet' })
    expect(h.ilink.requestsTo('ilink/bot/getuploadurl')).toEqual([])
    expect(h.channel.outbox()).toEqual([])
    await h.ownerSays('报告')
    expect(await h.channel.sendFile(join(dir, 'a.pdf'))).toEqual({ sent: 'file', name: 'a.pdf', bytes: 8 })
    expect(h.ilink.sentItems.at(-1)!.item).toMatchObject({ type: 4, file_item: { file_name: 'a.pdf', len: '8' } })
  })

  it('keeps the last slot of the window for the text reply', async () => {
    const h = await harness({ config: { repliesPerToken: 2 } })
    await h.ownerSays('两张')
    expect(await h.channel.sendFile(file('one.png', PNG))).toMatchObject({ sent: 'image' })
    expect(await h.channel.sendFile(join(dir, 'one.png'))).toEqual({ notSent: 'reply quota nearly used up; the last message is kept for the text reply' })
    await h.finishTurn('chat-1', '发了')
    expect(h.ilink.sent.at(-1)!.text).toMatch(/^发了/)
  })

  it('refuses what is not a readable regular file within the size limit, before any request', async () => {
    const h = await harness()
    await h.ownerSays('文件')
    expect(await h.channel.sendFile('relative.png')).toEqual({ notSent: 'path must be absolute' })
    expect(await h.channel.sendFile(dir)).toEqual({ notSent: 'not a regular file' })
    expect(await h.channel.sendFile(join(dir, 'missing.png'))).toEqual({ notSent: 'cannot read the file (ENOENT)' })
    expect(await h.channel.sendFile(file('empty.txt', ''))).toEqual({ notSent: 'the file is empty' })
    expect(await h.channel.sendFile(file('big.bin', Buffer.alloc(4097)))).toEqual({ notSent: 'the file exceeds 4096 bytes' })
    expect(h.ilink.requestsTo('ilink/bot/getuploadurl')).toEqual([])
  })

  it('pauses the channel when the token is stale and reports a failed upload', async () => {
    const h = await harness()
    await h.ownerSays('图')
    h.ilink.reply('ilink/bot/getuploadurl', { body: { ret: 5, errmsg: 'busy' } })
    expect(await h.channel.sendFile(file('a.png', PNG))).toEqual({ notSent: 'upload failed: iLink ilink/bot/getuploadurl failed: ret 5, errcode 0 (busy)' })
    h.ilink.reply('ilink/bot/getuploadurl', { body: { ret: -14 } })
    expect(await h.channel.sendFile(join(dir, 'a.png'))).toEqual({ notSent: 'bot token is stale' })
    expect(await h.channel.sendFile(join(dir, 'a.png'))).toEqual({ notSent: 'bot token is stale' })
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
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      maxMediaBytes: 25 * 1024 * 1024,
      mediaTimeoutMs: 60_000,
      timeGapMs: 1_800_000,
    })
    expect(() => resolveConfig({ repliesPerToken: 1 })).toThrow()
    expect(() => resolveConfig({ maxMessageChars: 50 })).toThrow()
  })

  it.each([
    ['a relative account file', { accountFile: 'account.json' }, /accountFile must be an absolute path/],
    ['a relative workspace', { chat: { workspacePath: 'work' } }, /chat.workspacePath must be an absolute path/],
    ['a blank title', { chat: { title: ' ' } }, /chat.title must be non-empty/],
    ['an unknown time zone', { chat: { timeZone: 'Mars/Olympus' } }, /chat.timeZone "Mars\/Olympus" is not a valid IANA time zone/],
    ['a plain-HTTP CDN', { cdnBaseUrl: 'http://cdn.example/c2c' }, /cdnBaseUrl must be an HTTPS URL/],
    ['an unparsable CDN', { cdnBaseUrl: 'not a url' }, /cdnBaseUrl must be an HTTPS URL/],
  ])('rejects %s at load', (_label, overrides: Record<string, unknown>, message) => {
    const base = resolveConfig({ accountFile: '/tmp/account.json' })
    const config = Object.assign({}, base, overrides, { chat: Object.assign({}, base.chat, overrides['chat']) }) as Config
    expect(() => new WechatChannel(new Context(), config)).toThrow(message)
  })
})
