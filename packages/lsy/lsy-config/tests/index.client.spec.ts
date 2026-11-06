import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { PluginConfigCard } from '../src/client/PluginConfigCard.tsx'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'
import type { PluginConfigInjected } from '../src/client/slot-contract.ts'
import type { ConfigDescribe, ConfigEntryView, ConfigSaveResult } from '../src/view.ts'

interface Factory {
  options: { name: string; scope: string; locale: string; inject: () => PluginConfigInjected }
  component: unknown
}

function fakeContext() {
  const dictionaries: Record<string, unknown> = {}
  const factories: Factory[] = []
  const labels: string[] = []
  const locale = { getSnapshot: () => ({ active: 'zh' }), subscribe: () => () => {}, register: (ns: string, value: unknown) => { dictionaries[ns] = value; return () => {} } }
  const ctx = {
    effect: (run: () => unknown, label: string) => { labels.push(label); return run() },
    locale,
    slots: { registerFactory: (options: Factory['options'], component: unknown) => { factories.push({ options, component }); return () => {} } },
  }
  return { ctx, dictionaries, factories, labels, locale }
}

const view = (revision: string): ConfigEntryView => ({ id: 'e', found: true, active: true, locked: false, revision, overrides: 0, fields: [] })
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('lsy-config browser entry', () => {
  it('needs the slot registry and the locale', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers the eight dictionaries and the card as the settings.plugin-config factory', () => {
    const { ctx, dictionaries, factories, labels, locale } = fakeContext()
    apply(ctx as never)
    expect(dictionaries['lsy.config']).toEqual({ zh, en, ja, es, fr, de, ru, pt })
    expect(factories).toHaveLength(1)
    expect(factories[0]!.options).toMatchObject({ name: 'settings.plugin-config', scope: 'root', locale: 'lsy.config' })
    expect(factories[0]!.component).toBe(PluginConfigCard)
    expect(labels).toEqual(['lsy-config: dictionaries', 'lsy-config: settings.plugin-config factory'])
    const injected = factories[0]!.options.inject()
    expect(injected.hooks.locale).toBe(locale)
    expect(factories[0]!.options.inject().hooks.pluginConfig).toBe(injected.hooks.pluginConfig)
    expect(factories[0]!.options.inject().load).toBe(injected.load)
  })

  it('reads the entries document-relative with the sign-in cookie, and passes the excluded fields along', async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => { calls.push([url, init]); return Promise.resolve(json({ entries: [view('a')] } satisfies ConfigDescribe)) })
    const { ctx, factories } = fakeContext()
    apply(ctx as never)
    const injected = factories[0]!.options.inject()
    injected.load(['e'], [])
    injected.load(['e'], ['groups', 'media.images'])
    await vi.waitFor(() => {
      const phases = Object.values(injected.hooks.pluginConfig.getSnapshot().entries).map(entry => entry.phase)
      expect(phases).toEqual(['ready', 'ready'])
    })
    expect(calls.map(([url]) => url)).toEqual([
      'api/lsy.config?entries=e',
      'api/lsy.config?entries=e&exclude=groups%2Cmedia.images',
    ])
    expect(calls[0]![1]).toEqual({ credentials: 'same-origin', cache: 'no-store' })
    expect(injected.hooks.pluginConfig.getSnapshot().entries['e\u0000groups,media.images']).toMatchObject({ phase: 'ready', view: { revision: 'a' } })
  })

  it('marks an entry unreachable when the read answers with an error status', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', () => Promise.resolve(json({}, 502)))
    const { ctx, factories } = fakeContext()
    apply(ctx as never)
    const injected = factories[0]!.options.inject()
    injected.load(['e'], [])
    await vi.waitFor(() => { expect(injected.hooks.pluginConfig.getSnapshot().entries['e']?.phase).toBe('unreachable') })
    expect(warn).toHaveBeenCalledWith('[lsy-config] read of e failed: HTTP 502')
  })

  it('posts a save as JSON and returns the Host\'s refusal', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const calls: Array<[string, RequestInit | undefined]> = []
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push([url, init])
      return Promise.resolve(json({ ok: false, reason: 'invalid', message: 'bad value' } satisfies ConfigSaveResult, 422))
    })
    const { ctx, factories } = fakeContext()
    apply(ctx as never)
    const injected = factories[0]!.options.inject()
    expect(await injected.save('e', [], 'a', [{ op: 'clear', path: ['url'] }])).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe('api/lsy.config')
    expect(calls[0]![1]).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' } })
    expect(JSON.parse(calls[0]![1]!.body as string)).toEqual({ id: 'e', revision: 'a', ops: [{ op: 'clear', path: ['url'] }] })
    expect(injected.hooks.pluginConfig.getSnapshot().entries['e']).toMatchObject({ refused: { reason: 'invalid', message: 'bad value' } })
  })

  it('treats an answer that carries no JSON body as a lost answer and waits for the revision to move', async () => {
    vi.useFakeTimers()
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(console, 'info').mockImplementation(() => {})
      let posted = false
      vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posted = true
          return Promise.resolve(new Response('<html>bad gateway</html>', { status: 502 }))
        }
        return Promise.resolve(json({ entries: [view(posted ? 'b' : 'a')] } satisfies ConfigDescribe))
      })
      const { ctx, factories } = fakeContext()
      apply(ctx as never)
      const injected = factories[0]!.options.inject()
      const saving = injected.save('e', [], 'a', [{ op: 'clear', path: ['url'] }])
      await vi.advanceTimersByTimeAsync(750)
      expect(await saving).toBe(true)
      expect(warn).toHaveBeenCalledWith('[lsy-config] save of e [url] got no answer: HTTP 502')
      expect(injected.hooks.pluginConfig.getSnapshot().entries['e']).toMatchObject({ phase: 'ready', view: { revision: 'b' } })
    } finally {
      vi.useRealTimers()
    }
  })
})
