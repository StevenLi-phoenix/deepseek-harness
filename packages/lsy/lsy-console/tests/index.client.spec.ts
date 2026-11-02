import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'

interface Registration {
  options: { name: string; id: string; order: number; label: () => string; locale: string; inject: () => unknown }
  component: unknown
}

function fakeContext(entries: { options: { id?: string; order?: number } }[] = []) {
  const registered: Registration[] = []
  const dictionaries: Record<string, unknown> = {}
  const effects: Array<() => unknown> = []
  const ctx = {
    effect: (run: () => unknown) => { effects.push(run); return run() },
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

describe('lsy-console browser entry', () => {
  it('needs the slot registry and the locale', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers the four sections with their ids and orders, and all eight dictionaries', () => {
    const { ctx, registered, dictionaries } = fakeContext()
    apply(ctx as never)
    expect(registered.map(entry => [entry.options.name, entry.options.id, entry.options.order, entry.options.locale])).toEqual([
      ['settings.section', 'lsy-overview', 35, 'lsy.console'],
      ['settings.section', 'lsy-flow', 36, 'lsy.console'],
      ['settings.section', 'lsy-subscriptions', 58, 'lsy.console'],
      ['settings.section', 'lsy-agents', 60, 'lsy.console'],
    ])
    expect(registered.map(entry => entry.options.label())).toEqual(['nav.overview', 'nav.flow', 'nav.subscriptions', 'nav.agents'])
    expect(Object.keys(dictionaries['lsy.console'] as object).sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'])
    expect((dictionaries['lsy.console'] as { zh: unknown }).zh).toBe(zh)
  })

  it('gives each section its own stable faces: store hook, refresh, and the actions', () => {
    const { ctx, registered } = fakeContext([{ options: { id: 'bili', order: 45 } }, { options: { id: 'general', order: 0 } }])
    apply(ctx as never)
    const [overview, flow, subscriptions, agents] = registered.map(entry => entry.options.inject() as Record<string, unknown>)
    expect(Object.keys((overview!.hooks as object))).toEqual(['overview', 'balance'])
    expect(Object.keys((subscriptions!.hooks as object))).toEqual(['subscriptions'])
    expect(Object.keys((agents!.hooks as object))).toEqual(['agents'])
    expect(Object.keys((flow!.hooks as object))).toEqual(['overview'])
    expect(overview).not.toHaveProperty('manage')
    expect((overview!.canManage as (id: string) => boolean)('bili')).toBe(true)
    expect((overview!.canManage as (id: string) => boolean)('lsy-qq')).toBe(false)
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
    const faces = registered.map(entry => entry.options.inject() as { refresh: () => void; act?: (request: unknown) => Promise<boolean> })
    faces[0]!.refresh()
    faces[2]!.refresh()
    faces[3]!.refresh()
    await vi.waitFor(() => { expect(calls).toHaveLength(4) })
    expect(calls.map(([url]) => url).sort()).toEqual(['api/lsy.agents', 'api/lsy.balance', 'api/lsy.overview', 'api/lsy.subscriptions'])
    expect(await faces[2]!.act!({ action: 'delete', target: 'subscription', id: 'x' })).toBe(true)
    expect(calls.at(-1)).toEqual(['api/lsy.subscriptions', {
      credentials: 'same-origin', cache: 'no-store', method: 'POST', headers: { 'content-type': 'application/json' },
      body: '{"action":"delete","target":"subscription","id":"x"}',
    }])
    expect(await faces[3]!.act!({ action: 'cc.stop', name: 'one' })).toBe(true)
    expect(calls.at(-1)![1]).toMatchObject({ method: 'POST', body: '{"action":"cc.stop","name":"one"}' })
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
      return registered[3]!.options.inject() as { preview: (onPlaying: () => void) => Promise<unknown>; stopPreview: () => void }
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
      expect(fetchMock).toHaveBeenCalledWith('api/lsy.agents', expect.objectContaining({
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
