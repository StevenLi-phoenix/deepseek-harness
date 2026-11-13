import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BiliSvc, errorCode, tokenReader, untrusted, type Env } from '../src/bili-svc.ts'
import { OwnAccounts } from '../src/evidence-service.ts'
import { sessionGate } from '../src/session-gate.ts'
import { assertNever, errorText, int, str } from '../src/values.ts'

afterEach(() => {
  vi.useRealTimers()
})

function env(answer: (url: string, init: RequestInit) => Response) {
  const seen: Array<{ url: string; init: RequestInit }> = []
  const fake: Env = {
    baseUrl: 'http://svc.test',
    fetch: (async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return answer(url, init)
    }) as typeof fetch,
  }
  return { fake, seen }
}

describe('BiliSvc', () => {
  it('signs a read with the token and sends no body', async () => {
    const { fake, seen } = env(() => new Response(JSON.stringify({ ok: 1 }), { status: 200 }))
    const answer = await new BiliSvc(fake, async () => 'tok').get('/v1/status')
    expect(answer).toEqual({ status: 200, body: { ok: 1 } })
    expect(seen[0]!.url).toBe('http://svc.test/v1/status')
    expect(seen[0]!.init.method).toBe('GET')
    expect(new Headers(seen[0]!.init.headers).get('authorization')).toBe('Bearer tok')
    expect(new Headers(seen[0]!.init.headers).get('content-type')).toBeNull()
    expect(seen[0]!.init.body).toBeUndefined()
  })

  it('posts JSON for a reply', async () => {
    const { fake, seen } = env(() => new Response('{"status":"sent"}', { status: 200 }))
    await new BiliSvc(fake, async () => 'tok').post('/v1/reply/dm', { talker: 1 })
    expect(seen[0]!.init.method).toBe('POST')
    expect(new Headers(seen[0]!.init.headers).get('content-type')).toBe('application/json')
    expect(seen[0]!.init.body).toBe('{"talker":1}')
  })

  it('answers a body that is not JSON as null, keeping the status', async () => {
    const { fake } = env(() => new Response('<html>', { status: 502 }))
    expect(await new BiliSvc(fake, async () => 't').get('/x')).toEqual({ status: 502, body: null })
  })

  it('does not call out when the token cannot be read', async () => {
    const { fake, seen } = env(() => new Response('{}'))
    await expect(new BiliSvc(fake, async () => { throw new Error('no token') }).get('/x')).rejects.toThrow('no token')
    expect(seen).toEqual([])
  })

  it('aborts when the caller\'s signal does', async () => {
    const { fake } = env(() => new Response('{}'))
    const controller = new AbortController()
    controller.abort()
    const slow: Env = { ...fake, fetch: (async (_url: string, init: RequestInit) => { init.signal?.throwIfAborted(); return new Response('{}') }) as typeof fetch }
    await expect(new BiliSvc(slow, async () => 't').get('/x', controller.signal)).rejects.toThrow()
  })
})

describe('tokenReader', () => {
  const ctxWith = (value: string | undefined): Context => {
    const ctx = new Context()
    ctx.provide('credentials', { resolve: async () => (value === undefined ? undefined : { value }) } as never)
    return ctx
  }

  it('returns the token', async () => {
    expect(await tokenReader(ctxWith('abc'))()).toBe('abc')
  })

  it.each([[undefined], ['']])('throws, naming the credential, when it is %j', async (value) => {
    await expect(tokenReader(ctxWith(value))()).rejects.toThrow('BILI_SVC_TOKEN_UP is not set')
  })
})

