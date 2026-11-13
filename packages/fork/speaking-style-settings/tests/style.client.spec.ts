import { describe, expect, it, vi } from 'vitest'
import { createStyleStore, parseEditAnswer, parsePanel, pollWhileVisible, StyleLoader, type StylePanel } from '../src/client/style.ts'

const ORIGIN = { platform: 'qq', groups: 1, speakers: 2, days: 1 } as const
const panel = (over: Partial<StylePanel> = {}): StylePanel => ({
  enabled: true, review: 'optional', limits: { maxActive: 60, maxOwner: 20, maxMemes: 40, maxTraits: 10, cardChars: 600 }, running: false, lastRun: null, lastMine: null, nextRunAt: null, trend: [],
  samples: [
    { id: 'a', source: 'qq', owner: false, status: 'active', addedAt: 'x', prompt: '周末去哪', reply: '宅着', origin: ORIGIN },
    { id: 'b', source: 'qq', owner: false, status: 'pending', addedAt: 'x', prompt: '在吗', reply: '在', origin: ORIGIN },
  ],
  parts: { tone: true, memes: true, traits: true, persona: true, miner: true },
  notes: [{ id: 'm1', kind: 'meme', term: '典中典', meaning: '老套到成了经典', example: '典中典', source: 'qq', firstSeen: 1, lastSeen: 2 }],
  hot: [{ title: '某某热梗', heat: 90 }],
  cards: [],
  ...over,
})

