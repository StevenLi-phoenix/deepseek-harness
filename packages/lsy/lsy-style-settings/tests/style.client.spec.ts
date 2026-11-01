import { describe, expect, it, vi } from 'vitest'
import { createStyleStore, parseEditAnswer, parsePanel, pollWhileVisible, StyleLoader, type StylePanel } from '../src/client/style.ts'

const panel = (over: Partial<StylePanel> = {}): StylePanel => ({
  enabled: true, review: 'optional', limits: { maxActive: 60, maxOwner: 20, maxChars: 60 }, running: false, lastRun: null, nextRunAt: null, trend: [],
  samples: [
    { id: 'a', source: 'qq-group', status: 'active', addedAt: 'x', prompt: '周末去哪', reply: '宅着' },
    { id: 'b', source: 'qq-group', status: 'pending', addedAt: 'x', prompt: '在吗', reply: '在' },
  ],
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
    expect(await loader.edit({ op: 'add', reply: '' })).toBe(false)
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

describe('parsing', () => {
  it('accepts the Host\'s answers and refuses anything else', () => {
    expect(parsePanel(panel()).enabled).toBe(true)
    expect(() => parsePanel({ error: 'unauthorized' })).toThrow(/unexpected/u)
    expect(parseEditAnswer({ ok: true, panel: panel() }).ok).toBe(true)
    expect(parseEditAnswer({ ok: false, panel: panel() })).toMatchObject({ ok: false, error: 'invalid_input' })
  })
})

describe('pollWhileVisible', () => {
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
