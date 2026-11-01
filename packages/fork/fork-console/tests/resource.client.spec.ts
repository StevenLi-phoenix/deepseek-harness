import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ActionFailure, ResourceLoader, createResourceStore, failureOf, requestJson, startPolling, type VisibilitySource,
} from '../src/client/resource.ts'

/** A document double whose visibility the test flips. */
function page(initial: DocumentVisibilityState): VisibilitySource & { show: (state: DocumentVisibilityState) => void; listeners: number } {
  const listeners = new Set<() => void>()
  const doc = {
    visibilityState: initial,
    addEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.add(listener) },
    removeEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.delete(listener) },
    show: (state: DocumentVisibilityState) => { doc.visibilityState = state; for (const listener of listeners) listener() },
    get listeners() { return listeners.size },
  }
  return doc
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ResourceLoader.refresh', () => {
  it('publishes an answer with its time and shares one request between concurrent refreshes', async () => {
    const store = createResourceStore<number>()
    const read = vi.fn(() => Promise.resolve(7))
    const loader = new ResourceLoader('test', store, read, () => 42)
    const pending = Promise.all([loader.refresh(), loader.refresh()])
    expect(store.getSnapshot().refreshing).toBe(true)
    await pending
    expect(read).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toMatchObject({ data: 7, checkedAt: 42, stale: false, refreshing: false })
    await loader.refresh()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('keeps the last data through failures, marks it stale, and warns once per outage', async () => {
    const store = createResourceStore<number>()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const answers: (number | Error)[] = [1, new Error('offline'), new Error('offline'), 2, new Error('again')]
    const loader = new ResourceLoader('test', store, () => {
      const answer = answers.shift()!
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
    })
    await loader.refresh()
    await loader.refresh()
    expect(store.getSnapshot()).toMatchObject({ data: 1, stale: true })
    await loader.refresh()
    expect(warn).toHaveBeenCalledTimes(1)
    await loader.refresh()
    expect(store.getSnapshot()).toMatchObject({ data: 2, stale: false })
    await loader.refresh()
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('ResourceLoader.act', () => {
  it('shows the optimistic patch and the busy mark at once, then takes the Host\'s answer', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const store = createResourceStore<{ rows: string[] }>()
    store.update((draft) => { draft.data = { rows: ['a', 'b'] } })
    const loader = new ResourceLoader('test', store, () => Promise.resolve({ rows: [] }))
    let answer: (value: { rows: string[] }) => void = () => {}
    const accepted = loader.act('delete:a', () => new Promise((resolve) => { answer = resolve }), data => ({ rows: data.rows.filter(row => row !== 'a') }))
    expect(store.getSnapshot()).toMatchObject({ data: { rows: ['b'] }, busy: { 'delete:a': true }, notice: null })
    answer({ rows: ['b', 'c'] })
    expect(await accepted).toBe(true)
    expect(store.getSnapshot()).toMatchObject({ data: { rows: ['b', 'c'] }, busy: {}, stale: false })
  })

  it('puts the previous data back and says why when the Host refuses', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createResourceStore<{ rows: string[] }>()
    store.update((draft) => { draft.data = { rows: ['a'] } })
    const loader = new ResourceLoader('test', store, () => Promise.resolve({ rows: [] }))
    const accepted = await loader.act('delete:a', () => Promise.reject(new ActionFailure('config_owned', 'x')), () => ({ rows: [] }))
    expect(accepted).toBe(false)
    expect(store.getSnapshot()).toMatchObject({ data: { rows: ['a'] }, busy: {}, notice: { kind: 'error', code: 'config_owned', detail: 'x' } })
    loader.dismiss()
    expect(store.getSnapshot().notice).toBeNull()
  })

  it('reports an unexpected failure as a network failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createResourceStore<number>()
    const loader = new ResourceLoader('test', store, () => Promise.resolve(1))
    expect(await loader.act('x', () => Promise.reject(new TypeError('boom')))).toBe(false)
    expect(store.getSnapshot().notice).toMatchObject({ code: 'network' })
  })

  it('logs the action and its outcome, never the body', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const store = createResourceStore<number>()
    const loader = new ResourceLoader('subscriptions', store, () => Promise.resolve(1), () => 5)
    await loader.act('pause:subscription:octo', () => Promise.resolve(2))
    expect(info).toHaveBeenCalledWith('[fork-console] subscriptions pause:subscription:octo ok (0 ms)')
  })
})

describe('requestJson', () => {
  it('sends a body as JSON with the sign-in cookie and no caching', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(Response.json({ ok: true })))
    vi.stubGlobal('fetch', fetchMock)
    expect(await requestJson('api/x', { body: { a: 1 } })).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith('api/x', {
      credentials: 'same-origin', cache: 'no-store', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}',
    })
    await requestJson('api/y')
    expect(fetchMock).toHaveBeenLastCalledWith('api/y', { credentials: 'same-origin', cache: 'no-store' })
  })

  it('turns a refusal into its code and a transport failure into network', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ error: 'not_found', detail: 'schedule' }, { status: 404 })))
    await expect(requestJson('api/x')).rejects.toMatchObject({ code: 'not_found', detail: 'schedule' })
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('<html>', { status: 502 })))
    await expect(requestJson('api/x')).rejects.toMatchObject({ code: 'internal_error' })
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')))
    await expect(requestJson('api/x')).rejects.toMatchObject({ code: 'network' })
    expect(await failureOf(Response.json({ error: 'duplicate_id' }, { status: 409 }))).toMatchObject({ code: 'duplicate_id' })
  })
})

describe('startPolling', () => {
  it('refreshes at once and every interval while the page is visible', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const doc = page('visible')
    const stop = startPolling(refresh, 1000, doc)
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(3000)
    expect(refresh).toHaveBeenCalledTimes(4)
    stop()
    vi.advanceTimersByTime(5000)
    expect(refresh).toHaveBeenCalledTimes(4)
    expect(doc.listeners).toBe(0)
  })

  it('pauses while the page is hidden and refreshes at once when it shows again', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const doc = page('visible')
    startPolling(refresh, 1000, doc)
    doc.show('hidden')
    vi.advanceTimersByTime(10_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    doc.show('visible')
    expect(refresh).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1000)
    expect(refresh).toHaveBeenCalledTimes(3)
  })

  it('polls without a page', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const stop = startPolling(refresh, 500, null)
    vi.advanceTimersByTime(1000)
    expect(refresh).toHaveBeenCalledTimes(3)
    stop()
  })
})
