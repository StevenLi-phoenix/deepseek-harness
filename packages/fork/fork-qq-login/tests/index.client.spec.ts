import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'
import { QQ_REFRESH_ROUTE, QQ_ROUTE } from '../src/view.ts'

interface Registration {
  options: { name: string; id: string; order: number; label: () => string; locale: string; inject: () => unknown }
  component: unknown
}

interface Face {
  hooks: {
    qq: { getSnapshot: () => { panel: unknown; stale: boolean; codeDeclined: boolean; codeRequested: boolean } }
    groupsForm: unknown
  }
  refresh: () => void
  renewCode: () => void
  addGroup: (id: string) => Promise<boolean>
  removeGroup: (id: string) => Promise<boolean>
}

/** A form double holding one groups list; `set` answers with what the test wants the Host to accept. */
function fakeForm(groups: string[] | undefined, accept: boolean) {
  const set = vi.fn((_field: string, _value: string[]) => Promise.resolve(accept))
  return { set, getSnapshot: () => ({ value: groups === undefined ? undefined : { groups } }) }
}

function fakeContext(form = fakeForm(['111'], true)) {
  const registered: Registration[] = []
  const dictionaries: Record<string, unknown> = {}
  const asked: string[] = []
  const ctx = {
    effect: (run: () => unknown) => run(),
    locale: {
      register: (namespace: string, value: unknown) => { dictionaries[namespace] = value; return () => {} },
      bind: () => (key: string) => key,
    },
    configForms: { get: (namespace: string) => { asked.push(namespace); return form } },
    slots: {
      inject: (_name: string, register: () => unknown) => register(),
      register: (options: Registration['options'], component: unknown) => { registered.push({ options, component }); return () => {} },
    },
  }
  return { ctx, registered, dictionaries, asked, form }
}

const PANEL = {
  at: 1,
  groupsRecorded: 0,
  groups: [],
  connection: { state: 'connected', since: 1, attempt: 0, lastError: null, selfId: '1' },
  login: { door: 'ok', state: 'online', uin: '1', nickname: null, error: null, qr: null },
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('fork-qq-login browser entry', () => {
  it('needs the slot registry, the locale and the config forms', () => {
    expect(inject).toEqual(['slots', 'locale', 'configForms'])
  })

  it('registers one Settings section after System status, with all eight dictionaries', () => {
    const { ctx, registered, dictionaries, asked } = fakeContext()
    apply(ctx as never)
    expect(registered.map(entry => [entry.options.name, entry.options.id, entry.options.order, entry.options.locale])).toEqual([
      ['settings.section', 'fork-qq', 45, 'fork.qq'],
    ])
    expect(registered[0]!.options.label()).toBe('nav')
    expect(Object.keys(dictionaries['fork.qq'] as object).sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'])
    expect((dictionaries['fork.qq'] as { zh: unknown }).zh).toBe(zh)
    expect(asked).toEqual(['fork-qq'])
  })

  it('reads the panel route document-relative with the sign-in cookie into the shared store', async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push([url, init])
      return Promise.resolve(Response.json(PANEL))
    })
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { ctx, registered } = fakeContext()
    apply(ctx as never)
    const face = registered[0]!.options.inject() as Face
    face.refresh()
    await vi.waitFor(() => { expect(face.hooks.qq.getSnapshot().panel).not.toBeNull() })
    expect(calls[0]).toEqual([QQ_ROUTE, { credentials: 'same-origin', cache: 'no-store' }])
    expect((registered[0]!.options.inject() as Face).hooks.qq).toBe(face.hooks.qq)
  })

  it('keeps the last reading and marks it stale when the route answers an error', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('no', { status: 503 })))
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, registered } = fakeContext()
    apply(ctx as never)
    const face = registered[0]!.options.inject() as Face
    face.refresh()
    await vi.waitFor(() => { expect(face.hooks.qq.getSnapshot().stale).toBe(true) })
    expect(face.hooks.qq.getSnapshot().panel).toBeNull()
  })

  it('asks the refresh route with a POST when a fresh code is wanted, and reads the verdict', async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push([url, init])
      return Promise.resolve(Response.json({ ...PANEL, refreshed: true, reason: 'cooldown' }))
    })
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { ctx, registered } = fakeContext()
    apply(ctx as never)
    const face = registered[0]!.options.inject() as Face
    face.renewCode()
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    expect(calls[0]).toEqual([QQ_REFRESH_ROUTE, { method: 'POST', credentials: 'same-origin', cache: 'no-store' }])
    await vi.waitFor(() => { expect(face.hooks.qq.getSnapshot().panel).not.toBeNull() })
    expect(face.hooks.qq.getSnapshot().codeDeclined).toBe(false)
  })

  it('treats a refresh answer without a verdict as not refreshed', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json(PANEL)))
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { ctx, registered } = fakeContext()
    apply(ctx as never)
    const face = registered[0]!.options.inject() as Face
    face.renewCode()
    await vi.waitFor(() => { expect(face.hooks.qq.getSnapshot().panel).not.toBeNull() })
    expect(face.hooks.qq.getSnapshot().codeDeclined).toBe(true)
  })

  it('says the fresh code was declined when the refresh route answers an error', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('no', { status: 500 })))
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, registered } = fakeContext()
    apply(ctx as never)
    const face = registered[0]!.options.inject() as Face
    face.renewCode()
    await vi.waitFor(() => { expect(face.hooks.qq.getSnapshot().codeDeclined).toBe(true) })
    expect(face.hooks.qq.getSnapshot().codeRequested).toBe(false)
  })

  it('writes the list through the form: adds a valid number, refuses a bad one, removes by exact number', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json(PANEL)))
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const form = fakeForm(['111', '222'], true)
    const { ctx, registered } = fakeContext(form)
    apply(ctx as never)
    const face = registered[0]!.options.inject() as Face
    expect(await face.addGroup('333')).toBe(true)
    expect(form.set).toHaveBeenLastCalledWith('groups', ['111', '222', '333'])
    expect(await face.addGroup('x')).toBe(false)
    expect(form.set).toHaveBeenCalledTimes(1)
    expect(await face.removeGroup('111')).toBe(true)
    expect(form.set).toHaveBeenLastCalledWith('groups', ['222'])
  })

  it('does not refresh the panel after a write the form refused', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', (url: string) => { calls.push(url); return Promise.resolve(Response.json(PANEL)) })
    const { ctx, registered } = fakeContext(fakeForm(['111'], false))
    apply(ctx as never)
    const face = registered[0]!.options.inject() as Face
    expect(await face.removeGroup('111')).toBe(false)
    expect(calls).toEqual([])
  })

  it('refuses a write while the form has no list yet', async () => {
    const form = fakeForm(undefined, true)
    const { ctx, registered } = fakeContext(form)
    apply(ctx as never)
    const face = registered[0]!.options.inject() as Face
    expect(await face.addGroup('333')).toBe(false)
    expect(form.set).not.toHaveBeenCalled()
  })
})
