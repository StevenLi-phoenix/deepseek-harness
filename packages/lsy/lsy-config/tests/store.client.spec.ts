import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigLoader, createConfigStore, type ConfigTransport } from '../src/client/store.ts'
import type { ConfigDescribe, ConfigEntryView, ConfigSaveRequest, ConfigSaveResult } from '../src/view.ts'

const view = (revision: string, over: Partial<ConfigEntryView> = {}): ConfigEntryView => ({
  id: 'e', found: true, active: true, locked: false, revision, overrides: 0, fields: [], ...over,
})
const describe1 = (...views: ConfigEntryView[]): ConfigDescribe => ({ entries: views })
const POLICY = { attempts: 3, intervalMs: 1 }

/** A loader over scripted answers; `reads` are consumed in order, the last repeating. */
function setup(reads: Array<ConfigDescribe | Error>, write: (request: ConfigSaveRequest) => Promise<ConfigSaveResult>) {
  const store = createConfigStore()
  const asked: string[][] = []
  let index = 0
  const transport: ConfigTransport = {
    read: (ids) => {
      asked.push([...ids])
      const next = reads[Math.min(index++, reads.length - 1)]!
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
    },
    write,
  }
  const phases: string[] = []
  store.subscribe(() => { phases.push(store.getSnapshot().entries['e']?.phase ?? '') })
  const loader = new ConfigLoader(store, transport, POLICY, () => Promise.resolve(), () => 1000)
  return { store, loader, asked, phases, state: () => store.getSnapshot().entries['e']! }
}

afterEach(() => { vi.restoreAllMocks() })

describe('ConfigLoader.load', () => {
  it('publishes the description and keeps it when a later read fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { loader, state } = setup([describe1(view('a')), new Error('HTTP 500')], () => Promise.reject(new Error('unused')))
    await loader.load(['e'])
    expect(state()).toMatchObject({ phase: 'ready', view: { revision: 'a' } })
    await loader.load(['e'])
    expect(state()).toMatchObject({ phase: 'ready', view: { revision: 'a' } })
  })

  it('marks an entry that never loaded unreachable, and loads again on retry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { loader, state } = setup([new Error('HTTP 502'), describe1(view('a'))], () => Promise.reject(new Error('unused')))
    await loader.load(['e'])
    expect(state()).toMatchObject({ phase: 'unreachable', view: null })
    await loader.load(['e'])
    expect(state().phase).toBe('ready')
  })
})

describe('ConfigLoader.save', () => {
  it('says reloading until the new instance answers with the saved revision, then shows it', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { loader, phases, state, asked } = setup(
      [describe1(view('a')), new Error('connection reset'), describe1(view('a', { active: false })), describe1(view('b', { overrides: 1 }))],
      () => Promise.resolve({ ok: true, revision: 'b', changed: ['url'] }),
    )
    await loader.load(['e'])
    const landed = await loader.save('e', 'a', [{ op: 'clear', path: ['url'] }])
    expect(landed).toBe(true)
    expect(phases).toContain('saving')
    expect(phases).toContain('reloading')
    expect(state()).toMatchObject({ phase: 'ready', view: { revision: 'b', overrides: 1 }, savedAt: 1000, refused: null })
    // One read for the first load, three while the plugin was away.
    expect(asked).toHaveLength(4)
  })

  it('reports a plugin that does not answer in time as unreachable, keeping the form', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { loader, state } = setup([describe1(view('a')), describe1(view('a', { active: false }))], () => Promise.resolve({ ok: true, revision: 'b', changed: ['url'] }))
    await loader.load(['e'])
    expect(await loader.save('e', 'a', [{ op: 'clear', path: ['url'] }])).toBe(false)
    expect(state()).toMatchObject({ phase: 'unreachable', view: { revision: 'a' } })
  })

  it('treats a lost answer as saved when the revision moved, and as not saved when it did not', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const lost = () => Promise.reject(new Error('socket closed'))
    const moved = setup([describe1(view('a')), describe1(view('b'))], lost)
    await moved.loader.load(['e'])
    expect(await moved.loader.save('e', 'a', [{ op: 'clear', path: ['url'] }])).toBe(true)
    expect(moved.state()).toMatchObject({ phase: 'ready', view: { revision: 'b' } })
    const same = setup([describe1(view('a'))], lost)
    await same.loader.load(['e'])
    expect(await same.loader.save('e', 'a', [{ op: 'clear', path: ['url'] }])).toBe(false)
    expect(same.state()).toMatchObject({ phase: 'ready', refused: { reason: 'failed' } })
  })

  it('keeps the form and reads again after a conflict', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { loader, state, asked } = setup(
      [describe1(view('a')), describe1(view('c'))],
      () => Promise.resolve({ ok: false, reason: 'conflict', message: 'changed' }),
    )
    await loader.load(['e'])
    expect(await loader.save('e', 'a', [{ op: 'clear', path: ['url'] }])).toBe(false)
    expect(state()).toMatchObject({ phase: 'ready', refused: { reason: 'conflict' }, view: { revision: 'c' } })
    expect(asked).toHaveLength(2)
  })

  it('does not wait for a reload when nothing changed', async () => {
    const { loader, state, asked } = setup([describe1(view('a'))], () => Promise.resolve({ ok: true, revision: 'a', changed: [] }))
    await loader.load(['e'])
    expect(await loader.save('e', 'a', [{ op: 'clear', path: ['url'] }])).toBe(true)
    expect(state().phase).toBe('ready')
    expect(asked).toHaveLength(2)
  })

  it('logs the entry and field paths of a save, never a value', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { loader } = setup([describe1(view('a')), describe1(view('b'))], () => Promise.resolve({ ok: true, revision: 'b', changed: ['digest.model'] }))
    await loader.load(['e'])
    await loader.save('e', 'a', [{ op: 'set', path: ['digest', 'model'], value: 'secret-looking-value' }])
    expect(info).toHaveBeenCalledWith('[lsy-config] save of e [digest.model] outcome=ok in 0ms')
    expect(info.mock.calls.flat().join(' ')).not.toContain('secret-looking-value')
  })
})
