import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('lsy-memory-admin node entry', () => {
  it('has no Host-side behavior: the page is delivered through the browser half', () => {
    expect(apply).not.toThrow()
    expect(apply.length).toBe(0)
  })
})
