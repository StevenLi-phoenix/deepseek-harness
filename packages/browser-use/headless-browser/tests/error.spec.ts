/**
 * The one-line failure text a tool result or a log record carries: the first
 * line of an `Error`'s message, or of the text of any other thrown value.
 */

import { describe, expect, it } from 'vitest'
import { firstLine } from '../src/error.ts'

describe('firstLine', () => {
  it('keeps the first line of an error and drops the advice after it', () => {
    expect(firstLine(new Error('browserType.launch: Executable doesn\'t exist\nRun "playwright install chromium"')))
      .toBe('browserType.launch: Executable doesn\'t exist')
    expect(firstLine(new Error('target closed'))).toBe('target closed')
  })

  it('reads a thrown value that is not an Error as text', () => {
    expect(firstLine('socket hang up\nat connect')).toBe('socket hang up')
    expect(firstLine(404)).toBe('404')
  })
})
