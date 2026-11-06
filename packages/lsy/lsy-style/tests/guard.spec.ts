import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { GUARD_UNAVAILABLE, optionalService, StyleGate } from '../src/guard.ts'

const contextWith = (service: unknown): Context => ({ get: () => service }) as never

describe('optionalService', () => {
  it('looks a service up by name and ignores one that is not an object', () => {
    const service = { check: vi.fn() }
    expect(optionalService(contextWith(service), 'lsyGuard')).toBe(service)
    expect(optionalService(contextWith('text'), 'lsyGuard')).toBeUndefined()
    expect(optionalService(contextWith(null), 'lsyGuard')).toBeUndefined()
  })

  it('finds nothing on a context that has no get', () => {
    expect(optionalService({} as never, 'lsyGuard')).toBeUndefined()
  })
})

describe('StyleGate failure paths', () => {
  const gate = (service: unknown) => {
    const warn = vi.fn()
    const info = vi.fn()
    return { gate: new StyleGate(contextWith(service), warn, info), warn, info }
  }

  it('refuses without a guard, warns once, and logs each refusal with a hash instead of the text', async () => {
    const { gate: closed, warn, info } = gate(undefined)
    expect(await closed.check('秘密', 'persona')).toBe(GUARD_UNAVAILABLE)
    expect(await closed.check('秘密', 'persona')).toBe(GUARD_UNAVAILABLE)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(info).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(info.mock.calls)).not.toContain('秘密')
  })

  it('refuses and warns when the guard throws an Error or something else', async () => {
    const thrown: unknown[] = [new Error('guard crashed'), 'plain failure']
    const check = vi.fn(async () => { throw thrown.shift() })
    const { gate: broken, warn } = gate({ check })
    expect(await broken.check('文本', 'style_note')).toBe(GUARD_UNAVAILABLE)
    expect(await broken.check('文本', 'style_note')).toBe(GUARD_UNAVAILABLE)
    expect(warn.mock.calls.map(call => String(call[0]).replace(/sha256 \w+/u, 'sha256 H'))).toEqual([
      'lsy-style: the guard failed on style_note (sha256 H): guard crashed',
      'lsy-style: the guard failed on style_note (sha256 H): plain failure',
    ])
  })
})
