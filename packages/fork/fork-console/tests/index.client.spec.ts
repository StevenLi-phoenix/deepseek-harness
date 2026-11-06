import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'

interface Registration {
  options: { name: string; id: string; key?: string; order: number; label: () => string; locale: string; inject: () => unknown }
  component: unknown
}

function fakeContext(entries: { options: { id?: string; order?: number } }[] = [], services: Record<string, unknown> = {}) {
  const registered: Registration[] = []
  const dictionaries: Record<string, unknown> = {}
  const effects: Array<() => unknown> = []
  const ctx = {
    effect: (run: () => unknown) => { effects.push(run); return run() },
    get: (name: string) => services[name],
    locale: {
      register: (namespace: string, value: unknown) => { dictionaries[namespace] = value; return () => {} },
      bind: () => (key: string) => key,
    },
    slots: {
      inject: (_name: string, register: () => unknown) => register(),
      register: (options: Registration['options'], component: unknown) => { registered.push({ options, component }); return () => {} },
      entries: () => entries,
    },
  }
  return { ctx, registered, dictionaries, effects }
}

afterEach(() => { vi.unstubAllGlobals() })

const sections = (registered: Registration[]): Registration[] => registered.filter(entry => entry.options.name === 'settings.section')
const flowPage = (registered: Registration[]): Registration => registered.find(entry => entry.options.name === 'main')!
const flowEntry = (registered: Registration[]): Registration => registered.find(entry => entry.options.name === 'sidebar.panellist')!

