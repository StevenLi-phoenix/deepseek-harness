import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'

interface Registration {
  options: {
    name: string
    id: string
    order: number
    locale: string
    inject: () => { hooks: unknown; refresh: (maxAgeMs: number) => void }
  }
  component: unknown
}

function fakeContext(getBalance: (client: unknown) => Promise<unknown>) {
  const registered: Registration[] = []
  const dictionaries: Record<string, unknown> = {}
  const ctx = {
    effect: (run: () => unknown) => run(),
    locale: {
      register: (namespace: string, value: unknown) => { dictionaries[namespace] = value; return () => {} },
      getSnapshot: () => ({ active: 'zh' }),
    },
    remote: { account: { getBalance } },
    slots: {
      inject: (_name: string, register: () => unknown) => register(),
      register: (options: Registration['options'], component: unknown) => { registered.push({ options, component }); return () => {} },
    },
  }
  return { ctx, registered, dictionaries }
}

const ROUTE_BODY = { readings: [{ source: 'opencode-go', label: 'OpenCode Go', status: 'failed', reason: 'HTTP 500' }] }
const ready = { status: 'ready', value: [{ currency: 'CNY', balance: '1' }], bonusWallets: [] }

/** Run the registered refresh and wait until the store settles. */
async function refreshed(registered: Registration[]) {
  const face = registered[0]!.options.inject()
  face.refresh(0)
  const store = face.hooks as { balance: { getSnapshot: () => { refreshing: boolean; providers: unknown[]; phase: string } } }
  await vi.waitFor(() => {
    const state = store.balance.getSnapshot()
    expect(state.refreshing).toBe(false)
    expect(state.phase).not.toBe('idle')
  })
  return store.balance.getSnapshot()
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('provider-balance browser entry', () => {
  it('needs the slot registry, locale, and the account Remote', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.account'])
  })

  it('registers the eight dictionaries and the card in the Account balances area', () => {
    const { ctx, registered, dictionaries } = fakeContext(() => Promise.resolve({ ok: true, value: ready }))
    apply(ctx as never)
    expect(Object.keys(dictionaries['provider-balance'] as object).sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'])
    expect((dictionaries['provider-balance'] as { zh: unknown }).zh).toBe(zh)
    expect(registered.map(entry => [entry.options.name, entry.options.id, entry.options.order, entry.options.locale])).toEqual([
      ['settings.account.balances', 'provider-balances', 0, 'provider-balance'],
    ])
  })

  it('reads the account balance with client metadata and the Host route document-relative with the sign-in cookie', async () => {
    vi.stubEnv('DSH_CLIENT_VERSION', '9.9.9')
    const getBalance = vi.fn(() => Promise.resolve({ ok: true, value: ready }))
    const calls: Array<[string, RequestInit | undefined]> = []
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push([url, init])
      return Promise.resolve(Response.json(ROUTE_BODY))
    })
    const { ctx, registered } = fakeContext(getBalance)
    apply(ctx as never)
    const state = await refreshed(registered)
    expect(getBalance).toHaveBeenCalledWith({ version: '9.9.9', locale: 'zh', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 })
    expect(calls).toEqual([['api/provider-balance?fresh=1', { credentials: 'same-origin', cache: 'no-store' }]])
    expect(state.providers).toEqual(ROUTE_BODY.readings)
  })

  it('reads the cached route when the refresh does not demand a fresh answer', async () => {
    vi.stubEnv('DSH_CLIENT_VERSION', '9.9.9')
    const urls: string[] = []
    vi.stubGlobal('fetch', (url: string) => { urls.push(url); return Promise.resolve(Response.json(ROUTE_BODY)) })
    const { ctx, registered } = fakeContext(() => Promise.resolve({ ok: true, value: ready }))
    apply(ctx as never)
    registered[0]!.options.inject().refresh(30_000)
    await vi.waitFor(() => { expect(urls).toEqual(['api/provider-balance']) })
  })

  it('keeps no providers when the route answers an error status or a body without readings, and logs a generic failure', async () => {
    vi.stubEnv('DSH_CLIENT_VERSION', '9.9.9')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const answer of [new Response('boom', { status: 502 }), Response.json({ other: 1 }), Response.json(null)]) {
      vi.stubGlobal('fetch', () => Promise.resolve(answer))
      const { ctx, registered } = fakeContext(() => Promise.resolve({ ok: true, value: ready }))
      apply(ctx as never)
      expect((await refreshed(registered)).providers).toEqual([])
    }
    expect(warn).toHaveBeenCalled()
  })

  it('fails the account read when the build carries no version or the Remote answers an error', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json(ROUTE_BODY)))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('DSH_CLIENT_VERSION', '')
    const noVersion = fakeContext(() => Promise.resolve({ ok: true, value: ready }))
    apply(noVersion.ctx as never)
    expect((await refreshed(noVersion.registered)).phase).toBe('failed')
    vi.stubEnv('DSH_CLIENT_VERSION', '9.9.9')
    const failing = fakeContext(() => Promise.resolve({ ok: false, error: { message: 'denied' } }))
    apply(failing.ctx as never)
    expect((await refreshed(failing.registered)).phase).toBe('failed')
  })
})
