import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'
import type { SysmonSnapshot } from '../src/snapshot.ts'

interface Registration {
  options: {
    name: string
    id: string
    order: number
    locale: string
    label: () => string
    inject: () => { hooks: unknown; refresh: () => void }
  }
  component: unknown
}

const SNAPSHOT: SysmonSnapshot = {
  sampledAt: 1_000,
  uptime: 600,
  cpu: { usage: 0.5, cores: 10, load: [1, 2, 3] },
  memory: { total: 100, used: 50, swapTotal: 10, swapUsed: 1, approximate: false },
  power: null,
  temperature: null,
  disks: [],
  skippedMounts: [],
  sources: { macmon: 'missing' },
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

/** Run the section's refresh and wait until the store settles. */
async function refreshed(registered: Registration[]) {
  const face = registered[0]!.options.inject()
  face.refresh()
  const store = face.hooks as { sysmon: { getSnapshot: () => { checkedAt: number | null; stale: boolean; snapshot: unknown } } }
  await vi.waitFor(() => { expect(store.sysmon.getSnapshot().checkedAt).not.toBeNull() })
  return store.sysmon.getSnapshot()
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('lsy-sysmon browser entry', () => {
  it('needs the slot registry and the locale', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers the eight dictionaries and the Settings section after Account, General, Models, Plugins, and Agent presets', () => {
    const { ctx, registered, dictionaries } = fakeContext()
    apply(ctx as never)
    expect(Object.keys(dictionaries['lsy.sysmon'] as object).sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'])
    expect((dictionaries['lsy.sysmon'] as { zh: unknown }).zh).toBe(zh)
    const { options } = registered[0]!
    expect([options.name, options.id, options.order, options.locale, options.label()])
      .toEqual(['settings.section', 'lsy-sysmon', 40, 'lsy.sysmon', 'nav'])
  })

  it('reads the route document-relative with the sign-in cookie and publishes the parsed snapshot', async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push([url, init])
      return Promise.resolve(Response.json(SNAPSHOT))
    })
    const { ctx, registered } = fakeContext()
    apply(ctx as never)
    const state = await refreshed(registered)
    expect(calls).toHaveLength(1)
    expect(calls[0]![1]).toEqual({ credentials: 'same-origin', cache: 'no-store' })
    expect(state.snapshot).toEqual(SNAPSHOT)
    expect(state.stale).toBe(false)
    expect(registered[0]!.options.inject().refresh).toBe(registered[0]!.options.inject().refresh)
  })

  it('marks the reading stale when the route answers an error status', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('boom', { status: 502 })))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, registered } = fakeContext()
    apply(ctx as never)
    const state = await refreshed(registered)
    expect(state).toMatchObject({ stale: true, snapshot: null })
  })
})
