import { describe, expect, it, vi } from 'vitest'
import { createBiliReader, parseComment } from '../src/bili.ts'

const hrefOf = (input: string | URL | Request): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
const reader = (answers: Record<string, unknown>, seen: Array<RequestInit | undefined> = []) => createBiliReader({
  baseUrl: 'http://bili', token: 'tok', timeoutMs: 1000,
  fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    seen.push(init)
    return Response.json(answers[new URL(hrefOf(url)).pathname])
  }),
})

describe('parseComment', () => {
  it('defaults a missing root and parent to 0, and keeps the gate flag only when it is a boolean', () => {
    const base = { rpid: 1, mid: 2, ctime: 3, untrusted: { text: '好' } }
    expect(parseComment(base)).toEqual({ rpid: 1, mid: 2, ctime: 3, text: '好', root: 0, parent: 0 })
    expect(parseComment({ ...base, root: 4, parent: 5, gate: true })).toEqual({ rpid: 1, mid: 2, ctime: 3, text: '好', root: 4, parent: 5, gate: true })
    expect(parseComment({ ...base, gate: 'yes' })).not.toHaveProperty('gate')
  })

  it('drops anything missing a field or holding a non-integer id', () => {
    expect(parseComment(null)).toBeUndefined()
    expect(parseComment({ rpid: 1.5, mid: 2, ctime: 3, untrusted: { text: '好' } })).toBeUndefined()
    expect(parseComment({ rpid: 1, mid: 2, ctime: 3, untrusted: { text: 5 } })).toBeUndefined()
  })
})

describe('createBiliReader edge cases', () => {
  it('reads an account without a mid as null, and answers nothing for an answer without lists', async () => {
    const accounts = reader({ '/v1/status': { accounts: [{ id: 'maodeng' }] } })
    expect(await accounts.accounts()).toEqual([{ id: 'maodeng', mid: null }])
    const empty = reader({ '/v1/status': { accounts: 'none' }, '/v1/comments': { comments: 'none' }, '/v1/comments/9/thread': {} })
    expect(await empty.accounts()).toEqual([])
    expect(await empty.comments(5)).toEqual([])
    expect(await empty.thread(9)).toEqual({ root: null, replies: [] })
  })

  it('combines the caller\'s signal with its own deadline', async () => {
    const seen: Array<RequestInit | undefined> = []
    const controller = new AbortController()
    await reader({ '/v1/status': {} }, seen).accounts(controller.signal)
    await reader({ '/v1/status': {} }, seen).accounts()
    expect(seen[0]!.signal!.aborted).toBe(false)
    controller.abort()
    expect(seen[0]!.signal!.aborted).toBe(true)
    expect(seen[1]!.signal!.aborted).toBe(false)
  })
})
