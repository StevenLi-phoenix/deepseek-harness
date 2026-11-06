import { describe, expect, it, vi } from 'vitest'
import { HotWatch } from '../src/hotwatch.ts'

const hrefOf = (input: string | URL | Request): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
/** A fetch double answering by path; a thrown value is rejected, anything else is the JSON body of a 200. */
function scripted(routes: Record<string, unknown>) {
  const calls: string[] = []
  const fetchStub = vi.fn(async (url: string | URL | Request): Promise<Response> => {
    const path = hrefOf(url).replace('http://hot', '')
    calls.push(path)
    const route = Object.entries(routes).find(([prefix]) => path.startsWith(prefix))?.[1]
    const answer = typeof route === 'function' ? (route as () => unknown)() : route
    if (answer instanceof Error) throw answer
    if (typeof answer === 'string' && answer.startsWith('throw:')) throw answer.slice(6)
    if (typeof answer === 'string' && answer.startsWith('status:')) return new Response('{}', { status: Number(answer.slice(7)) })
    return Response.json(answer)
  })
  return { calls, fetchStub }
}

function client(routes: Record<string, unknown>, options: { ttlMs?: number; now?: () => number } = {}) {
  const { calls, fetchStub } = scripted(routes)
  const warn = vi.fn()
  const hot = new HotWatch({ url: 'http://hot', limit: 5, ttlMs: options.ttlMs ?? 60_000, timeoutMs: 1000, fetch: fetchStub, warn, ...options.now === undefined ? {} : { now: options.now } })
  return { hot, calls, warn }
}

describe('HotWatch list', () => {
  it('keeps titles that pass the filter, accepts numeric ids, defaults a missing heat, and skips malformed rows', async () => {
    const { hot, calls } = client({
      '/events?': [
        { subevent_id: 7, title: '数字编号的梗', heat: 5 },
        { subevent_id: 'a', title: '没有热度的梗' },
        { subevent_id: 'b', title: 12 },
        { title: '没有编号' },
        { subevent_id: 'c', title: '加我QQ 2153925085', heat: 1 },
        null,
        'text',
      ],
    })
    expect(await hot.memes()).toEqual([
      { id: '7', title: '数字编号的梗', heat: 5 },
      { id: 'a', title: '没有热度的梗', heat: 0 },
    ])
    expect(calls).toEqual(['/events?domain=meme&order=heat&limit=5'])
  })

  it('reads an answer that is not a list as no memes', async () => {
    const { hot, warn } = client({ '/events?': { error: 'odd' } })
    expect(await hot.memes()).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('shares a read in flight and serves the cache until the lifetime ends', async () => {
    let clock = 1000
    const { hot, calls } = client({ '/events?': [{ subevent_id: 'a', title: '某个梗', heat: 1 }] }, { ttlMs: 100, now: () => clock })
    const [first, second] = await Promise.all([hot.memes(), hot.memes()])
    expect(second).toBe(first)
    expect(calls).toHaveLength(1)
    clock += 50
    await hot.memes()
    expect(calls).toHaveLength(1)
    clock += 100
    await hot.memes()
    expect(calls).toHaveLength(2)
  })

  it('warns once per failure kind with the reason, whether an Error or not, and warns again after a recovery', async () => {
    let answer: unknown = 'throw:socket closed'
    let clock = 0
    const { hot, warn } = client({ '/events?': () => answer }, { ttlMs: 0, now: () => (clock += 1) })
    expect(await hot.memes()).toEqual([])
    expect(await hot.memes()).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith("lsy-style: HotWatch list unavailable (socket closed); using the groups' memes only")
    answer = []
    await hot.memes()
    answer = new Error('connect refused')
    await hot.memes()
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenLastCalledWith("lsy-style: HotWatch list unavailable (connect refused); using the groups' memes only")
  })
})

describe('HotWatch lookup', () => {
  const list = [{ subevent_id: 'e1', title: '某某热梗', heat: 90 }]

  it('finds a title by containment in either direction and caches its summary within the lifetime', async () => {
    const { hot, calls } = client({ '/events?': list, '/events/e1': { summary: ' 一个很火的说法。 ' } })
    expect(await hot.lookup('热梗')).toEqual({ title: '某某热梗', summary: '一个很火的说法。' })
    expect(await hot.lookup('今天的某某热梗真好笑')).toEqual({ title: '某某热梗', summary: '一个很火的说法。' })
    expect(calls.filter(path => path.startsWith('/events/'))).toEqual(['/events/e1'])
  })

  it('answers nothing for a blank term or a term no title matches, without reading a summary', async () => {
    const { hot, calls } = client({ '/events?': list })
    expect(await hot.lookup('   ')).toBeUndefined()
    expect(calls).toEqual([])
    expect(await hot.lookup('不相干')).toBeUndefined()
    expect(calls).toEqual(['/events?domain=meme&order=heat&limit=5'])
  })

  it('reads a summary again after its lifetime ends', async () => {
    let clock = 0
    const { hot, calls } = client({ '/events?': list, '/events/e1': { summary: '说明' } }, { ttlMs: 100, now: () => clock })
    await hot.lookup('某某热梗')
    clock = 200
    await hot.lookup('某某热梗')
    expect(calls.filter(path => path.startsWith('/events/'))).toHaveLength(2)
  })

  it.each([
    ['a body that is not an object', null],
    ['a summary that is not text', { summary: 5 }],
    ['a summary the filter refuses', { summary: '详情见 https://example.com/x' }],
  ])('answers nothing for %s, and remembers that', async (_name, body) => {
    const { hot, calls, warn } = client({ '/events?': list, '/events/e1': body })
    expect(await hot.lookup('某某热梗')).toBeUndefined()
    expect(await hot.lookup('某某热梗')).toBeUndefined()
    expect(calls.filter(path => path.startsWith('/events/'))).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('cuts a long summary to 300 characters', async () => {
    const { hot } = client({ '/events?': list, '/events/e1': { summary: '字'.repeat(400) } })
    expect(Array.from((await hot.lookup('某某热梗'))!.summary)).toHaveLength(300)
  })

  it('degrades to nothing and warns once when the summary cannot be read', async () => {
    const { hot, warn } = client({ '/events?': list, '/events/e1': 'status:500' })
    expect(await hot.lookup('某某热梗')).toBeUndefined()
    expect(warn).toHaveBeenCalledWith("lsy-style: HotWatch event unavailable (HTTP 500); using the groups' memes only")
  })
})