describe('fork-console browser entry', () => {
  it('needs the slot registry and the locale', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers three Settings sections, the message flow as a page of its own, and all eight dictionaries', () => {
    const { ctx, registered, dictionaries } = fakeContext()
    apply(ctx as never)
    expect(sections(registered).map(entry => [entry.options.id, entry.options.order, entry.options.locale])).toEqual([
      ['fork-overview', 35, 'fork.console'],
      ['fork-subscriptions', 58, 'fork.console'],
      ['fork-agents', 60, 'fork.console'],
    ])
    expect(sections(registered).map(entry => entry.options.label())).toEqual(['nav.overview', 'nav.subscriptions', 'nav.agents'])
    expect(flowPage(registered).options).toMatchObject({ key: 'fork-flow', locale: 'fork.console' })
    expect(flowEntry(registered).options).toMatchObject({ id: 'fork-flow', order: 20, locale: 'fork.console' })
    expect(flowEntry(registered).options.label()).toBe('nav.flow')
    expect(Object.keys(dictionaries['fork.console'] as object).sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'])
    expect((dictionaries['fork.console'] as { zh: unknown }).zh).toBe(zh)
  })

  it('gives each section its own stable faces: store hook, refresh, and the actions', () => {
    const { ctx, registered } = fakeContext([{ options: { id: 'bili', order: 45 } }, { options: { id: 'general', order: 0 } }])
    apply(ctx as never)
    const [overview, subscriptions, agents] = sections(registered).map(entry => entry.options.inject() as Record<string, unknown>)
    const flow = flowPage(registered).options.inject() as Record<string, unknown>
    expect(Object.keys((overview!.hooks as object))).toEqual(['overview', 'balance'])
    expect(Object.keys((subscriptions!.hooks as object))).toEqual(['subscriptions'])
    expect(Object.keys((agents!.hooks as object))).toEqual(['agents'])
    expect(Object.keys((flow.hooks as object))).toEqual(['overview', 'activity'])
    expect((flow.hooks as { overview: unknown }).overview).toBe((overview!.hooks as { overview: unknown }).overview)
    expect(overview).not.toHaveProperty('manage')
    expect((overview!.canManage as (id: string) => boolean)('bili')).toBe(true)
    expect((overview!.canManage as (id: string) => boolean)('fork-qq')).toBe(false)
    const again = registered[0]!.options.inject() as Record<string, unknown>
    expect(again.refresh).toBe(overview!.refresh)
    for (const face of [subscriptions!, agents!]) {
      expect(typeof face.refresh).toBe('function')
      expect(typeof face.act).toBe('function')
    }
  })

  it('reads the routes document-relative with the sign-in cookie, and posts actions as JSON', async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push([url, init])
      return Promise.resolve(Response.json({
        cards: [], checkedAt: 1, subscriptions: [], schedules: null, defaults: {}, cc: null, voice: null, readings: [],
      }))
    })
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { ctx, registered } = fakeContext()
    apply(ctx as never)
    type Face = { refresh: () => void; act?: (request: unknown) => Promise<boolean> }
    const faces = sections(registered).map(entry => entry.options.inject() as Face)
    faces[0]!.refresh()
    faces[1]!.refresh()
    faces[2]!.refresh()
    await vi.waitFor(() => { expect(calls).toHaveLength(4) })
    expect(calls.map(([url]) => url).sort()).toEqual(['api/fork.agents', 'api/fork.balance', 'api/fork.overview', 'api/fork.subscriptions'])
    expect(await faces[1]!.act!({ action: 'delete', target: 'subscription', id: 'x' })).toBe(true)
    expect(calls.at(-1)).toEqual(['api/fork.subscriptions', {
      credentials: 'same-origin', cache: 'no-store', method: 'POST', headers: { 'content-type': 'application/json' },
      body: '{"action":"delete","target":"subscription","id":"x"}',
    }])
    expect(await faces[2]!.act!({ action: 'cc.stop', name: 'one' })).toBe(true)
    expect(calls.at(-1)![1]).toMatchObject({ method: 'POST', body: '{"action":"cc.stop","name":"one"}' })
  })

  it('reads the message flow from the overview and its own route together, each once per refresh', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(url)
      return Promise.resolve(Response.json({
        cards: [], checkedAt: 1, recent: [], presence: null,
        windows: Object.fromEntries(['1h', '24h', '7d'].map(span => [span, { funnel: { events: 0, batches: 0, sent: 0, silent: 0, failed: 0 }, sources: {}, subscriptions: {} }])),
      }))
    })
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { ctx, registered } = fakeContext()
    apply(ctx as never)
    const face = flowPage(registered).options.inject() as { refresh: () => void }
    face.refresh()
    await vi.waitFor(() => { expect(calls).toHaveLength(2) })
    expect(calls.sort()).toEqual(['api/fork.flow', 'api/fork.overview'])
  })

  it('opens a Settings section through the settings shell when it is there, and does nothing when it is not', () => {
    const openSection = vi.fn()
    const mounted = fakeContext([], { settingsNavigation: { openSection } })
    apply(mounted.ctx as never)
    ;(flowPage(mounted.registered).options.inject() as { openSettings: (id: string) => void }).openSettings('fork-qq')
    expect(openSection).toHaveBeenCalledWith('fork-qq')
    const bare = fakeContext()
    apply(bare.ctx as never)
    expect(() => { (flowPage(bare.registered).options.inject() as { openSettings: (id: string) => void }).openSettings('fork-qq') }).not.toThrow()
  })

  describe('voice preview', () => {
    /** An audio element double that plays on request and ends when the test says. */
    class FakeAudio {
      static last: FakeAudio | undefined
      static playResult: 'ok' | 'rejected' = 'ok'
      readonly listeners = new Map<string, () => void>()
      paused = false
      constructor(readonly src: string) { FakeAudio.last = this }
      addEventListener(type: string, listener: () => void): void { this.listeners.set(type, listener) }
      play(): Promise<void> { return FakeAudio.playResult === 'ok' ? Promise.resolve() : Promise.reject(new Error('blocked')) }
      pause(): void { this.paused = true }
    }

    function previewFace() {
      const { ctx, registered } = fakeContext()
      apply(ctx as never)
      return sections(registered)[2]!.options.inject() as { preview: (onPlaying: () => void) => Promise<unknown>; stopPreview: () => void }
    }

    it('posts the preview request, plays the audio in the browser, and ends when it ends', async () => {
      FakeAudio.playResult = 'ok'
      vi.stubGlobal('Audio', FakeAudio)
      vi.spyOn(console, 'info').mockImplementation(() => {})
      const fetchMock = vi.fn(() => Promise.resolve(new Response(new Blob(['ID3'], { type: 'audio/mpeg' }), { headers: { 'content-type': 'audio/mpeg' } })))
      vi.stubGlobal('fetch', fetchMock)
      const face = previewFace()
      const onPlaying = vi.fn()
      const done = face.preview(onPlaying)
      await vi.waitFor(() => { expect(onPlaying).toHaveBeenCalled() })
      expect(fetchMock).toHaveBeenCalledWith('api/fork.agents', expect.objectContaining({
        method: 'POST', credentials: 'same-origin', body: '{"action":"voice.preview"}', signal: expect.any(AbortSignal) as AbortSignal,
      }))
      expect(FakeAudio.last!.src).toMatch(/^blob:/u)
      FakeAudio.last!.listeners.get('ended')!()
      expect(await done).toEqual({ ok: true })
      expect(FakeAudio.last!.paused).toBe(true)
    })

    it('reports the Host\'s refusal, a lost connection, and audio the browser would not play', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const face = previewFace()
      vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ error: 'speech_failed', detail: 'feiyu timed out' }, { status: 502 })))
      expect(await face.preview(() => {})).toEqual({ ok: false, code: 'speech_failed', detail: 'feiyu timed out' })
      vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')))
      expect(await face.preview(() => {})).toEqual({ ok: false, code: 'network' })
      vi.spyOn(console, 'info').mockImplementation(() => {})
      FakeAudio.playResult = 'rejected'
      vi.stubGlobal('Audio', FakeAudio)
      vi.stubGlobal('fetch', () => Promise.resolve(new Response(new Blob(['ID3']), { headers: { 'content-type': 'audio/mpeg' } })))
      expect(await face.preview(() => {})).toEqual({ ok: false, code: 'speech_failed', detail: 'playback' })
    })

    it('stops a preview that is playing', async () => {
      FakeAudio.playResult = 'ok'
      vi.stubGlobal('Audio', FakeAudio)
      vi.spyOn(console, 'info').mockImplementation(() => {})
      vi.stubGlobal('fetch', () => Promise.resolve(new Response(new Blob(['ID3']), { headers: { 'content-type': 'audio/mpeg' } })))
      const face = previewFace()
      const onPlaying = vi.fn()
      void face.preview(onPlaying)
      await vi.waitFor(() => { expect(onPlaying).toHaveBeenCalled() })
      face.stopPreview()
      expect(FakeAudio.last!.paused).toBe(true)
    })
  })
})
