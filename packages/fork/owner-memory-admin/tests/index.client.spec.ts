import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'
import type { MemoryActions, MemoryState } from '../src/client/memory.ts'
import { GUARD_ROUTE, MEMORY_ROUTE, type MemoryAction } from '../src/view.ts'
import { DETAIL, GUARD, VIEW } from './fixtures.client.ts'

interface Registration {
  options: { name: string; id: string; order: number; label: () => string; locale: string; inject: () => unknown }
  component: unknown
}

function fakeContext() {
  const registered: Registration[] = []
  const dictionaries: Record<string, unknown> = {}
  const ctx = {
    effect: (run: () => unknown) => run(),
    locale: {
      register: (namespace: string, value: unknown) => { dictionaries[namespace] = value; return () => {} },
      bind: () => (key: string) => key,
    },
    slots: {
      inject: (_name: string, register: () => unknown) => register(),
      register: (options: Registration['options'], component: unknown) => { registered.push({ options, component }); return () => {} },
    },
  }
  return { ctx, registered, dictionaries }
}

interface Injected {
  hooks: { memory: { getSnapshot: () => MemoryState } }
  actions: MemoryActions
}

/** One Host double: records every call and answers by URL and method. */
function stubHost(answer: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: Array<[string, RequestInit | undefined]> = []
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push([url, init])
    return Promise.resolve(answer(url, init))
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  return calls
}

