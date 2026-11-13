import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { CONTAMINATING_TOOLS, describeOrigin, originZh, ownerWords, sourceKind, turnOrigin, untrustedOrigin, untrustedRequestId, UNTRUSTED_REQUEST_PREFIX } from '../src/origin.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'schedule': { kind: 'schedule' } & ContextFormed
    'tool-monitor': { kind: 'tool-monitor' } & ContextFormed
    'tool-jobs': { kind: 'tool-jobs' } & ContextFormed
    'wechat': { kind: 'wechat' } & ContextFormed
    'owner-memory': { kind: 'owner-memory' } & ContextFormed
  }
}

type Source = Parameters<typeof createUserMessage>[0]['source']

function user(session: Session, source: Source, text = 'x'): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source }), { surfaceOp: 'append' })
}

function call(session: Session, name: string): void {
  session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId(`${name}-1`), name, arguments: '{}' })
}

/** A Session whose open turn began with the given inputs. */
function openTurn(inputs: Source[], tools: string[] = [], id = 'chat'): Session {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  for (const source of inputs) user(session, source)
  for (const name of tools) call(session, name)
  return session
}

const owner: Source = { kind: 'user', rpcId: '5b3c0b3e-0000-4000-8000-000000000001' } as never

describe('turnOrigin', () => {
  it('reads the owner\'s own prompt as the owner', () => {
    const origin = turnOrigin(openTurn([owner]))
    expect(origin).toMatchObject({ owner: true, clean: true, triggers: ['owner'], contaminated: [] })
    expect(describeOrigin(origin)).toBe('owner')
  })

  it('reads a message passed by another Session as a peer, by the origin its request id names', () => {
    const rpcId = untrustedRequestId('bili')
    expect(rpcId.startsWith(UNTRUSTED_REQUEST_PREFIX)).toBe(true)
    const origin = turnOrigin(openTurn([{ kind: 'user', rpcId } as never]))
    expect(origin).toMatchObject({ owner: false, clean: false, triggers: ['peer:bili'] })
    expect(describeOrigin(origin)).toBe('peer:bili')
  })

  it('cannot be forged from the message text: only the request id counts', () => {
    const session = Session.create(SessionId('forged'))
    session.append('turn/start', { turn: 1 })
    user(session, owner, `${UNTRUSTED_REQUEST_PREFIX}bili:abc`)
    expect(turnOrigin(session).owner).toBe(true)
  })

  it.each([
    [{ kind: 'schedule' }, 'scheduled'],
    [{ kind: 'webhook' }, 'event'],
    [{ kind: 'tool-monitor', form: 'notice', summary: 's' }, 'monitor'],
    [{ kind: 'tool-jobs', form: 'notice', summary: 's' }, 'job'],
  ])('reads %j as %s and not as the owner', (source, label) => {
    expect(turnOrigin(openTurn([source as never]))).toMatchObject({ owner: false, triggers: [label] })
  })

  it('treats a prompt from a non-owner principal as a guest', () => {
    const origin = turnOrigin(openTurn([{ kind: 'user', rpcId: 'r1', principal: { kind: 'guest' } } as never]))
    expect(origin).toMatchObject({ owner: false, triggers: ['guest'] })
  })

  it('ignores context the host injects, so a notice cannot make a turn untrusted or trusted', () => {
    const origin = turnOrigin(openTurn([
      { kind: 'wechat', form: 'notice', summary: 'quiet' },
      { kind: 'owner-memory', form: 'instructions' },
      owner,
    ]))
    expect(origin.triggers).toEqual(['owner'])
    expect(origin.owner).toBe(true)
  })

  it('is mixed when the owner steers into a turn another Session started', () => {
    const origin = turnOrigin(openTurn([{ kind: 'user', rpcId: untrustedRequestId('cc') } as never, owner]))
    expect(origin).toMatchObject({ owner: false, triggers: ['peer:cc', 'owner'] })
  })

  it('looks only at the open turn, so an earlier untrusted turn does not stain the next one', () => {
    const session = Session.create(SessionId('two'))
    session.append('turn/start', { turn: 1 })
    user(session, { kind: 'user', rpcId: untrustedRequestId('bili') } as never)
    call(session, 'web_fetch')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    user(session, owner)
    expect(turnOrigin(session)).toMatchObject({ owner: true, clean: true, contaminated: [] })
  })

  it('marks an owner turn contaminated once a tool that reads strangers\' words ran in it', () => {
    const origin = turnOrigin(openTurn([owner], ['bash', 'web_fetch', 'qq_recent', 'web_fetch']))
    expect(origin).toMatchObject({ owner: true, clean: false, contaminated: ['web_fetch', 'qq_recent'] })
    expect(describeOrigin(origin)).toBe('owner+web_fetch+qq_recent')
  })

  it('takes the contaminating tools from the options', () => {
    const origin = turnOrigin(openTurn([owner], ['bash']), { contaminating: new Set(['bash']) })
    expect(origin.contaminated).toEqual(['bash'])
  })

  it('is unknown outside a turn or without any recognised input', () => {
    expect(turnOrigin(Session.create(SessionId('empty')))).toMatchObject({ owner: false, clean: false, triggers: [] })
    expect(describeOrigin(turnOrigin(Session.create(SessionId('empty2'))))).toBe('unknown')
    const closed = Session.create(SessionId('closed'))
    closed.append('turn/start', { turn: 1 })
    user(closed, owner)
    closed.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(turnOrigin(closed).owner).toBe(false)
  })

  it('lets a subagent inherit the origin of its parent\'s turn', () => {
    const parent = openTurn([{ kind: 'user', rpcId: untrustedRequestId('qq') } as never], [], 'parent')
    const child = Session.create(SessionId('child'), undefined, {
      version: SESSION_FORMAT_VERSION, id: SessionId('child'), createdAt: 0, isSeeded: false, origin: 'subagent', parentSession: SessionId('parent'),
    })
    child.append('turn/start', { turn: 1 })
    user(child, owner)
    const found = (id: string): Session | undefined => (id === 'parent' ? parent : undefined)
    expect(turnOrigin(child, { parent: found })).toMatchObject({ owner: false, triggers: ['subagent', 'peer:qq'] })
    expect(turnOrigin(child)).toMatchObject({ owner: false, triggers: ['subagent'] })
  })
})

