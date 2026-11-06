/** The account service where the happy paths stop: bad configuration, restarts, failing Sessions, odd answers, and refusals. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { biliDomain } from '../src/storage.ts'
import { FakeBiliSvc, replyItem } from './fake-bili-svc.ts'
import { allLogs, contexts, credentialStore, fakeSessions, harness } from './harness.ts'

const OWNER = 200000001
const CAT = 'BV1aa4y1X7aa'
let dir: string
let svc: FakeBiliSvc

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bili-account-'))
  svc = new FakeBiliSvc()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-23T14:00:00.000Z'))
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
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

/** A mount whose first message check has recorded its baseline; the owner's messages are `ownerSays`. */
async function conversing(options: { config?: Record<string, unknown>; sessions?: ReturnType<typeof fakeSessions> } = {}) {
  const sessions = options.sessions ?? fakeSessions()
  const h = await harness({ svc, sessions, workspace: dir, config: { inboxPollMs: 600_000, ...options.config } })
  await vi.advanceTimersByTimeAsync(600_000)
  let key = 6_984_393_491_767_670_000n
  const ownerSays = (text: string): void => {
    key += 1n
    svc.ownerMessages.push({ sender: OWNER, text, key: String(key), at: Math.floor(Date.now() / 1000) })
    svc.unread.follow = 1
  }
  const answer = async (text: string): Promise<void> => {
    h.emit('bili-1', assistant(text))
    h.emit('bili-1', { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.advanceTimersByTimeAsync(1000)
  }
  return { ...h, sessions, ownerSays, answer }
}

/** A private member of the account, to be cast by the caller. */
function member(target: object, name: string): unknown {
  return Reflect.get(target, name)
}

/** The domain a mount opened, for rows a test seeds or reads. */
async function domainOf(h: Awaited<ReturnType<typeof harness>>): Promise<Domain<typeof biliDomain>> {
  return await (member(h.account, 'ready') as Promise<Domain<typeof biliDomain>>)
}

describe('configuration', () => {
  it.each([
    ['a relative workspace', { session: { workspacePath: 'relative/dir' } }, 'bili: session.workspacePath must be an absolute path'],
    ['a blank title', { session: { workspacePath: '/tmp/x', title: '  ' } }, 'bili: session.title must be non-empty'],
    ['an unknown time zone', { timeZone: 'Mars/Olympus' }, 'bili: timeZone "Mars/Olympus" is not a valid IANA time zone'],
    ['an account id bili-svc cannot have', { account: 'Mao Mao' }, 'bili: account "Mao Mao" is not a bili-svc account id'],
  ])('refuses %s at load', async (_name, config, message) => {
    await expect(harness({ svc, workspace: dir, config })).rejects.toThrow(message)
  })
})

describe('start and stop', () => {
  it('drops the queued replies and mentions of the retired design at start and keeps the owner\'s messages', async () => {
    const first = await harness({ svc, workspace: dir })
    const domain = await domainOf(first)
    await domain.table('pending').put('reply:7', { kind: 'reply', id: '7', at: 1, item: { text: '旧' } })
    await domain.table('pending').put('at:8', { kind: 'at', id: '8', at: 2, item: { text: '旧' } })
    await domain.table('pending').put('dm:9', { kind: 'dm', id: '9', at: 3, item: { text: '主人的话' } })
    await first.ctx.fiber.dispose()
    const again = await harness({ svc, workspace: dir, pool: first.pool })
    expect([...(await domainOf(again)).table('pending').keys()]).toEqual(['dm:9'])
    expect(again.logs.some(line => line.text === 'bili: dropped 2 queued reply or mention item(s): replies to strangers are bili-svc\'s (the up preset) now')).toBe(true)
  })

  it('says in its start log that no owner account is set, and answers nothing to the owner', async () => {
    const h = await harness({ svc, workspace: dir, config: { ownerMid: undefined } })
    expect(h.logs.some(line => line.text.endsWith('no owner account set, so no messages are answered'))).toBe(true)
    const reply = member(h.account, 'replyOwner') as (text: string) => Promise<unknown>
    await expect(reply.call(h.account, 'hi')).resolves.toEqual({ status: 'failed', detail: 'no owner account is configured' })
    await vi.advanceTimersByTimeAsync(600_000)
    expect(svc.callsTo('dmMessages')).toEqual([])
    expect(await h.account.popular()).toHaveLength(3)
    expect(await h.view()).toMatchObject({ ownerMid: 0 })
  })

  it('logs background work that fails, whatever it threw, and goes on', async () => {
    const h = await harness({ svc, workspace: dir })
    const track = member(h.account, 'track') as (work: Promise<void>) => void
    track.call(h.account, Promise.reject(new Error('disk gone')))
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error arm is the case under test.
    track.call(h.account, Promise.reject('plain reason'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.logs.some(line => line.type === 'warn' && line.text === 'bili: background work failed: disk gone')).toBe(true)
    expect(h.logs.some(line => line.type === 'warn' && line.text === 'bili: background work failed: plain reason')).toBe(true)
  })

  it('keeps storage work in order after a piece of it failed, and returns held work\'s own outcome', async () => {
    const h = await harness({ svc, workspace: dir })
    const run = member(h.account, 'serialize') as (work: () => Promise<unknown>) => Promise<unknown>
    const serialize = (work: () => Promise<unknown>): Promise<unknown> => run.call(h.account, work)
    await expect(serialize(() => Promise.reject(new Error('disk full')))).rejects.toThrow('disk full')
    await expect(serialize(() => Promise.resolve('next'))).resolves.toBe('next')
    const holder = member(h.account, 'hold') as (work: Promise<unknown>) => Promise<unknown>
    const hold = (work: Promise<unknown>): Promise<unknown> => holder.call(h.account, work)
    await expect(hold(Promise.reject(new Error('delivery failed')))).rejects.toThrow('delivery failed')
    await expect(hold(Promise.resolve('delivered'))).resolves.toBe('delivered')
  })

  it('never runs two message checks at once, even when a turn outlasts the period', async () => {
    const sessions = fakeSessions()
    const prompt = vi.fn((_request: unknown, signal?: AbortSignal) => new Promise<{ accepted: boolean }>((_resolve, reject) => {
      signal?.addEventListener('abort', () => { reject(new Error('stopped')) }, { once: true })
    }))
    sessions.controller.prompt = prompt
    const h = await conversing({ sessions, config: { inboxPollMs: 120_000 } })
    h.ownerSays('一')
    await vi.advanceTimersByTimeAsync(3_000_000)
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('answers only the Sessions it created as its own', async () => {
    const h = await conversing()
    expect(h.account.ownsSession('bili-1')).toBe(false)
    h.ownerSays('hi')
    await vi.advanceTimersByTimeAsync(600_000)
    expect(h.account.ownsSession('bili-1')).toBe(true)
    expect(h.account.ownsSession('bili-9')).toBe(false)
  })

  it('does not claim stored Sessions with the relay once its channel was released before storage answered, and warns when storage fails', async () => {
    const h = await harness({ svc, workspace: dir })
    const domain = await domainOf(h)
    const relay = h.ctx.ownerRelay
    const unregister = vi.fn()
    vi.spyOn(relay, 'registerChannel').mockReturnValue(unregister)
    const claim = vi.spyOn(relay, 'claim')
    const join = (ready: Promise<unknown>): (() => void) => {
      Reflect.set(h.account, 'ready', ready)
      return (member(h.account, 'joinRelay') as (child: typeof h.ctx) => () => void).call(h.account, h.ctx)
    }
    let open: (value: unknown) => void = () => undefined
    const slow = new Promise<unknown>((resolve) => { open = resolve })
    const carried = (): number => h.logs.filter(line => line.text.startsWith('bili: the relay carries')).length
    const before = carried()
    const release = join(slow)
    release()
    expect(unregister).toHaveBeenCalledTimes(1)
    open(domain)
    await vi.advanceTimersByTimeAsync(0)
    expect(claim).not.toHaveBeenCalled()
    expect(carried()).toBe(before)

    const broken = Promise.reject(new Error('storage offline'))
    broken.catch(() => undefined)
    join(broken)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.logs.some(line => line.type === 'warn' && line.text === 'bili: Sessions not claimed with the relay: storage offline')).toBe(true)
  })
})

describe('what bili-svc says of the account', () => {
  it('reads an account bili-svc lists oddly: an unknown session state, no mid, no name, or no account at all', async () => {
    svc.accounts = [{ id: 'maomao', mid: 0, display: '', session: 'weird' }]
    const h = await harness({ svc, workspace: dir })
    expect(await h.account.me()).toMatchObject({ signedIn: false })
    expect((await h.account.me()).uname).toBeUndefined()
    expect((await h.view()).account).toMatchObject({ account: 'maomao', session: 'missing' })
    expect((await h.view()).account).not.toHaveProperty('mid')
    svc.accounts = []
    vi.advanceTimersByTime(11_000)
    expect((await h.view()).account).toMatchObject({ session: 'unreachable', error: 'bili-svc lists no account maomao' })
  })

  it('does not reuse a status answer that failed, and says the pause mode is unknown when bili-svc names none', async () => {
    svc.answer('/v1/status', new TypeError('fetch failed'))
    const h = await harness({ svc, workspace: dir })
    expect(await h.account.me()).toMatchObject({ signedIn: false })
    expect(await h.account.me()).toMatchObject({ signedIn: true, mid: 3_000_001 })
    svc.gate = { ...svc.gate, mode: '', readonly: true }
    vi.advanceTimersByTime(11_000)
    expect((await h.account.me()).pause).toBe('bili-svc holds every action (gate mode unknown) until the owner lets them through again')
  })

  it('does not drop a newer status answer when an older one fails late', async () => {
    svc.answer('/v1/status', 'hang')
    const h = await harness({ svc, workspace: dir })
    const pending = h.account.me()
    await vi.advanceTimersByTimeAsync(1000)
    Reflect.set(h.account, 'statusCache', undefined)
    await vi.advanceTimersByTimeAsync(31_000)
    expect(await pending).toMatchObject({ signedIn: false })
    expect(Reflect.get(h.account, 'statusCache')).toBeUndefined()
  })

  it('shows a gate only when the management status carries one', async () => {
    const credentials = credentialStore({ BILI_SVC_TOKEN_BILI: 'svc-token-bili', BILI_SVC_TOKEN_MANAGE: 'svc-token-manage' })
    const h = await harness({ svc, workspace: dir, credentials })
    expect((await h.view()).gate).toMatchObject({ mode: 'auto', readonly: false })
    svc.answer('/v1/status', { body: { accounts: [{ id: 'maomao', mid: 3_000_001, display: '魔女的猫猫', session: 'ok' }] } })
    expect((await h.view()).gate).toBeNull()
  })

  it('uses the mid bili-svc lists when Bilibili names none, and 0 when neither does', async () => {
    const h = await harness({ svc, workspace: dir })
    svc.answer('nav', { body: { ok: true, code: 0, data: { isLogin: true } } })
    expect(await h.account.me()).toMatchObject({ signedIn: true, mid: 3_000_001 })
    svc.accounts = [{ id: 'maomao', mid: 0, display: '魔女的猫猫', session: 'ok' }]
    vi.advanceTimersByTime(11_000)
    svc.answer('nav', { body: { ok: true, code: 0, data: { isLogin: true } } }, { body: { ok: true, code: 0, data: { isLogin: true } } })
    expect(await h.account.me()).toMatchObject({ signedIn: true, mid: 0 })
  })

  it('says signed out when Bilibili says so, and shows the account without level, experience, or a name Bilibili omits', async () => {
    const h = await harness({ svc, workspace: dir })
    svc.answer('nav', { body: { ok: true, code: 0, data: { isLogin: false } } })
    expect(await h.account.me()).toMatchObject({ signedIn: false })
    svc.answer('nav', { body: { ok: true, code: 0, data: { isLogin: true, mid: 3_000_001 } } })
    const me = await h.account.me()
    expect(me).toMatchObject({ signedIn: true, mid: 3_000_001, coins: 0 })
    expect(me).not.toHaveProperty('level')
    expect(me).not.toHaveProperty('exp')
  })

  it('tells the reads that the account is signed out when Bilibili answers code -101', async () => {
    const h = await harness({ svc, workspace: dir })
    svc.answer('view', { body: { ok: false, outcome: 'api_error', code: -101, message: '账号未登录' } })
    await expect(h.account.video(CAT)).rejects.toThrow('Bilibili says the account is signed out; bili-svc owns the login, and the owner renews it there')
  })

  it('names who speaks for the Reply Gate, falling back to the id; and none when bili-svc names none or cannot be asked', async () => {
    const credentials = credentialStore({ BILI_SVC_TOKEN_BILI: 'svc-token-bili', BILI_SVC_TOKEN_MANAGE: 'svc-token-manage' })
    const h = await harness({ svc, workspace: dir, credentials })
    expect((await h.view()).speaker).toEqual({ id: 'maomao', display: '魔女的猫猫' })
    svc.accounts = svc.accounts.map(account => ({ ...account, display: '' }))
    vi.advanceTimersByTime(61_000)
    expect((await h.view()).speaker).toEqual({ id: 'maomao', display: 'maomao' })
    svc.speaker = ''
    vi.advanceTimersByTime(61_000)
    expect((await h.view()).speaker).toBeNull()
    svc.answer('/v1/accounts', new TypeError('fetch failed'))
    vi.advanceTimersByTime(61_000)
    expect((await h.view()).speaker).toBeNull()
    expect(h.logs.some(line => line.text === 'bili: the reply routes were not read: accounts: bili-svc is unreachable (TypeError)')).toBe(true)
  })
})

describe('the account\'s own mid', () => {
  it('refuses an action that needs it while bili-svc cannot say, has no such account, or holds a dead session', async () => {
    const h = await harness({ svc, workspace: dir })
    svc.answer('/v1/status', new TypeError('fetch failed'))
    expect(await h.account.follow(5)).toEqual({
      outcome: 'refused', detail: 'could not check before writing: bili-svc cannot be asked about the account: status: bili-svc is unreachable (TypeError)',
    })
    svc.accounts = []
    vi.advanceTimersByTime(11_000)
    expect((await h.account.follow(5)).detail).toContain('bili-svc cannot be asked about the account: bili-svc lists no account maomao')
    svc.accounts = [{ id: 'maomao', mid: 3_000_001, display: '魔女的猫猫', session: 'dead' }]
    vi.advanceTimersByTime(11_000)
    expect((await h.account.follow(5)).detail).toContain('the Bilibili session in bili-svc is dead; bili-svc owns the login')
  })

  it('asks Bilibili for the mid when bili-svc lists none, and refuses when Bilibili says signed out', async () => {
    svc.accounts = [{ id: 'maomao', mid: 0, display: '魔女的猫猫', session: 'ok' }]
    const h = await harness({ svc, workspace: dir })
    expect(await h.account.follow(5)).toMatchObject({ outcome: 'sent' })
    expect(svc.callsTo('nav')).toHaveLength(1)
    svc.answer('nav', { body: { ok: true, code: 0, data: { isLogin: false } } })
    expect(await h.account.follow(6)).toEqual({
      outcome: 'refused', detail: 'could not check before writing: Bilibili says the account is signed out; bili-svc owns the login, and the owner renews it there',
    })
  })
})

describe('the account\'s Session', () => {
  it('reuses the Session it created for the next message', async () => {
    const h = await conversing()
    h.ownerSays('一')
    await vi.advanceTimersByTimeAsync(600_000)
    await h.answer('好')
    h.ownerSays('二')
    await vi.advanceTimersByTimeAsync(65_000)
    expect(h.sessions.state.created).toHaveLength(1)
    expect(h.sessions.state.prompts.map(prompt => prompt.sessionId)).toEqual(['bili-1', 'bili-1'])
  })

  it('starts a new Session when the stored one no longer exists', async () => {
    const h = await conversing()
    h.ownerSays('一')
    await vi.advanceTimersByTimeAsync(600_000)
    await h.answer('好')
    h.sessions.state.live.delete('bili-1')
    h.ownerSays('二')
    await vi.advanceTimersByTimeAsync(65_000)
    expect(h.sessions.state.created).toHaveLength(2)
    expect(h.logs.some(line => line.text === 'bili: Session bili-1 is unavailable (session/not-found); starting a new one')).toBe(true)
  })

  it('keeps the owner\'s messages for the next check while the stored Session is busy elsewhere, and warns', async () => {
    const h = await conversing()
    h.ownerSays('一')
    await vi.advanceTimersByTimeAsync(600_000)
    await h.answer('好')
    const resolve = h.sessions.controller.resolveAgent
    h.sessions.controller.resolveAgent = () => Promise.resolve({ error: Object.assign(new Error('held'), { code: 'session/writer-held' }) as never })
    h.ownerSays('二')
    await vi.advanceTimersByTimeAsync(65_000)
    expect(h.sessions.state.prompts).toHaveLength(1)
    expect(h.logs.some(line => line.type === 'warn' && line.text === 'bili: prompting the Session with the owner\'s messages failed: held')).toBe(true)
    h.sessions.controller.resolveAgent = resolve
    await vi.advanceTimersByTimeAsync(65_000)
    expect(h.sessions.state.prompts).toHaveLength(2)
  })

  it('warns and keeps the messages when a new Session cannot be resolved right after it is created', async () => {
    const sessions = fakeSessions()
    sessions.controller.resolveAgent = () => Promise.resolve({ error: Object.assign(new Error('gone'), { code: 'session/not-found' }) as never })
    const h = await conversing({ sessions })
    h.ownerSays('一')
    await vi.advanceTimersByTimeAsync(600_000)
    expect(h.logs.some(line => line.type === 'warn' && line.text === 'bili: prompting the Session with the owner\'s messages failed: gone')).toBe(true)
    expect(sessions.state.prompts).toEqual([])
  })

  it('warns when the Session that was created cannot be resolved for the prompt', async () => {
    const sessions = fakeSessions()
    const real = sessions.controller.resolveAgent
    let calls = 0
    sessions.controller.resolveAgent = (sessionId: string) => {
      calls += 1
      return calls === 2 ? Promise.resolve({ error: Object.assign(new Error('lost'), { code: 'session/not-found' }) as never }) : real(sessionId)
    }
    const h = await conversing({ sessions })
    h.ownerSays('一')
    await vi.advanceTimersByTimeAsync(600_000)
    expect(h.logs.some(line => line.type === 'warn' && line.text === 'bili: prompting the Session with the owner\'s messages failed: lost')).toBe(true)
  })

  it('leaves the messages for the next check while the Session is working, and drops the reply mark of a prompt that failed', async () => {
    const h = await conversing()
    h.ownerSays('一')
    await vi.advanceTimersByTimeAsync(600_000)
    await h.answer('好')
    h.sessions.state.status.set('bili-1', 'running')
    h.ownerSays('二')
    await vi.advanceTimersByTimeAsync(65_000)
    expect(h.logs.some(line => line.text === 'bili: Session bili-1 is running; the owner\'s messages wait for the next check')).toBe(true)
    expect(h.sessions.state.prompts).toHaveLength(1)
    h.sessions.state.status.delete('bili-1')
    h.sessions.controller.prompt = () => Promise.reject(new Error('queue full'))
    await vi.advanceTimersByTimeAsync(65_000)
    expect(h.logs.some(line => line.type === 'warn' && line.text === 'bili: prompting the Session with the owner\'s messages failed: queue full')).toBe(true)
  })
})

describe('owner messages', () => {
  it('records what is already there as a baseline without answering it, and hands over the rest oldest first', async () => {
    svc.ownerMessages.push({ sender: OWNER, text: '旧消息', key: '1', at: 1_790_000_000 })
    svc.unread.follow = 1
    const h = await conversing()
    expect(h.logs.some(line => line.text === 'bili: owner-message baseline: 1 message(s) already there')).toBe(true)
    expect(h.sessions.state.prompts).toEqual([])
    h.ownerSays('先')
    h.ownerSays('后')
    await vi.advanceTimersByTimeAsync(600_000)
    const text = (h.sessions.state.prompts[0]!.content[0] as { text: string }).text
    expect(text.indexOf('先')).toBeGreaterThan(-1)
    expect(text.indexOf('先')).toBeLessThan(text.indexOf('后'))
    expect(text).not.toContain('旧消息')
  })

  it('keeps at most 100 queued messages, dropping the oldest, and 20 go in a turn', async () => {
    const h = await conversing()
    h.sessions.state.status.set('bili-1', 'running')
    h.ownerSays('first')
    await vi.advanceTimersByTimeAsync(600_000)
    expect(h.sessions.state.prompts).toEqual([])
    for (let index = 0; index < 110; index += 1) h.ownerSays(`m${String(index).padStart(3, '0')}`)
    await vi.advanceTimersByTimeAsync(65_000)
    h.sessions.state.status.delete('bili-1')
    await vi.advanceTimersByTimeAsync(65_000)
    const text = (h.sessions.state.prompts[0]!.content[0] as { text: string }).text
    // 111 queued, the 100 newest stay, 20 go in the turn: m010 is the oldest left.
    expect(text).toContain('m010')
    expect(text).not.toContain('m009')
    expect(text).not.toContain('first')
    const pending = [...(await domainOf(h as never)).table('pending').keys()]
    expect(pending).toHaveLength(80)
  })

  it('warns when the message check fails and tries again at the next one', async () => {
    const h = await conversing()
    svc.unread.follow = 1
    svc.answer('dmUnread', new TypeError('fetch failed'))
    await vi.advanceTimersByTimeAsync(600_000)
    expect(h.logs.some(line => line.type === 'warn' && line.text === 'bili: the owner-message check failed: dmUnread: bili-svc is unreachable (TypeError)')).toBe(true)
  })

  it('does not arm another fast check after it is stopping', async () => {
    const h = await conversing()
    h.ownerSays('一')
    await vi.advanceTimersByTimeAsync(600_000)
    await h.answer('好')
    svc.unread.follow = 1
    svc.answer('dmUnread', 'hang')
    await vi.advanceTimersByTimeAsync(61_000)
    const during = svc.callsTo('dmUnread').length
    const disposing = h.ctx.fiber.dispose()
    // The hung check ends at its 30 s deadline, after the account began stopping.
    await vi.advanceTimersByTimeAsync(31_000)
    await disposing
    await vi.advanceTimersByTimeAsync(300_000)
    expect(svc.callsTo('dmUnread')).toHaveLength(during)
  })

  it('reads the reply to the owner when bili-svc sends no ledger id, and reports a refusal and an unknown outcome apart', async () => {
    const h = await harness({ svc, workspace: dir })
    const replyOwner = member(h.account, 'replyOwner') as (text: string) => Promise<unknown>
    const reply = (text: string): Promise<unknown> => replyOwner.call(h.account, text)
    svc.answer('/v1/reply/dm', { body: { status: 'sent' } })
    expect(await reply(' hi ')).toEqual({ status: 'sent', detail: 'sent' })
    expect(h.logs.some(line => line.text === 'bili: bili-svc\'s Reply Gate answered sent to a 2-char reply to the owner')).toBe(true)
    svc.answer('/v1/reply/dm', { status: 403, body: { error: 'forbidden' } })
    expect(await reply('hi')).toEqual({ status: 'failed', detail: 'bili-svc did not accept the token for reply/dm (HTTP 403: forbidden)' })
    expect(h.logs.some(line => line.type === 'warn' && line.text.startsWith('bili: the reply to the owner was refused: '))).toBe(true)
    svc.answer('/v1/reply/dm', new TypeError('fetch failed'))
    expect(await reply('hi')).toMatchObject({ status: 'failed', detail: 'the outcome at bili-svc is unknown (reply/dm: bili-svc is unreachable (TypeError))' })
  })
})

describe('what bili-svc says of an action', () => {
  it('words a refusal without a reason, a verification without words, and an API error with or without a hint', async () => {
    const h = await harness({ svc, workspace: dir })
    svc.answer('like', { body: { ok: false, outcome: 'already' } })
    expect(await h.account.like(CAT)).toEqual({ outcome: 'already', detail: 'bili-svc says it is already done' })
    svc.answer('like', { body: { ok: false, outcome: 'verify', code: -110 } })
    expect(await h.account.like(CAT)).toEqual({
      outcome: 'refused', detail: 'Bilibili refused it until the account verifies a phone number: code -110', verification: 'code -110',
    })
    svc.answer('like', { body: { ok: false, outcome: 'api_error', code: -500 } })
    expect(await h.account.like(CAT)).toEqual({ outcome: 'refused', detail: 'Bilibili refused it: code -500' })
    svc.answer('like', { body: { ok: false, outcome: 'api_error', code: 34002, message: '不能给自己投币' } })
    expect((await h.account.like(CAT)).detail).toBe('Bilibili refused it: code 34002 (不能给自己投币)')
    svc.answer('coin', { body: { ok: false, outcome: 'api_error', code: 34002 } })
    expect(await h.account.coin(CAT)).toEqual({ outcome: 'refused', detail: 'Bilibili refused it: code 34002: an account cannot coin its own video' })
    svc.answer('coin', { body: { ok: false, outcome: 'api_error', code: 99999, message: 'new' } })
    expect((await h.account.coin('BV1bb4y1X7bb')).detail).toBe('Bilibili refused it: code 99999 (new)')
  })

  it('refuses a video it cannot read or that is not a BV id, for every action that starts from one', async () => {
    const h = await harness({ svc, workspace: dir })
    const missing = { outcome: 'refused', detail: 'could not read BV1zz4y1X7zz: view: code -404 (啥都木有)' }
    expect(await h.account.like('BV1zz4y1X7zz')).toEqual(missing)
    expect(await h.account.coin('BV1zz4y1X7zz')).toEqual(missing)
    expect(await h.account.triple('BV1zz4y1X7zz')).toEqual(missing)
    expect(await h.account.favorite('BV1zz4y1X7zz')).toEqual(missing)
    expect(await h.account.watchLater('BV1zz4y1X7zz')).toEqual(missing)
    expect(await h.account.coin('nope')).toEqual({ outcome: 'refused', detail: '"nope" is not a BV id' })
    expect(await h.account.triple('nope')).toEqual({ outcome: 'refused', detail: '"nope" is not a BV id' })
    expect(await h.account.favorite('nope')).toEqual({ outcome: 'refused', detail: '"nope" is not a BV id' })
    expect(await h.account.watchLater('nope')).toEqual({ outcome: 'refused', detail: '"nope" is not a BV id' })
    expect(svc.callsTo('like')).toEqual([])
  })

  it('refuses a user id that is not a positive integer, for follow and unfollow', async () => {
    const h = await harness({ svc, workspace: dir })
    for (const mid of [0, -1, 1.5, Number.NaN]) {
      expect(await h.account.follow(mid)).toEqual({ outcome: 'refused', detail: 'mid must be a positive user id' })
      expect(await h.account.unfollow(mid)).toEqual({ outcome: 'refused', detail: 'mid must be a positive user id' })
    }
    expect(svc.callsTo('relationModify')).toEqual([])
  })

  it('counts a balance of zero when Bilibili reports no session before a coin write, for coin and triple', async () => {
    const h = await harness({ svc, workspace: dir })
    svc.answer('nav', { body: { ok: true, code: 0, data: { isLogin: false } } })
    expect(await h.account.coin(CAT)).toEqual({ outcome: 'refused', detail: 'the account has 0 coins; this needs 2 (about one comes each day from signing in)' })
    svc.answer('nav', { body: { ok: true, code: 0, data: { isLogin: false } } })
    expect(await h.account.triple(CAT)).toEqual({ outcome: 'refused', detail: 'the account has 0 coins; this needs 2 (about one comes each day from signing in)' })
  })

  it('triples a repost with one coin, and reports only the parts Bilibili applied', async () => {
    const h = await harness({ svc, workspace: dir })
    svc.answer('triple', { body: { ok: true, code: 0, data: { like: true, coin: false, fav: true, multiply: 0 }, outcome: 'sent' } })
    expect(await h.account.triple('BV1oo4y1X7oo')).toEqual({ outcome: 'sent', detail: 'liked, saved to the default folder' })
    svc.answer('triple', { body: { ok: true, code: 0, data: {}, outcome: 'sent' } })
    expect(await h.account.triple(CAT)).toEqual({ outcome: 'sent', detail: 'Bilibili applied none of the missing parts' })
  })

  it('picks the first folder when none is the default, refuses when there is none, and removes only from a folder that holds the video', async () => {
    const h = await harness({ svc, workspace: dir })
    svc.answer('favFolders', { body: { ok: true, code: 0, data: { list: [{ id: 5, title: '慢慢看', attr: 2, media_count: 0, fav_state: 0 }] } } })
    expect(await h.account.favorite(CAT)).toMatchObject({ outcome: 'sent' })
    expect(svc.callsTo('favDeal')[0]!.form).toMatchObject({ add_media_ids: '5' })
    svc.answer('favFolders', { body: { ok: true, code: 0, data: { list: [] } } })
    expect(await h.account.favorite(CAT)).toEqual({ outcome: 'refused', detail: 'no favorite folder exists' })
    expect(await h.account.favorite(CAT, { remove: true })).toEqual({ outcome: 'already', detail: 'not in folder 默认收藏夹' })
  })

  it('does not report a watch when the account\'s mid cannot be read, and warns when the report has an unknown outcome', async () => {
    const h = await harness({ svc, workspace: dir })
    svc.answer('/v1/status', new TypeError('fetch failed'))
    await h.account.video(CAT)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.logs.some(line => line.text.startsWith(`bili: no watch report for ${CAT}: bili-svc cannot be asked about the account`))).toBe(true)
    expect(svc.callsTo('watchReport')).toEqual([])
    vi.advanceTimersByTime(11_000)
    svc.answer('watchReport', new TypeError('fetch failed'))
    await h.account.video(CAT)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.logs.some(line => line.type === 'warn' && line.text === `bili: the watch report of ${CAT} has an unknown outcome; not sent again`)).toBe(true)
  })

  it('reports the length it read when the video\'s own length is unknown', async () => {
    const h = await harness({ svc, workspace: dir })
    svc.answer('view', { body: { ok: true, code: 0, data: { aid: 101, bvid: CAT, cid: 9001, title: '猫', owner: { name: '猫的主人', mid: 777 } } } })
    await h.account.video(CAT)
    await vi.advanceTimersByTimeAsync(0)
    expect(svc.watched[0]).toMatchObject({ played_time: 4, video_duration: 4 })
  })
})

describe('reads that refuse', () => {
  it('refuses a malformed BV id, an empty keyword, and a thread root that is not a comment id', async () => {
    const h = await harness({ svc, workspace: dir })
    await expect(h.account.danmaku('nope')).rejects.toThrow('"nope" is not a BV id')
    await expect(h.account.comments('nope')).rejects.toThrow('"nope" is not a BV id')
    await expect(h.account.search('   ')).rejects.toThrow('the keyword is empty')
    await expect(h.account.comments(CAT, { root: 'abc' })).rejects.toThrow('root must be a comment id')
  })

  it('reads a thread whose root Bilibili did not send, and passes a comment offset on', async () => {
    svc.comments.push({ rpid: '600000000000000002', oid: '101', root: '600000000000000001', mid: 889, uname: '路人', message: '确实' })
    const h = await harness({ svc, workspace: dir })
    const thread = await h.account.comments(CAT, { root: '600000000000000001', page: 2 })
    expect(thread).not.toHaveProperty('root')
    expect(thread.comments.map(row => row.text)).toEqual(['确实'])
    await h.account.comments(CAT, { offset: 'o-7', order: 'new' })
    expect(JSON.parse(String(svc.callsTo('replies').at(-1)!.query['pagination_str']))).toEqual({ offset: 'o-7' })
  })

  it('shows the inbox with no owner account, and every feed with the owner\'s posts when none is set', async () => {
    svc.replyItems = [replyItem(1, '600000000009', '你也喜欢猫？')]
    const h = await harness({ svc, workspace: dir, config: { ownerMid: undefined } })
    expect((await h.account.inbox()).ownerMessages).toEqual([])
    expect(svc.callsTo('dmMessages')).toEqual([])
    expect((await h.account.homeFeed()).map(card => card.bvid)).toContain('BV1oo4y1X7oo')
  })

  it('reads the danmaku of the part asked for', async () => {
    const h = await harness({ svc, workspace: dir })
    expect((await h.account.danmaku(CAT, 1)).lines.length).toBeGreaterThan(0)
  })
})

describe('the Settings route', () => {
  it('refuses a body that is not JSON-typed, and saves the same owner UID twice with a different log line', async () => {
    const h = await harness({ svc, workspace: dir })
    const route = h.routes.find(entry => entry.path === '/api/bili')!
    const response = await route.fetch(new Request('http://127.0.0.1/api/bili', { method: 'POST', body: new Uint8Array([123, 125]) }))
    expect(response.status).toBe(415)
    await h.post({ action: 'owner', mid: 200000002 })
    await h.post({ action: 'owner', mid: 200000002 })
    const lines = h.logs.map(line => line.text)
    expect(lines).toContain('bili: the owner set a new main account UID')
    expect(lines).toContain('bili: the owner saved the same main account UID')
    expect((await h.view()).ownerUpdatedAt).toBeGreaterThan(Date.now() - 5000)
  })

  it('does not hide a failure that is not bili-svc\'s refusal', async () => {
    let resolutions = 0
    const base = credentialStore({ BILI_SVC_TOKEN_BILI: 'svc-token-bili', BILI_SVC_TOKEN_MANAGE: 'svc-token-manage' })
    const credentials = {
      ...base,
      provider: {
        resolve: (ref: Parameters<typeof base.provider.resolve>[0]) => {
          if (String(ref) === 'BILI_SVC_TOKEN_MANAGE') {
            resolutions += 1
            if (resolutions > 1) return Promise.reject(new Error('vault locked'))
          }
          return base.provider.resolve(ref)
        },
      },
    }
    const h = await harness({ svc, workspace: dir, credentials })
    resolutions = 0
    await expect(h.post({ action: 'brake.release' })).rejects.toThrow('vault locked')
  })
})
