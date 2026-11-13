import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigLoader, createConfigStore, entryKey, type ConfigTransport } from '../src/client/store.ts'
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
    read: (ids, _exclude) => {
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
      () => Promise.resolve({ ok: true, revision: 'b', changed: ['url'], reload: true }),
    )
    await loader.load(['e'])
    const landed = await loader.save('e', [], 'a', [{ op: 'clear', path: ['url'] }])
    expect(landed).toBe(true)
    expect(phases).toContain('saving')
    expect(phases).toContain('reloading')
    expect(state()).toMatchObject({ phase: 'ready', view: { revision: 'b', overrides: 1 }, savedAt: 1000, refused: null })
    // One read for the first load, three while the plugin was away.
    expect(asked).toHaveLength(4)
  })

  it('reports a plugin that does not answer in time as unreachable, keeping the form', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { loader, state } = setup([describe1(view('a')), describe1(view('a', { active: false }))], () => Promise.resolve({ ok: true, revision: 'b', changed: ['url'], reload: true }))
    await loader.load(['e'])
    expect(await loader.save('e', [], 'a', [{ op: 'clear', path: ['url'] }])).toBe(false)
    expect(state()).toMatchObject({ phase: 'unreachable', view: { revision: 'a' } })
  })

  it('treats a lost answer as saved when the revision moved, and as not saved when it did not', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const lost = () => Promise.reject(new Error('socket closed'))
    const moved = setup([describe1(view('a')), describe1(view('b'))], lost)
    await moved.loader.load(['e'])
    expect(await moved.loader.save('e', [], 'a', [{ op: 'clear', path: ['url'] }])).toBe(true)
    expect(moved.state()).toMatchObject({ phase: 'ready', view: { revision: 'b' } })
    const same = setup([describe1(view('a'))], lost)
    await same.loader.load(['e'])
    expect(await same.loader.save('e', [], 'a', [{ op: 'clear', path: ['url'] }])).toBe(false)
    expect(same.state()).toMatchObject({ phase: 'ready', refused: { reason: 'failed' } })
  })

  it('keeps the form and reads again after a conflict', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { loader, state, asked } = setup(
      [describe1(view('a')), describe1(view('c'))],
      () => Promise.resolve({ ok: false, reason: 'conflict', message: 'changed' }),
    )
    await loader.load(['e'])
    expect(await loader.save('e', [], 'a', [{ op: 'clear', path: ['url'] }])).toBe(false)
    expect(state()).toMatchObject({ phase: 'ready', refused: { reason: 'conflict' }, view: { revision: 'c' } })
    expect(asked).toHaveLength(2)
  })

  it('does not wait for a reload when nothing changed', async () => {
    const { loader, state, asked } = setup([describe1(view('a'))], () => Promise.resolve({ ok: true, revision: 'a', changed: [], reload: false }))
    await loader.load(['e'])
    expect(await loader.save('e', [], 'a', [{ op: 'clear', path: ['url'] }])).toBe(true)
    expect(state().phase).toBe('ready')
    expect(asked).toHaveLength(2)
  })

  it('does not wait for a reload after a save of volatile fields only, and says nothing about reloading', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { loader, state, phases, asked } = setup(
      [describe1(view('a')), describe1(view('b'))],
      () => Promise.resolve({ ok: true, revision: 'b', changed: ['groups'], reload: false }),
    )
    await loader.load(['e'])
    expect(await loader.save('e', [], 'a', [{ op: 'set', path: ['groups'], value: ['1'] }])).toBe(true)
    expect(phases).not.toContain('reloading')
    expect(state()).toMatchObject({ phase: 'ready', view: { revision: 'b' } })
    expect(asked).toHaveLength(2)
  })

  it('reads and saves with the fields a dedicated editor owns left out, under a key of their own', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const store = createConfigStore()
    const reads: Array<readonly string[]> = []
    const writes: ConfigSaveRequest[] = []
    const transport: ConfigTransport = {
      read: (_ids, exclude) => { reads.push(exclude); return Promise.resolve(describe1(view('a'))) },
      write: (request) => { writes.push(request); return Promise.resolve({ ok: true, revision: 'a', changed: ['url'], reload: false }) },
    }
    const loader = new ConfigLoader(store, transport, POLICY, () => Promise.resolve(), () => 1)
    await loader.load(['e'], ['groups'])
    await loader.load(['e'])
    expect(Object.keys(store.getSnapshot().entries).sort()).toEqual(['e', entryKey('e', ['groups'])].sort())
    await loader.save('e', ['groups'], 'a', [{ op: 'clear', path: ['url'] }])
    expect(writes).toEqual([{ id: 'e', revision: 'a', ops: [{ op: 'clear', path: ['url'] }], exclude: ['groups'] }])
    expect(reads[0]).toEqual(['groups'])
  })

  it('writes nothing until save is called: loading, and reading again, never write', async () => {
    const writes: ConfigSaveRequest[] = []
    const store = createConfigStore()
    const transport: ConfigTransport = {
      read: () => Promise.resolve(describe1(view('a'))),
      write: (request) => { writes.push(request); return Promise.reject(new Error('unused')) },
    }
    const loader = new ConfigLoader(store, transport, POLICY, () => Promise.resolve(), () => 1)
    await loader.load(['e'])
    await loader.load(['e'])
    expect(writes).toEqual([])
  })

  it('logs the entry and field paths of a save, never a value', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { loader } = setup([describe1(view('a')), describe1(view('b'))], () => Promise.resolve({ ok: true, revision: 'b', changed: ['digest.model'], reload: true }))
    await loader.load(['e'])
    await loader.save('e', [], 'a', [{ op: 'set', path: ['digest', 'model'], value: 'secret-looking-value' }])
    expect(info).toHaveBeenCalledWith('[plugin-config] save of e [digest.model] outcome=ok in 0ms')
    expect(info.mock.calls.flat().join(' ')).not.toContain('secret-looking-value')
  })
})