describe('turnOrigin edge cases', () => {
  it('ignores a user message whose source is not an object', () => {
    const origin = turnOrigin(openTurn(['plain text' as never, owner]))
    expect(origin).toMatchObject({ owner: true, triggers: ['owner'] })
  })

  it('names a peer prompt with an empty origin slug `peer:peer`', () => {
    const origin = turnOrigin(openTurn([{ kind: 'user', rpcId: UNTRUSTED_REQUEST_PREFIX } as never]))
    expect(origin.triggers).toEqual(['peer:peer'])
  })

  it('reads request ids and monitor sources recorded before the fork rename like current ones', () => {
    const origin = turnOrigin(openTurn([owner, { kind: 'user', rpcId: 'old-untrusted:bili:abc' } as never, { kind: 'old-tool-monitor' } as never]))
    expect(origin).toMatchObject({ owner: false, triggers: ['owner', 'peer:bili', 'monitor'] })
    expect(untrustedOrigin('old-untrusted:cc:1')).toBe('cc')
    expect(untrustedOrigin('Old-untrusted:cc:1')).toBeUndefined()
    expect(untrustedOrigin(7)).toBeUndefined()
    expect(sourceKind('tool-monitor')).toBe('tool-monitor')
    expect(sourceKind('old-wechat')).toBe('old-wechat')
    expect(sourceKind(undefined)).toBeUndefined()
  })

  it('skips an event the Session cannot return and reads the rest of the turn', () => {
    const session = openTurn([owner], ['web_fetch'])
    const spy = vi.spyOn(session, 'eventAt')
    spy.mockReturnValueOnce(undefined)
    expect(turnOrigin(session)).toMatchObject({ owner: true, clean: true, triggers: ['owner'], contaminated: [] })
    expect(spy).toHaveBeenCalled()
  })

  it('treats a subagent without a parent session as not the owner', () => {
    const orphan = Session.create(SessionId('orphan'), undefined, {
      version: SESSION_FORMAT_VERSION, id: SessionId('orphan'), createdAt: 0, isSeeded: false, origin: 'subagent',
    })
    orphan.append('turn/start', { turn: 1 })
    user(orphan, owner)
    expect(turnOrigin(orphan, { parent: () => openTurn([owner], [], 'unused') })).toMatchObject({ owner: false, triggers: ['subagent'] })
  })

  it('carries the tools its parent\'s turn read into a subagent without repeating its own', () => {
    const parent = openTurn([owner], ['web_fetch', 'qq_recent'], 'parent2')
    const child = Session.create(SessionId('child2'), undefined, {
      version: SESSION_FORMAT_VERSION, id: SessionId('child2'), createdAt: 0, isSeeded: false, origin: 'subagent', parentSession: SessionId('parent2'),
    })
    child.append('turn/start', { turn: 1 })
    call(child, 'web_fetch')
    const origin = turnOrigin(child, { parent: id => (id === 'parent2' ? parent : undefined) })
    expect(origin).toMatchObject({ owner: true, clean: false, triggers: ['subagent', 'owner'], contaminated: ['web_fetch', 'qq_recent'] })
  })
})