describe('StyleLoader', () => {
  it('removes a sample from the page before the Host answers, then takes the Host\'s panel', async () => {
    const store = createStyleStore()
    store.update((draft) => { draft.panel = panel() })
    let answer: (value: { ok: true; panel: StylePanel }) => void = () => {}
    const loader = new StyleLoader(store, {
      read: () => Promise.resolve(panel()),
      edit: () => new Promise((resolve) => { answer = resolve }),
      collect: () => Promise.resolve(panel()),
    })
    const done = loader.edit({ op: 'remove', id: 'a' })
    expect(store.getSnapshot().panel!.samples.map(sample => sample.id)).toEqual(['b'])
    expect(store.getSnapshot().saving).toBe(true)
    // A poll that lands meanwhile does not bring the deleted sample back.
    await loader.refresh()
    expect(store.getSnapshot().panel!.samples.map(sample => sample.id)).toEqual(['b'])
    answer({ ok: true, panel: panel({ samples: [] }) })
    expect(await done).toBe(true)
    expect(store.getSnapshot()).toMatchObject({ saving: false, error: null, panel: { samples: [] } })
  })

  it('removes a note and blocks a HotWatch title on the page at once', async () => {
    const store = createStyleStore()
    store.update((draft) => { draft.panel = panel() })
    const never = (): Promise<never> => new Promise(() => {})
    const loader = new StyleLoader(store, { read: () => Promise.resolve(panel()), edit: never, collect: () => Promise.resolve(panel()) })
    void loader.edit({ op: 'remove', id: 'm1' })
    expect(store.getSnapshot().panel!.notes).toEqual([])
  })

  it('shows the owner\'s card edit, rollback, and a deleted history version on the page at once', async () => {
    const store = createStyleStore()
    const cards = [
      { version: 1, card: '第一版', author: 'agent' as const, reason: 'a', at: 1 },
      { version: 2, card: '第二版', author: 'agent' as const, reason: 'b', at: 2 },
    ]
    store.update((draft) => { draft.panel = panel({ cards }) })
    const never = (): Promise<never> => new Promise(() => {})
    const loader = new StyleLoader(store, { read: () => Promise.resolve(panel()), edit: never, collect: never }, () => 9)
    void loader.edit({ op: 'card', card: '魔女的版本' })
    expect(store.getSnapshot().panel!.cards.at(-1)).toMatchObject({ version: 3, card: '魔女的版本', author: 'owner', at: 9 })
    void loader.edit({ op: 'rollback', version: 1 })
    expect(store.getSnapshot().panel!.cards.at(-1)).toMatchObject({ version: 4, card: '第一版', author: 'owner' })
    void loader.edit({ op: 'deleteVersion', version: 2 })
    expect(store.getSnapshot().panel!.cards.map(card => card.version)).toEqual([1, 3, 4])
    // The current version is never dropped from the page.
    void loader.edit({ op: 'deleteVersion', version: 4 })
    expect(store.getSnapshot().panel!.cards.map(card => card.version)).toEqual([1, 3, 4])
  })

  it('marks a kept sample active at once, and restores the page when the Host cannot be reached', async () => {
    const store = createStyleStore()
    store.update((draft) => { draft.panel = panel() })
    const loader = new StyleLoader(store, { read: () => Promise.resolve(panel()), edit: () => Promise.reject(new Error('offline')), collect: () => Promise.reject(new Error('offline')) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await loader.edit({ op: 'keep', id: 'b' })).toBe(false)
    expect(store.getSnapshot().panel!.samples.find(sample => sample.id === 'b')!.status).toBe('pending')
    expect(store.getSnapshot().error).toBe('network')
    await loader.collect()
    expect(store.getSnapshot().error).toBe('network')
    warn.mockRestore()
  })

  it('shows the Host\'s refusal and its panel', async () => {
    const store = createStyleStore()
    const loader = new StyleLoader(store, {
      read: () => Promise.resolve(panel()),
      edit: () => Promise.resolve({ ok: false, error: 'invalid_input', panel: panel() }),
      collect: () => Promise.resolve(panel({ running: true })),
    })
    expect(await loader.edit({ op: 'remove', id: 'zz' })).toBe(false)
    expect(store.getSnapshot()).toMatchObject({ error: 'invalid_input', panel: { enabled: true } })
    await loader.collect()
    expect(store.getSnapshot()).toMatchObject({ error: null, panel: { running: true } })
  })

  it('keeps the last panel through a failed read and marks it stale', async () => {
    const store = createStyleStore()
    const read = vi.fn().mockResolvedValueOnce(panel()).mockRejectedValueOnce(new Error('down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loader = new StyleLoader(store, { read, edit: () => Promise.reject(new Error('x')), collect: () => Promise.reject(new Error('x')) }, () => 5)
    await loader.refresh()
    await loader.refresh()
    expect(store.getSnapshot()).toMatchObject({ stale: true, checkedAt: 5, panel: { enabled: true } })
    warn.mockRestore()
  })
})

describe('StyleLoader edge cases', () => {
  const idle = {
    read: () => Promise.resolve(panel()),
    edit: () => Promise.resolve({ ok: true as const, panel: panel() }),
    collect: () => Promise.resolve(panel()),
  }

  it('blocks a HotWatch title on the page at once', () => {
    const store = createStyleStore()
    store.update((draft) => { draft.panel = panel() })
    const loader = new StyleLoader(store, { ...idle, edit: () => new Promise(() => {}) })
    void loader.edit({ op: 'block', term: '某某热梗' })
    expect(store.getSnapshot().panel!.hot).toEqual([])
    expect(store.getSnapshot().panel!.notes).toHaveLength(1)
  })

  it('leaves the page alone for a rollback to a version that is not there, and numbers the first card 1', () => {
    const store = createStyleStore()
    store.update((draft) => { draft.panel = panel() })
    const loader = new StyleLoader(store, { ...idle, edit: () => new Promise(() => {}) }, () => 3)
    void loader.edit({ op: 'rollback', version: 7 })
    expect(store.getSnapshot().panel!.cards).toEqual([])
    void loader.edit({ op: 'card', card: '第一张' })
    expect(store.getSnapshot().panel!.cards).toEqual([{ version: 1, card: '第一张', author: 'owner', reason: 'edited on the Settings page', at: 3 }])
  })

  it('applies an edit before any panel is loaded without inventing one', async () => {
    const store = createStyleStore()
    const loader = new StyleLoader(store, { ...idle, edit: () => Promise.resolve({ ok: false, error: 'not_found', panel: panel() }) })
    expect(await loader.edit({ op: 'remove', id: 'a' })).toBe(false)
    expect(store.getSnapshot()).toMatchObject({ saving: false, error: 'not_found', panel: { enabled: true } })
  })

  it('shares one read among concurrent callers', async () => {
    const store = createStyleStore()
    const read = vi.fn(() => Promise.resolve(panel()))
    const loader = new StyleLoader(store, { ...idle, read })
    const first = loader.refresh()
    const second = loader.refresh()
    expect(second).toBe(first)
    await first
    expect(read).toHaveBeenCalledTimes(1)
    await loader.refresh()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('warns once while reads keep failing', async () => {
    const store = createStyleStore()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loader = new StyleLoader(store, { ...idle, read: () => Promise.reject(new Error('down')) })
    await loader.refresh()
    await loader.refresh()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toMatchObject({ stale: true, panel: null })
    warn.mockRestore()
  })

  it('does not replace the page with a read that lands while an edit is saving', async () => {
    const store = createStyleStore()
    store.update((draft) => { draft.panel = panel({ enabled: false }) })
    const loader = new StyleLoader(store, { ...idle, edit: () => new Promise(() => {}) })
    void loader.edit({ op: 'keep', id: 'b' })
    await loader.refresh()
    expect(store.getSnapshot()).toMatchObject({ saving: true, stale: false, panel: { enabled: false } })
  })
})

describe('parsing', () => {
  it('refuses a body that is not an object, and keeps the Host\'s error name', () => {
    expect(() => parsePanel(null)).toThrow(/unexpected/u)
    expect(() => parsePanel('panel')).toThrow(/unexpected/u)
    expect(() => parseEditAnswer(null)).toThrow(/unexpected/u)
    expect(parseEditAnswer({ ok: false, panel: panel(), error: 'not_found' })).toMatchObject({ ok: false, error: 'not_found' })
  })

  it('accepts the Host\'s answers and refuses anything else', () => {
    expect(parsePanel(panel()).enabled).toBe(true)
    expect(() => parsePanel({ error: 'unauthorized' })).toThrow(/unexpected/u)
    expect(parseEditAnswer({ ok: true, panel: panel() }).ok).toBe(true)
    expect(parseEditAnswer({ ok: false, panel: panel() })).toMatchObject({ ok: false, error: 'invalid_input' })
  })
})

describe('pollWhileVisible', () => {
  it('stays idle while the page starts hidden, ignores repeated events, and starts when shown', () => {
    vi.useFakeTimers()
    const listeners: Array<() => void> = []
    const page = { visibilityState: 'hidden' as DocumentVisibilityState, addEventListener: (_: string, listener: () => void) => { listeners.push(listener) }, removeEventListener: vi.fn() }
    const refresh = vi.fn()
    const stop = pollWhileVisible(refresh, 1000, page)
    vi.advanceTimersByTime(3000)
    expect(refresh).not.toHaveBeenCalled()
    listeners[0]!()
    expect(refresh).not.toHaveBeenCalled()
    page.visibilityState = 'visible'
    listeners[0]!()
    listeners[0]!()
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(refresh).toHaveBeenCalledTimes(2)
    stop()
    expect(page.removeEventListener).toHaveBeenCalledWith('visibilitychange', listeners[0])
    vi.useRealTimers()
  })

  it('stops cleanly while hidden, when no timer is running', () => {
    vi.useFakeTimers()
    const page = { visibilityState: 'hidden' as DocumentVisibilityState, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const refresh = vi.fn()
    pollWhileVisible(refresh, 1000, page)()
    vi.advanceTimersByTime(3000)
    expect(refresh).not.toHaveBeenCalled()
    expect(page.removeEventListener).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('polls without a page object when the browser document is absent', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const stop = pollWhileVisible(refresh, 1000)
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2000)
    expect(refresh).toHaveBeenCalledTimes(3)
    stop()
    vi.advanceTimersByTime(5000)
    expect(refresh).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })

  it('refreshes on a timer while visible and stops while hidden', () => {
    vi.useFakeTimers()
    const listeners: Array<() => void> = []
    const page = { visibilityState: 'visible' as DocumentVisibilityState, addEventListener: (_: string, listener: () => void) => { listeners.push(listener) }, removeEventListener: vi.fn() }
    const refresh = vi.fn()
    const stop = pollWhileVisible(refresh, 1000, page)
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2000)
    expect(refresh).toHaveBeenCalledTimes(3)
    page.visibilityState = 'hidden'
    listeners[0]!()
    vi.advanceTimersByTime(5000)
    expect(refresh).toHaveBeenCalledTimes(3)
    page.visibilityState = 'visible'
    listeners[0]!()
    expect(refresh).toHaveBeenCalledTimes(4)
    stop()
    vi.advanceTimersByTime(5000)
    expect(refresh).toHaveBeenCalledTimes(4)
    vi.useRealTimers()
  })
})
