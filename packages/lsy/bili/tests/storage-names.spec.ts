import { describe, expect, it } from 'vitest'

import { UNIT_NAME_RE } from '../../../storage/storage/src/backend.ts'
import { biliDomain } from '../src/storage.ts'

// The test harness mounts the memory backend, which does not check names; the json backend refuses the whole unit.
describe('the bili storage domain', () => {
  it('names its unit and every table the way the json backend accepts', () => {
    expect(biliDomain.name).toMatch(UNIT_NAME_RE)
    for (const table of Object.keys(biliDomain.tables)) expect(table).toMatch(UNIT_NAME_RE)
  })
})