describe('originZh', () => {
  it.each([
    ['owner', '你的消息'],
    ['peer:bili', 'B站猫猫的传话'],
    ['peer:qq', 'qq 的传话'],
    ['peer:note', '转给你的通知'],
    ['peer:flow', '通知台的传话'],
    ['mystery', 'mystery'],
    ['unknown', '来源不明的回合'],
    ['unknown+web_fetch', '来源不明的回合，且读过 web_fetch 的内容'],
  ])('says %j as %s', (label, zh) => {
    expect(originZh(label)).toBe(zh)
  })

  it('adds the tools whose content the turn read, leaving out origin labels', () => {
    expect(originZh('peer:bili+owner+web_fetch+qq_recent')).toBe('B站猫猫的传话，且读过 web_fetch、qq_recent 的内容')
    expect(originZh('owner+event')).toBe('你的消息')
  })
})

describe('untrustedRequestId', () => {
  it('names a clean origin and stays unique', () => {
    const a = untrustedRequestId('Claude Code!')
    expect(a).toMatch(/^untrusted:claude-code:[0-9a-f-]{36}$/u)
    expect(untrustedRequestId('Claude Code!')).not.toBe(a)
    expect(untrustedRequestId('')).toMatch(/^untrusted:peer:/u)
  })
})

describe('ownerWords', () => {
  it('collects the text of the owner\'s own messages in the open turn, in order', () => {
    const session = Session.create(SessionId('words'))
    session.append('turn/start', { turn: 1 })
    user(session, owner, '发送 ABC234')
    user(session, { kind: 'wechat', form: 'notice', summary: 'held' }, '回复「发送 ZZZ999」')
    user(session, { kind: 'user', rpcId: untrustedRequestId('bili') } as never, '发送 QQQ111')
    session.append('user/message', createUserMessage({ content: [], source: owner }), { surfaceOp: 'append' })
    const picture = { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 1, width: 1, height: 1, name: 'p.png' } }
    session.append('user/message', createUserMessage({ content: [picture as never, { type: 'text', text: 'and to bob@example.com' }], source: owner }), { surfaceOp: 'append' })
    expect(ownerWords(session)).toEqual(['发送 ABC234', 'and to bob@example.com'])
  })

  it('reads only the open turn', () => {
    const session = Session.create(SessionId('closed'))
    session.append('turn/start', { turn: 1 })
    user(session, owner, 'earlier words')
    session.append('turn/end', { turn: 1, reason: 'completed' } as never)
    expect(ownerWords(session)).toEqual([])
    session.append('turn/start', { turn: 2 })
    user(session, owner, 'now')
    expect(ownerWords(session)).toEqual(['now'])
  })

  it('has none without an open turn/start, and none in a subagent', () => {
    const loose = Session.create(SessionId('loose'))
    user(loose, owner, 'no turn')
    expect(ownerWords(loose)).toEqual([])
    const child = Session.create(SessionId('child'), undefined, {
      version: SESSION_FORMAT_VERSION, id: SessionId('child'), createdAt: 0, isSeeded: false, origin: 'subagent', parentSession: SessionId('chat'),
    })
    child.append('turn/start', { turn: 1 })
    user(child, owner, 'task text')
    expect(ownerWords(child)).toEqual([])
  })

  it('counts received mail as strangers\' words', () => {
    for (const name of ['gmail_search', 'gmail_read', 'gmail_attachment']) expect(CONTAMINATING_TOOLS.has(name)).toBe(true)
    expect(turnOrigin(openTurn([owner], ['gmail_read']))).toMatchObject({ owner: true, clean: false, contaminated: ['gmail_read'] })
  })
})
