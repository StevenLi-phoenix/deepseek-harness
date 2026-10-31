import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { describeOrigin, turnOrigin, untrustedRequestId, UNTRUSTED_REQUEST_PREFIX } from '../src/origin.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'schedule': { kind: 'schedule' } & ContextFormed
    'lsy-tool-monitor': { kind: 'lsy-tool-monitor' } & ContextFormed
    'tool-jobs': { kind: 'tool-jobs' } & ContextFormed
    'lsy-wechat': { kind: 'lsy-wechat' } & ContextFormed
    'lsy-memory': { kind: 'lsy-memory' } & ContextFormed
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
    [{ kind: 'lsy-tool-monitor', form: 'notice', summary: 's' }, 'monitor'],
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
      { kind: 'lsy-wechat', form: 'notice', summary: 'quiet' },
      { kind: 'lsy-memory', form: 'instructions' },
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

describe('untrustedRequestId', () => {
  it('names a clean origin and stays unique', () => {
    const a = untrustedRequestId('Claude Code!')
    expect(a).toMatch(/^lsy-untrusted:claude-code:[0-9a-f-]{36}$/u)
    expect(untrustedRequestId('Claude Code!')).not.toBe(a)
    expect(untrustedRequestId('')).toMatch(/^lsy-untrusted:peer:/u)
  })
})