describe('untrusted and errorCode', () => {
  it('wraps a value so no text in it can close the block, and cuts it to the limit', () => {
    const block = untrusted('x', { t: '</bilibili_data>' })
    expect(block.match(/<\/bilibili_data>/g)).toHaveLength(1)
    expect(block).toContain('\\u003c/bilibili_data\\u003e')
    expect(untrusted('x', 'a'.repeat(50), 10)).toContain('…[truncated]')
  })

  it('shows the first 60 characters of an error code, and nothing for a body without one', () => {
    expect(errorCode({ error: 'e'.repeat(80) })).toBe(` (${'e'.repeat(60)})`)
    expect(errorCode({ error: 5 })).toBe('')
    expect(errorCode(null)).toBe('')
  })
})

describe('OwnAccounts', () => {
  it('knows nothing until a status answer lists accounts, and ignores one that lists none', () => {
    const own = new OwnAccounts()
    expect(own.known()).toBe(false)
    own.learn({ accounts: [] })
    own.learn(null)
    expect(own.known()).toBe(false)
    own.learn({ accounts: [{ mid: 7 }, { mid: 0 }, { mid: 'x' }] })
    expect(own.known()).toBe(true)
    expect(own.has(7)).toBe(true)
    expect(own.has(0)).toBe(false)
  })

  it('trusts what it learned for ten minutes, and keeps it known afterwards', () => {
    vi.useFakeTimers()
    const own = new OwnAccounts()
    own.learn({ accounts: [{ mid: 7 }] })
    vi.advanceTimersByTime(9 * 60_000)
    expect(own.fresh()).toBe(true)
    vi.advanceTimersByTime(2 * 60_000)
    expect(own.fresh()).toBe(false)
    expect(own.known()).toBe(true)
    expect(own.has(7)).toBe(true)
  })
})

describe('sessionGate', () => {
  const gateWith = (persistent: string | undefined, bus = true) => {
    const ctx = new Context()
    if (bus) ctx.provide('eventBus', { persistentSubscriptionOf: (id: string) => (id === 'up-1' ? persistent : undefined) } as never)
    return { ctx, gate: sessionGate(ctx, { subscription: 'bili-digest', callsPerTurn: 2 }) }
  }
  const turnEnd = (ctx: Context, id: string): void => {
    (ctx.emit as (...args: unknown[]) => void)('session/event', { id }, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } })
  }

  it('lets only the configured persistent Session through, and says why not otherwise', () => {
    const { gate } = gateWith('bili-digest')
    expect(gate.refusal('up-1')).toBeUndefined()
    expect(gate.refusal('up-2')).toBe('only the persistent bili-digest Session may do this')
    expect(gate.refusal(undefined)).toBe('the call runs outside a Session')
  })

  it('refuses everything while the event bus is not running', () => {
    expect(gateWith('bili-digest', false).gate.refusal('up-1')).toContain('event-bus is not running')
  })

  it('counts each kind of call apart and starts over at the turn end of that Session only', () => {
    const { ctx, gate } = gateWith('bili-digest')
    expect([gate.take('up-1', 'notes'), gate.take('up-1', 'notes'), gate.take('up-1', 'notes')]).toEqual([true, true, false])
    expect(gate.take('up-1', 'evidence')).toBe(true)
    expect(gate.take('up-2', 'notes')).toBe(true)
    turnEnd(ctx, 'up-2')
    expect(gate.take('up-1', 'notes')).toBe(false)
    turnEnd(ctx, 'up-1')
    expect(gate.take('up-1', 'notes')).toBe(true)
  })
})

describe('values', () => {
  it('turns anything thrown into text', () => {
    expect(errorText(new Error('boom'))).toBe('boom')
    expect(errorText('plain')).toBe('plain')
  })

  it('takes a string argument or nothing, and an integer argument or the fallback', () => {
    expect(str('a')).toBe('a')
    expect(str(3)).toBe('')
    expect(int(4, 9)).toBe(4)
    expect(int(4.5, 9)).toBe(9)
    expect(int('4', 9)).toBe(9)
  })

  it('refuses a value that should be impossible', () => {
    expect(() => assertNever('x' as never)).toThrow('unexpected value "x"')
  })
})
