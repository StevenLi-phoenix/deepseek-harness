import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { freshId } from '../src/store.ts'

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) }
})

describe('freshId', () => {
  it('draws again when the random id is already taken', () => {
    vi.mocked(randomBytes)
      .mockImplementationOnce(() => Buffer.from('aabbcc', 'hex') as never)
      .mockImplementationOnce(() => Buffer.from('ddeeff', 'hex') as never)
    expect(freshId([{ id: 'aabbcc' }])).toBe('ddeeff')
    expect(vi.mocked(randomBytes)).toHaveBeenCalledTimes(2)
  })
})
