import { describe, expect, it } from 'vitest'
import { contentText, decideRelay, relayFallbackNote } from '../src/rules.ts'

describe('contentText', () => {
  it('joins text parts and ignores everything else', () => {
    expect(contentText([{ type: 'thinking', thinking: 'x' }, null, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'text' }])).toBe('a\nb')
    expect(contentText([{ type: 'text', text: '  ' }])).toBeUndefined()
  })
})

describe('decideRelay', () => {
  it.each([
    ['answer', 'completed', 'answer'],
    [undefined, 'error', '⚠️ 本轮未完成（error）'],
    [undefined, 'aborted', '⚠️ 本轮未完成（aborted）'],
    ['partial', 'max-tokens', 'partial\n\n⚠️ 本轮未完成（max-tokens）'],
  ] as const)('relays %j after %s as %j', (text, outcome, expected) => {
    expect(decideRelay(text, { kind: outcome })).toEqual({ kind: 'answer', text: expected, outcome })
  })

  it('adds the failure reason under the warning', () => {
    const error = (code: string, message: string) => ({ kind: 'error', error: { code, message } })
    expect(decideRelay(undefined, error('AUTH', '401 User not found.')))
      .toEqual({ kind: 'answer', text: '⚠️ 本轮未完成（error）\n原因：AUTH: 401 User not found.', outcome: 'error', detail: 'AUTH: 401 User not found.' })
    expect(decideRelay('partial', error('QUOTA', 'no credits')))
      .toEqual({ kind: 'answer', text: 'partial\n\n⚠️ 本轮未完成（error）\n原因：QUOTA: no credits', outcome: 'error', detail: 'QUOTA: no credits' })
  })

  it('relays nothing for NO_REPLY, a completed turn without text, or a turn the owner stopped', () => {
    expect(decideRelay('NO_REPLY', { kind: 'completed' })).toEqual({ kind: 'silent' })
    expect(decideRelay(' NO_REPLY ', { kind: 'error', error: { code: 'AUTH', message: 'x' } })).toEqual({ kind: 'silent' })
    expect(decideRelay(undefined, { kind: 'completed' })).toEqual({ kind: 'empty' })
    // WeChat /stop and the Web UI's stop both cancel with cause `user`: the owner already knows.
    expect(decideRelay('half an answer', { kind: 'aborted', reason: { kind: 'user' } })).toEqual({ kind: 'stopped' })
    // Any other cancel cause still tells the owner the turn did not finish.
    expect(decideRelay(undefined, { kind: 'aborted', reason: { kind: 'legacy' } })).toEqual({ kind: 'answer', text: '⚠️ 本轮未完成（aborted）', outcome: 'aborted' })
  })
})

describe('relayFallbackNote', () => {
  it('carries the answer, why it did not go out, and the channel label as its origin', () => {
    expect(relayFallbackNote({ sessionId: 's1', text: 'answer', outcome: 'completed' }, 'not mutual', 'the test Session'))
      .toEqual({ title: '↪️ 这条回答没能从原渠道发出，改发这里', body: 'answer\n\n原因：not mutual', origin: 'the test Session' })
  })
})
