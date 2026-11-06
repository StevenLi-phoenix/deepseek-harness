import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'
import { STYLE_COLLECT_ROUTE, STYLE_EDIT_ROUTE, STYLE_ROUTE } from '../src/view.ts'

interface Registration {
  options: { name: string; id: string; order: number; label: () => string; locale: string; inject: () => unknown }
  component: unknown
}

interface Snapshot { panel: { samples: Array<{ id: string }>; enabled: boolean } | null; error: string | null; stale: boolean }

interface Face {
  hooks: { style: { getSnapshot: () => Snapshot } }
  refresh: () => void
  edit: (edit: { op: 'remove'; id: string }) => Promise<boolean>
  collect: () => void
}

function fakeContext() {
  const registered: Registration[] = []
  const dictionaries: Record<string, unknown> = {}
  const effects: string[] = []
  const ctx = {
    effect: (run: () => unknown, label: string) => { effects.push(label); return run() },
    locale: {
      register: (namespace: string, value: unknown) => { dictionaries[namespace] = value; return () => {} },
      bind: () => (key: string) => key,
    },
    slots: {
      inject: (_name: string, register: () => unknown) => register(),
      register: (options: Registration['options'], component: unknown) => { registered.push({ options, component }); return () => {} },
    },
  }
  return { ctx, registered, dictionaries, effects }
}

const PANEL = { enabled: true, samples: [{ id: 'a' }, { id: 'b' }], trend: [], notes: [], hot: [], cards: [] }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('lsy-style-settings browser entry', () => {
  it('needs the slot registry and the locale, and registers one section with all eight dictionaries', () => {
    expect(inject).toEqual(['slots', 'locale'])
    const { ctx, registered, dictionaries, effects } = fakeContext()
    apply(ctx as never)
    expect(effects).toEqual(['lsy-style: dictionaries'])
    expect(Object.keys(dictionaries['lsy.style'] as object).sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'])
    expect((dictionaries['lsy.style'] as { zh: unknown }).zh).toBe(zh)
    expect(registered).toHaveLength(1)
    expect(registered[0]!.options).toMatchObject({ name: 'settings.section', id: 'lsy-style', order: 47, locale: 'lsy.style' })
    expect(registered[0]!.options.label()).toBe('nav')
  })

  it('reads and collects through document-relative routes with the sign-in cookie, and posts edits as JSON', async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push([url, init])
      const edited = url === STYLE_EDIT_ROUTE
      return Promise.resolve(Response.json(edited ? { ok: true, panel: { ...PANEL, samples: [{ id: 'b' }] } } : PANEL))
    })
    const { ctx, registered } = fakeContext()
    apply(ctx as never)
    const face = registered[0]!.options.inject() as Face
    expect((registered[0]!.options.inject() as Face).refresh).toBe(face.refresh)

    face.refresh()
    await vi.waitFor(() => { expect(face.hooks.style.getSnapshot().panel?.samples).toHaveLength(2) })
    expect(calls[0]).toEqual([STYLE_ROUTE, { credentials: 'same-origin', cache: 'no-store' }])

    expect(await face.edit({ op: 'remove', id: 'a' })).toBe(true)
    expect(calls[1]).toEqual([STYLE_EDIT_ROUTE, {
      credentials: 'same-origin', cache: 'no-store', method: 'POST', body: JSON.stringify({ op: 'remove', id: 'a' }), headers: { 'content-type': 'application/json' },
    }])
    expect(face.hooks.style.getSnapshot().panel?.samples).toEqual([{ id: 'b' }])

    face.collect()
    await vi.waitFor(() => { expect(calls).toHaveLength(3) })
    expect(calls[2]).toEqual([STYLE_COLLECT_ROUTE, { credentials: 'same-origin', cache: 'no-store', method: 'POST' }])
    await vi.waitFor(() => { expect(face.hooks.style.getSnapshot().panel?.samples).toHaveLength(2) })
  })

  it('marks the page stale when the Host answers something that is not a panel', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ error: 'unauthorized' })))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, registered } = fakeContext()
    apply(ctx as never)
    const face = registered[0]!.options.inject() as Face
    face.refresh()
    await vi.waitFor(() => { expect(face.hooks.style.getSnapshot().stale).toBe(true) })
    expect(face.hooks.style.getSnapshot().panel).toBeNull()
  })
})
