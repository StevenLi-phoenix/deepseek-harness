import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MemoryLoader, MemoryRequestError, createMemoryStore, parseGuard, parseView, startPolling, type VisibilitySource,
} from '../src/client/memory.ts'
import type { ActionResult } from '../src/view.ts'
import { GUARD, VIEW, fakeApi } from './fixtures.client.ts'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

/** A promise the test settles by hand. */
function gate<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const PREVIEW: ActionResult = {
  action: 'rollback', stage: 'preview', matched: 2, restored: 1, removed: 1, token: 'a'.repeat(64),
  items: [{ id: 'bbbbbb', change: 'remove', category: 'instructions', now: 'x' }],
}

describe('parseView', () => {
  it('accepts the Host shape and refuses anything else', () => {
    expect(parseView(VIEW)).toBe(VIEW)
    expect(() => parseView({})).toThrow('unexpected memory answer')
    expect(() => parseView(null)).toThrow('unexpected memory answer')
  })
})

describe('parseGuard', () => {
  it('accepts the guard route\'s answer and treats anything else as no guard', () => {
    expect(parseGuard({ health: GUARD })).toBe(GUARD)
    expect(parseGuard({})).toBeNull()
    expect(parseGuard(null)).toBeNull()
    expect(parseGuard({ health: { checked: 1 } })).toBeNull()
  })
})

describe('MemoryLoader guard card data', () => {
  it('reads the guard with the memory view, hides it when the route fails, and never fails the memory read for it', async () => {
    const store = createMemoryStore()
    await new MemoryLoader(store, fakeApi({ guard: () => GUARD }), () => 1).refresh()
    expect(store.getSnapshot()).toMatchObject({ view: VIEW, guard: GUARD, stale: false })
    await new MemoryLoader(store, fakeApi({ guard: () => { throw new Error('404') } }), () => 2).refresh()
    expect(store.getSnapshot()).toMatchObject({ view: VIEW, guard: null, stale: false })
    await new MemoryLoader(store, fakeApi({ guard: () => GUARD }), () => 3).refresh()
    await new MemoryLoader(store, fakeApi(), () => 4).refresh()
    expect(store.getSnapshot().guard).toBeNull()
  })
})

