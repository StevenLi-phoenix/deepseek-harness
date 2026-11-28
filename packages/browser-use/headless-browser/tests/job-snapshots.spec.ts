/**
 * The job browser's screenshot store: each Session sees only its own images,
 * and the oldest images go once the count or total size passes its limit.
 */

import { describe, expect, it } from 'vitest'
import { JobSnapshots } from '../src/job-snapshots.ts'

const MB = 1024 * 1024

describe('the job snapshot store', () => {
  it('shows an image only to the Session that stored it, until it is cleared', () => {
    const snapshots = new JobSnapshots()
    const image = Buffer.from('png')
    const id = snapshots.add('worker', image)
    expect(id).toMatch(/^job-snapshot:[\da-f-]+\.png$/u)
    expect(snapshots.get('worker', id)).toBe(image)
    expect(snapshots.get('other', id)).toBeUndefined()
    snapshots.clear()
    expect(snapshots.get('worker', id)).toBeUndefined()
  })

  it('drops the oldest image past sixteen', () => {
    const snapshots = new JobSnapshots()
    const ids = Array.from({ length: 17 }, (_, n) => snapshots.add('worker', Buffer.from([n])))
    expect(snapshots.get('worker', ids[0] ?? '')).toBeUndefined()
    expect(ids.slice(1).every(id => snapshots.get('worker', id) !== undefined)).toBe(true)
  })

  it('drops the oldest images past 32 MB in total', () => {
    const snapshots = new JobSnapshots()
    const first = snapshots.add('worker', Buffer.alloc(20 * MB))
    const second = snapshots.add('worker', Buffer.alloc(20 * MB))
    expect(snapshots.get('worker', first)).toBeUndefined()
    expect(snapshots.get('worker', second)?.length).toBe(20 * MB)
  })

  it('refuses one image larger than 32 MB', () => {
    expect(() => new JobSnapshots().add('worker', Buffer.alloc(32 * MB + 1))).toThrow('The browser snapshot is too large; capture the viewport instead.')
  })
})