function mounted(): Injected {
  const { ctx, registered } = fakeContext()
  apply(ctx as never)
  return registered[0]!.options.inject() as Injected
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('owner-memory-admin browser entry', () => {
  it('needs the slot registry and the locale', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers the Memory section after the built-in ones, with all eight dictionaries', () => {
    const { ctx, registered, dictionaries } = fakeContext()
    apply(ctx as never)
    expect(registered).toHaveLength(1)
    expect(registered[0]!.options).toMatchObject({ name: 'settings.section', id: 'owner-memory', order: 55, locale: 'owner-memory' })
    expect(registered[0]!.options.label()).toBe('nav')
    expect(Object.keys(dictionaries['owner-memory'] as object).sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'])
    expect((dictionaries['owner-memory'] as { zh: unknown }).zh).toBe(zh)
  })

  it('reads the view with the query and the guard document-relative, with the sign-in cookie', async () => {
    const calls = stubHost(url => Response.json(url === GUARD_ROUTE ? { health: GUARD } : VIEW))
    const face = mounted()
    await face.actions.setQuery({ q: 'alice', category: 'projects' })
    const read = calls.find(([url]) => url.startsWith(MEMORY_ROUTE))!
    expect(read[0]).toBe(`${MEMORY_ROUTE}?category=projects&offset=0&limit=20&q=alice`)
    expect(read[1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store' })
    expect(calls.some(([url]) => url === GUARD_ROUTE)).toBe(true)
    expect(face.hooks.memory.getSnapshot()).toMatchObject({ view: VIEW, guard: GUARD, stale: false })
  })

  it('leaves the guard card hidden when its route refuses or answers something else', async () => {
    stubHost(url => (url === GUARD_ROUTE ? new Response('no', { status: 404 }) : Response.json(VIEW)))
    const face = mounted()
    await face.actions.refresh()
    expect(face.hooks.memory.getSnapshot().guard).toBeNull()
    vi.unstubAllGlobals()
    stubHost(url => (url === GUARD_ROUTE ? new Response('not json') : Response.json(VIEW)))
    const second = mounted()
    await second.actions.refresh()
    expect(second.hooks.memory.getSnapshot().guard).toBeNull()
  })

  it('fetches one entry\'s detail by encoded id and posts actions as JSON', async () => {
    const calls = stubHost((_url, init) => (init?.method === 'POST'
      ? Response.json({ action: 'feedback.forget', id: 'x' })
      : Response.json(DETAIL)))
    const face = mounted()
    await face.actions.loadDetail('b/b')
    expect(calls[0]![0]).toBe(`${MEMORY_ROUTE}?id=b%2Fb`)
    expect(face.hooks.memory.getSnapshot().details['b/b']).toEqual({ status: 'ready', detail: DETAIL })
    const action: MemoryAction = { action: 'feedback.forget', id: 'dddddd' }
    await face.actions.feedbackForget('dddddd')
    const post = calls.find(([, init]) => init?.method === 'POST')!
    expect(post[0]).toBe(MEMORY_ROUTE)
    expect(post[1]).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) })
  })

  it('carries the Host\'s reason and code from a refused request to the owner', async () => {
    stubHost((_url, init) => (init?.method === 'POST'
      ? Response.json({ error: 'memory holds 1000 entries', code: 'full' }, { status: 409 })
      : Response.json(VIEW)))
    const face = mounted()
    await face.actions.feedbackAdd({ action: 'feedback.add', scope: 'up', verdict: 'keep', kind: 'dm', text: 'x' })
    expect(face.hooks.memory.getSnapshot().error).toEqual({ code: 'full', message: 'memory holds 1000 entries' })
  })

  it('words a refusal that has no readable reason by its HTTP status', async () => {
    stubHost((_url, init) => (init?.method === 'POST'
      ? new Response('<html>', { status: 502 })
      : Response.json(VIEW)))
    const face = mounted()
    await face.actions.feedbackAdd({ action: 'feedback.add', scope: 'up', verdict: 'keep', kind: 'dm', text: 'x' })
    expect(face.hooks.memory.getSnapshot().error).toEqual({ code: null, message: 'HTTP 502' })
    stubHost((_url, init) => (init?.method === 'POST' ? Response.json({ error: 7, code: 7 }, { status: 500 }) : Response.json(VIEW)))
    const again = mounted()
    await again.actions.feedbackAdd({ action: 'feedback.add', scope: 'up', verdict: 'keep', kind: 'dm', text: 'x' })
    expect(again.hooks.memory.getSnapshot().error).toEqual({ code: null, message: 'HTTP 500' })
  })

  it('wires every action to the one shared loader', async () => {
    const posts: MemoryAction[] = []
    stubHost((_url, init) => {
      if (init?.method !== 'POST') return Response.json(VIEW)
      const action = JSON.parse(init.body as string) as MemoryAction
      posts.push(action)
      if (action.action === 'rollback') {
        return Response.json(action.confirm === undefined
          ? { action: 'rollback', stage: 'preview', matched: 1, restored: 1, removed: 0, token: 'a'.repeat(64), items: [] }
          : { action: 'rollback', stage: 'done', matched: 1, restored: 1, removed: 0 })
      }
      if (action.action === 'forget') {
        return Response.json(action.confirm === undefined
          ? { action: 'forget', stage: 'preview', token: 'b'.repeat(64), items: [] }
          : { action: 'forget', stage: 'done', items: [] })
      }
      if (action.action === 'approve') return Response.json({ action: 'approve', results: [{ id: 'aaaaaa', ok: true, outcome: 'kept' }] })
      return Response.json({ action: 'feedback.forget', id: 'x' })
    })
    const face = mounted()
    const snapshot = (): MemoryState => face.hooks.memory.getSnapshot()
    await face.actions.review('approve', ['aaaaaa'])
    await face.actions.rollbackPreview({ session: 's' })
    expect(snapshot().rollback?.stage).toBe('ready')
    await face.actions.rollbackApply()
    expect(snapshot().rollback?.stage).toBe('done')
    face.actions.rollbackCancel()
    expect(snapshot().rollback).toBeNull()
    await face.actions.purgePreview(['bbbbbb'])
    expect(snapshot().purge?.stage).toBe('ready')
    face.actions.purgeCancel()
    expect(snapshot().purge).toBeNull()
    await face.actions.purgePreview(['bbbbbb'])
    await face.actions.purgeApply()
    expect(snapshot().purge).toBeNull()
    expect(posts.map(post => post.action)).toEqual(['approve', 'rollback', 'rollback', 'forget', 'forget', 'forget'])
    await face.actions.feedbackAdd({ action: 'feedback.add', scope: 'up', verdict: 'keep', kind: 'dm', text: 'x' })
    face.actions.dismissError()
    expect(snapshot().error).toBeNull()
  })

  it('gives the same actions to every render of the section', () => {
    const { ctx, registered } = fakeContext()
    apply(ctx as never)
    const first = registered[0]!.options.inject() as Injected
    const second = registered[0]!.options.inject() as Injected
    expect(second.actions).toBe(first.actions)
    expect(second.hooks.memory).toBe(first.hooks.memory)
  })
})
