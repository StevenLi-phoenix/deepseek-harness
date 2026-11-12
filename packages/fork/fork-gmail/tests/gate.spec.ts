import { describe, expect, it } from 'vitest'
import { decideSend, namedByOwner, ownerConfirms, SEND_POLICIES, type RecipientFacts, type TurnFacts } from '../src/gate.ts'

const CLEAN: TurnFacts = { clean: true, origin: 'owner', ownerText: ['Send the minutes to ada@example.com'] }
const TAINTED: TurnFacts = { clean: false, origin: 'owner+gmail_read', ownerText: ['Answer that mail'] }
const SCHEDULED: TurnFacts = { clean: false, origin: 'scheduled', ownerText: [] }

const NONE: RecipientFacts = { trusted: new Set(), vouched: new Set() }

describe('send policies', () => {
  it('lists the four policies in Settings order', () => {
    expect(SEND_POLICIES).toEqual(['read-only', 'confirm-all', 'confirm-untrusted', 'direct'])
  })

  it('refuses every send on a read-only account, whatever the turn', () => {
    for (const turn of [CLEAN, TAINTED]) {
      expect(decideSend('read-only', turn, ['owner@example.com'], { trusted: new Set(['owner@example.com']), vouched: new Set() }))
        .toEqual({ kind: 'refuse', reason: 'this account is read-only: the owner allows no drafts, sends, or changes from you' })
    }
  })

  it('sends at once on a direct account, even from a tainted turn to a stranger', () => {
    expect(decideSend('direct', TAINTED, ['stranger@evil.example'], NONE)).toEqual({ kind: 'send' })
  })

  it('holds every message on a confirm-all account, even to the owner\'s own address in a clean turn', () => {
    expect(decideSend('confirm-all', CLEAN, ['owner@example.com'], { trusted: new Set(['owner@example.com']), vouched: new Set() }))
      .toEqual({ kind: 'hold', reason: '这个账号每封信都要你确认' })
  })
})

describe('confirm-untrusted', () => {
  const facts: RecipientFacts = { trusted: new Set(['owner@example.com', 'me@work.example']), vouched: new Set(['ada@example.com']) }

  it('sends when every recipient is trusted, even from a tainted or scheduled turn', () => {
    expect(decideSend('confirm-untrusted', TAINTED, ['owner@example.com', 'me@work.example'], facts)).toEqual({ kind: 'send' })
    expect(decideSend('confirm-untrusted', SCHEDULED, ['me@work.example'], facts)).toEqual({ kind: 'send' })
  })

  it('holds any other message from a turn that is not clean, naming its origin', () => {
    expect(decideSend('confirm-untrusted', TAINTED, ['ada@example.com'], facts))
      .toEqual({ kind: 'hold', reason: '这一轮不是你单独发起的，或读过外来内容（owner+gmail_read）' })
    expect(decideSend('confirm-untrusted', SCHEDULED, [], facts)).toMatchObject({ kind: 'hold', reason: expect.stringContaining('scheduled') as string })
  })

  it('holds a clean turn\'s message to a stranger, naming every stranger', () => {
    expect(decideSend('confirm-untrusted', CLEAN, ['ada@example.com', 'eve@evil.example', 'mallory@evil.example', 'owner@example.com'], facts))
      .toEqual({ kind: 'hold', reason: 'eve@evil.example、mallory@evil.example 不在你这一轮的话里，这个账号也没给对方发过信' })
  })

  it('sends a clean turn\'s message when every recipient is trusted or vouched', () => {
    expect(decideSend('confirm-untrusted', CLEAN, ['ada@example.com', 'owner@example.com'], facts)).toEqual({ kind: 'send' })
  })
})

describe('owner\'s words', () => {
  it('finds an address the owner named, in any case', () => {
    expect(namedByOwner({ ...CLEAN, ownerText: ['Mail ADA@Example.com the plan'] }, 'ada@example.com')).toBe(true)
    expect(namedByOwner(CLEAN, 'eve@evil.example')).toBe(false)
    expect(namedByOwner(SCHEDULED, 'ada@example.com')).toBe(false)
  })

  it('confirms a held message only in a clean turn whose owner text holds the code as a whole word, in any case', () => {
    const turn = (text: string, clean = true): TurnFacts => ({ clean, origin: 'owner', ownerText: ['unrelated', text] })
    expect(ownerConfirms(turn('发送 ABC234'), 'ABC234')).toBe(true)
    expect(ownerConfirms(turn('send abc234 please'), 'ABC234')).toBe(true)
    expect(ownerConfirms(turn('abc234'), 'ABC234')).toBe(true)
    expect(ownerConfirms(turn('「发送 ABC234」'), 'ABC234')).toBe(true)
    expect(ownerConfirms(turn('XABC234'), 'ABC234')).toBe(false)
    expect(ownerConfirms(turn('ABC2345'), 'ABC234')).toBe(false)
    expect(ownerConfirms(turn('send it'), 'ABC234')).toBe(false)
    expect(ownerConfirms(turn('发送 ABC234', false), 'ABC234')).toBe(false)
  })
})