describe('ConfigLoader corners', () => {
  it('names a read failure that is not an Error by its text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createConfigStore()
    const transport: ConfigTransport = { read: async () => { throw 'offline' }, write: () => Promise.reject(new Error('unused')) }
    await new ConfigLoader(store, transport, POLICY, () => Promise.resolve(), () => 1).load(['e'])
    expect(warn).toHaveBeenCalledWith('[plugin-config] read of e failed: offline')
    expect(store.getSnapshot().entries['e']).toMatchObject({ phase: 'unreachable', view: null })
  })

  it('leaves the phase of an entry alone while a save is in flight, and publishes the view when the save settles', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    let answer!: (result: ConfigSaveResult) => void
    const { loader, state, phases } = setup(
      [describe1(view('a')), describe1(view('a')), describe1(view('b'))],
      () => new Promise<ConfigSaveResult>((resolve) => { answer = resolve }),
    )
    await loader.load(['e'])
    const saving = loader.save('e', [], 'a', [{ op: 'clear', path: ['url'] }])
    expect(state().phase).toBe('saving')
    await loader.load(['e'])
    expect(state().phase).toBe('saving')
    answer({ ok: true, revision: 'b', changed: ['url'], reload: true })
    expect(await saving).toBe(true)
    expect(state()).toMatchObject({ phase: 'ready', view: { revision: 'b' } })
    // The load that overlapped the save never moved the phase away from `saving`.
    expect(phases.slice(phases.indexOf('saving'))).toEqual(['saving', 'saving', 'reloading', 'ready'])
  })

  it('names a lost answer that was not an Error by its text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { loader } = setup([describe1(view('a'))], async () => { throw 'socket closed' })
    await loader.load(['e'])
    expect(await loader.save('e', [], 'a', [{ op: 'clear', path: ['url'] }])).toBe(false)
    expect(warn).toHaveBeenCalledWith('[plugin-config] save of e [url] got no answer: socket closed')
  })

  it('reads again after a refusal by the home patch, and not after any other refusal', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refusing = (reason: 'home-locked' | 'invalid') =>
      setup([describe1(view('a')), describe1(view('a', { locked: true }))], () => Promise.resolve({ ok: false, reason, message: 'no' }))
    const locked = refusing('home-locked')
    await locked.loader.load(['e'])
    expect(await locked.loader.save('e', [], 'a', [{ op: 'clear', path: ['url'] }])).toBe(false)
    expect(locked.asked).toHaveLength(2)
    expect(locked.state()).toMatchObject({ refused: { reason: 'home-locked' }, view: { locked: true } })
    const invalid = refusing('invalid')
    await invalid.loader.load(['e'])
    expect(await invalid.loader.save('e', [], 'a', [{ op: 'clear', path: ['url'] }])).toBe(false)
    expect(invalid.asked).toHaveLength(1)
    expect(invalid.state()).toMatchObject({ refused: { reason: 'invalid' }, view: { locked: false } })
  })

  it('waits with the real clock and Date.now unless told otherwise', async () => {
    vi.useFakeTimers()
    try {
      vi.spyOn(console, 'info').mockImplementation(() => {})
      const store = createConfigStore()
      const transport: ConfigTransport = {
        read: () => Promise.resolve(describe1(view('b'))),
        write: () => Promise.resolve({ ok: true, revision: 'b', changed: ['url'], reload: true }),
      }
      vi.setSystemTime(5_000)
      const saving = new ConfigLoader(store, transport, { attempts: 2, intervalMs: 750 }).save('e', [], 'a', [{ op: 'clear', path: ['url'] }])
      await vi.advanceTimersByTimeAsync(750)
      expect(await saving).toBe(true)
      expect(store.getSnapshot().entries['e']).toMatchObject({ phase: 'ready', savedAt: 5_750 })
    } finally {
      vi.useRealTimers()
    }
  })
})