describe('MemoryLoader reads', () => {
  it('publishes an answer with its time, shares one read between concurrent refreshes, and keeps the view through a failure', async () => {
    const store = createMemoryStore()
    const api = fakeApi()
    const loader = new MemoryLoader(store, api, () => 42)
    await Promise.all([loader.refresh(), loader.refresh()])
    expect(api.reads).toHaveLength(1)
    expect(store.getSnapshot()).toMatchObject({ view: VIEW, checkedAt: 42, stale: false })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failing = new MemoryLoader(store, fakeApi({ read: () => { throw new Error('down') } }), () => 99)
    await failing.refresh()
    await failing.refresh()
    expect(store.getSnapshot()).toMatchObject({ view: VIEW, checkedAt: 99, stale: true })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('a changed query goes back to the first page, and the old query\'s late answer is dropped', async () => {
    const store = createMemoryStore()
    const slow = gate<typeof VIEW>()
    let calls = 0
    const api = fakeApi({ read: () => (calls++ === 0 ? slow.promise : { ...VIEW, total: 7 }) })
    const loader = new MemoryLoader(store, api)
    const first = loader.refresh()
    await loader.setQuery({ q: 'alice' })
    expect(store.getSnapshot().query).toMatchObject({ q: 'alice', offset: 0 })
    expect(store.getSnapshot().view?.total).toBe(7)
    slow.resolve({ ...VIEW, total: 1 })
    await first
    expect(store.getSnapshot().view?.total).toBe(7)
    await loader.setQuery({ offset: 40 })
    expect(store.getSnapshot().query.offset).toBe(40)
  })

  it('steps back to the last page that has entries when the current page ran out', async () => {
    const store = createMemoryStore()
    const api = fakeApi({ read: query => (query.offset >= 40 ? { ...VIEW, entries: { items: [], matched: 21 } } : VIEW) })
    const loader = new MemoryLoader(store, api)
    await loader.setQuery({ offset: 40 })
    expect(api.reads.map(query => query.offset)).toEqual([40, 20])
  })
})

describe('MemoryLoader review', () => {
  it('hides a waiting write at once, and keeps it hidden while the Host answers', async () => {
    const store = createMemoryStore()
    const answer = gate<ActionResult>()
    const api = fakeApi({ post: () => answer.promise })
    const loader = new MemoryLoader(store, api)
    await loader.refresh()
    const done = loader.review('approve', ['aaaaaa'])
    expect(store.getSnapshot()).toMatchObject({ hiding: ['aaaaaa'], busy: ['aaaaaa'] })
    answer.resolve({ action: 'approve', results: [{ id: 'aaaaaa', ok: true, outcome: 'kept' }] })
    await done
    expect(api.posts).toEqual([{ action: 'approve', ids: ['aaaaaa'] }])
    expect(store.getSnapshot()).toMatchObject({ hiding: [], busy: [], error: null })
    // The answer is followed by a fresh read.
    expect(api.reads.length).toBeGreaterThanOrEqual(2)
  })

  it('brings a refused item back with the Host\'s reason, and does the same on a transport failure', async () => {
    const store = createMemoryStore()
    const api = fakeApi({
      post: () => ({ action: 'approve', results: [{ id: 'aaaaaa', ok: false, failure: { code: 'full', message: 'memory holds 1000 entries' } }] }),
    })
    const loader = new MemoryLoader(store, api)
    await loader.refresh()
    await loader.review('approve', ['aaaaaa'])
    expect(store.getSnapshot()).toMatchObject({ hiding: [], error: { code: 'full', message: 'memory holds 1000 entries' } })
    const broken = new MemoryLoader(store, fakeApi({ post: () => { throw new MemoryRequestError('HTTP 500') } }))
    await broken.review('discard', ['aaaaaa'])
    expect(store.getSnapshot()).toMatchObject({ hiding: [], error: { message: 'HTTP 500' } })
    broken.dismissError()
    expect(store.getSnapshot().error).toBeNull()
  })

  it('does not hide an entry it only reverts, and drops that entry\'s cached detail', async () => {
    const store = createMemoryStore()
    const loader = new MemoryLoader(store, fakeApi({ post: () => ({ action: 'revert', results: [{ id: 'bbbbbb', ok: true, outcome: 'removed' }] }) }))
    await loader.loadDetail('bbbbbb')
    expect(store.getSnapshot().details['bbbbbb']?.status).toBe('ready')
    const done = loader.review('revert', ['bbbbbb'])
    expect(store.getSnapshot().hiding).toEqual([])
    await done
    expect(store.getSnapshot().details['bbbbbb']).toBeUndefined()
  })
})

describe('MemoryLoader detail', () => {
  it('loads once, shows loading meanwhile, and reports a failure', async () => {
    const store = createMemoryStore()
    const answer = gate<never>()
    const api = fakeApi({ detail: () => answer.promise })
    const loader = new MemoryLoader(store, api)
    const pending = loader.loadDetail('bbbbbb')
    expect(store.getSnapshot().details['bbbbbb']).toEqual({ status: 'loading' })
    answer.reject(new Error('x'))
    await pending
    expect(store.getSnapshot().details['bbbbbb']).toEqual({ status: 'error' })
    const ok = fakeApi()
    const again = new MemoryLoader(store, ok)
    await again.loadDetail('bbbbbb')
    await again.loadDetail('bbbbbb')
    expect(ok.details).toEqual(['bbbbbb'])
  })
})

describe('MemoryLoader rollback and erase', () => {
  it('asks for a preview first, applies with its token, and shows the result', async () => {
    const store = createMemoryStore()
    const api = fakeApi({
      post: action => (action.action === 'rollback' && action.confirm !== undefined
        ? { action: 'rollback', stage: 'done', matched: 2, restored: 1, removed: 1 }
        : PREVIEW),
    })
    const loader = new MemoryLoader(store, api)
    await loader.rollbackApply()
    expect(api.posts).toEqual([])
    await loader.rollbackPreview({ session: 'sess-bad-000000' })
    expect(store.getSnapshot().rollback).toMatchObject({ stage: 'ready', preview: { token: 'a'.repeat(64) } })
    expect(api.posts).toEqual([{ action: 'rollback', session: 'sess-bad-000000' }])
    await loader.rollbackApply()
    expect(api.posts.at(-1)).toEqual({ action: 'rollback', session: 'sess-bad-000000', confirm: 'a'.repeat(64) })
    expect(store.getSnapshot().rollback).toMatchObject({ stage: 'done', restored: 1, removed: 1 })
    loader.rollbackCancel()
    expect(store.getSnapshot().rollback).toBeNull()
  })

  it('drops the preview when the Host says memory changed, so the owner must preview again', async () => {
    const store = createMemoryStore()
    const api = fakeApi({
      post: (action) => {
        if (action.action === 'rollback' && action.confirm !== undefined) throw new MemoryRequestError('changed', 'stale_preview')
        return PREVIEW
      },
    })
    const loader = new MemoryLoader(store, api)
    await loader.rollbackPreview({ since: '2026-10-31T00:00:00.000Z' })
    await loader.rollbackApply()
    expect(store.getSnapshot()).toMatchObject({ rollback: null, error: { code: 'stale_preview' } })
  })

  it('shows what an erase would remove, and erases only with the preview\'s token', async () => {
    const store = createMemoryStore()
    const api = fakeApi({
      post: action => (action.action === 'forget' && action.confirm !== undefined
        ? { action: 'forget', stage: 'done', items: [] }
        : { action: 'forget', stage: 'preview', token: 'b'.repeat(64), items: [{ id: 'bbbbbb', found: true, history: 2, snapshots: 1, pending: 0 }] }),
    })
    const loader = new MemoryLoader(store, api)
    await loader.purgeApply()
    expect(api.posts).toEqual([])
    await loader.purgePreview(['bbbbbb'])
    expect(store.getSnapshot().purge).toMatchObject({ stage: 'ready', ids: ['bbbbbb'] })
    await loader.purgeApply()
    expect(api.posts.at(-1)).toEqual({ action: 'forget', ids: ['bbbbbb'], confirm: 'b'.repeat(64) })
    expect(store.getSnapshot().purge).toBeNull()
    await loader.purgePreview(['bbbbbb'])
    loader.purgeCancel()
    expect(store.getSnapshot().purge).toBeNull()
  })
})

describe('MemoryLoader feedback', () => {
  it('adds a verdict and reports whether the Host took it', async () => {
    const store = createMemoryStore()
    let refuse = true
    const api = fakeApi({ post: () => { if (refuse) throw new MemoryRequestError('text is empty', 'invalid_input'); return { action: 'feedback.add', outcome: 'added', id: 'dddddd' } } })
    const loader = new MemoryLoader(store, api)
    const input = { action: 'feedback.add', scope: 'up', verdict: 'keep', kind: 'dm', text: 'x' } as const
    expect(await loader.feedbackAdd(input)).toBe(false)
    expect(store.getSnapshot().error).toMatchObject({ code: 'invalid_input' })
    refuse = false
    expect(await loader.feedbackAdd(input)).toBe(true)
    expect(store.getSnapshot().error).toBeNull()
    await loader.feedbackForget('dddddd')
    expect(api.posts.at(-1)).toEqual({ action: 'feedback.forget', id: 'dddddd' })
    expect(store.getSnapshot().busy).toEqual([])
  })
})

describe('startPolling', () => {
  function page(initial: DocumentVisibilityState) {
    const listeners = new Set<() => void>()
    const doc = {
      visibilityState: initial,
      addEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.add(listener) },
      removeEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.delete(listener) },
      show: (state: DocumentVisibilityState) => { doc.visibilityState = state; for (const listener of listeners) listener() },
    }
    return doc satisfies VisibilitySource & { show: (state: DocumentVisibilityState) => void }
  }

  it('refreshes now and on the interval while visible, pauses while hidden, and stops on cleanup', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const doc = page('visible')
    const stop = startPolling(refresh, 1000, doc)
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2000)
    expect(refresh).toHaveBeenCalledTimes(3)
    doc.show('hidden')
    vi.advanceTimersByTime(5000)
    expect(refresh).toHaveBeenCalledTimes(3)
    doc.show('visible')
    expect(refresh).toHaveBeenCalledTimes(4)
    stop()
    vi.advanceTimersByTime(5000)
    expect(refresh).toHaveBeenCalledTimes(4)
  })
})
