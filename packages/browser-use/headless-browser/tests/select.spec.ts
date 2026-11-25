/**
 * Which option of a native select a typed text names: the label a person
 * reads, then the submitted value, then one option the text uniquely starts or
 * appears in; never a disabled option, and nothing when the text is ambiguous.
 */

import { describe, expect, it } from 'vitest'
import { matchOption, readSelectOptions, type SelectOption } from '../src/select.ts'

const COUNTRIES: readonly SelectOption[] = [
  { label: 'Select…', value: '', disabled: true },
  { label: 'United States', value: 'US', disabled: false },
  { label: 'United Kingdom', value: 'GB', disabled: false },
  { label: 'Canada', value: 'CA', disabled: false },
  { label: 'Mexico (closed)', value: 'MX', disabled: true },
]

describe('choosing a select option', () => {
  it('matches the label with case and whitespace folded, then the value', () => {
    expect(matchOption(COUNTRIES, '  united   states ')).toBe(1)
    expect(matchOption(COUNTRIES, 'ca')).toBe(3)
    expect(matchOption(COUNTRIES, 'GB')).toBe(2)
  })

  it('takes a unique prefix or substring and refuses an ambiguous one', () => {
    expect(matchOption(COUNTRIES, 'Can')).toBe(3)
    expect(matchOption(COUNTRIES, 'Kingdom')).toBe(2)
    expect(matchOption(COUNTRIES, 'United')).toBeUndefined()
  })

  it('never chooses a disabled option or a blank text', () => {
    expect(matchOption(COUNTRIES, 'Mexico (closed)')).toBeUndefined()
    expect(matchOption(COUNTRIES, 'Select…')).toBeUndefined()
    expect(matchOption(COUNTRIES, '   ')).toBeUndefined()
  })

  it('validates options that crossed the page boundary', () => {
    expect(readSelectOptions([{ label: 'A', value: 'a', disabled: false }])).toEqual([{ label: 'A', value: 'a', disabled: false }])
    expect(() => readSelectOptions({})).toThrow(/no list/u)
    expect(() => readSelectOptions([{ label: 1, value: 'a', disabled: false }])).toThrow(/not an option/u)
  })
})
