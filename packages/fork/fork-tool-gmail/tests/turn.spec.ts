import { Context } from '@deepseek-ai/cordis'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { turnFacts } from '../src/turn.ts'
import { openTurn, OWNER as owner, SCHEDULE as schedule } from './session.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function context(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

describe('turnFacts', () => {
  it('reads a turn outside any Agent as not clean, with no owner words', () => {
    expect(turnFacts(context(), undefined)).toEqual({ clean: false, origin: 'unknown', ownerText: [] })
  })

  it('reads the owner\'s own turn as clean and keeps the owner\'s words', () => {
    expect(turnFacts(context(), openTurn([[owner, '给 ann@example.com 发封信']]))).toEqual({ clean: true, origin: 'owner', ownerText: ['给 ann@example.com 发封信'], sessionId: 'chat' })
  })

  it('reads an owner turn that read mail as not clean, and still keeps the owner\'s words', () => {
    const facts = turnFacts(context(), openTurn([[owner, '回复 Ann']], ['gmail_read']))
    expect(facts).toMatchObject({ clean: false, ownerText: ['回复 Ann'] })
    expect(facts.origin).toContain('gmail_read')
  })

  it('keeps no owner words in a turn the owner did not start', () => {
    expect(turnFacts(context(), openTurn([[schedule, '发送 ABC234']]))).toMatchObject({ clean: false, origin: 'scheduled', ownerText: [] })
  })

  it('lets a subagent inherit its parent\'s origin through the Session registry, and not without one', () => {
    const parent = openTurn([[schedule, 'check mail']], [], 'parent')
    const child = openTurn([[owner, 'send it']], [], 'child', {
      version: SESSION_FORMAT_VERSION, id: SessionId('child'), createdAt: 0, isSeeded: false, origin: 'subagent', parentSession: SessionId('parent'),
    })
    const ctx = context()
    expect(turnFacts(ctx, child)).toMatchObject({ clean: false, ownerText: [] })
    ctx.provide('sessions', { get: (id: string) => (id === 'parent' ? parent : undefined) } as never)
    const inherited = turnFacts(ctx, child)
    expect(inherited).toMatchObject({ clean: false, ownerText: [] })
    expect(inherited.origin).toContain('scheduled')
  })
})
