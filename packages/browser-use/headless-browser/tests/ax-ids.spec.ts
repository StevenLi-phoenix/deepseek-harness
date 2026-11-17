/** The per-page id map an accessibility read fills and a later action resolves. */

import { describe, expect, it } from 'vitest'
import { StaleAxIdError, UnknownAxIdError, PageAxIds, parseAxId } from '../src/ax-ids.ts'

describe('parseAxId', () => {
  it('reads the number of an eN id and refuses anything else', () => {
    expect(parseAxId('e12')).toBe(12)
    expect(parseAxId('e0')).toBeUndefined()
    expect(parseAxId('E12')).toBeUndefined()
    expect(parseAxId('e12x')).toBeUndefined()
    expect(parseAxId('button')).toBeUndefined()
  })
})

describe('PageAxIds', () => {
  it('hands out one id per node and reuses it on the next read', () => {
    let issued = 0
    const ids = new PageAxIds(() => {
      issued += 1
      return `e${String(issued)}`
    })
    expect(ids.idFor(42)).toBe('e1')
    expect(ids.idFor(43)).toBe('e2')
    expect(ids.idFor(42)).toBe('e1')
    expect(ids.nodeFor('e2')).toBe(43)
    expect(ids.nodeFor('e1')).toBe(42)
    expect(issued).toBe(2)
  })

  it('drops every mapping when the document is replaced, and never reuses an id', () => {
    let issued = 0
    const ids = new PageAxIds(() => {
      issued += 1
      return `e${String(issued)}`
    })
    expect(ids.idFor(7)).toBe('e1')
    ids.invalidate()
    expect(ids.nodeFor('e1')).toBeUndefined()
    expect(ids.idFor(7)).toBe('e2')
    expect(issued).toBe(2)
  })

  it('knows nothing about an id it never printed', () => {
    const ids = new PageAxIds(() => 'e1')
    expect(ids.nodeFor('e9')).toBeUndefined()
    expect(ids.nodeFor('anything')).toBeUndefined()
  })
})

describe('refusals', () => {
  it('names the id and how to recover in both cases', () => {
    const stale = new StaleAxIdError('e12')
    expect(stale.id).toBe('e12')
    expect(stale.message).toContain('axId e12')
    expect(stale.message).toContain('read the page again with headless_browser_ax')

    const staleWithDetail = new StaleAxIdError('e12', 'Node with given id does not belong to the document')
    expect(staleWithDetail.message).toContain('Node with given id does not belong to the document')

    const unknown = new UnknownAxIdError('e99')
    expect(unknown.id).toBe('e99')
    expect(unknown.message).toContain('axId e99')
    expect(unknown.message).toContain('headless_browser_ax')
  })
})
