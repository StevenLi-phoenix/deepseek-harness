import { describe, expect, it } from 'vitest'
import { AddressProblem, addressesIn, formatMailbox, headerSafe, parseMailbox, parseMailboxes } from '../src/address.ts'

describe('header safety', () => {
  it('accepts printable text and tabs, and refuses CR, LF, NUL, ESC, and DEL', () => {
    expect(headerSafe('Quarterly report\tdraft')).toBe(true)
    for (const bad of ['a\rb', 'a\nb', 'a\u0000b', 'a\u001Bb', 'a\u007Fb']) expect(headerSafe(bad)).toBe(false)
  })
})

describe('one recipient', () => {
  it('reads a bare address, an angled one, and a named one, trimming the name and its quotes', () => {
    expect(parseMailbox('  ada@example.com ')).toEqual({ address: 'ada@example.com', name: '' })
    expect(parseMailbox('<ada@example.com>')).toEqual({ address: 'ada@example.com', name: '' })
    expect(parseMailbox('Ada Lovelace <ada@example.com>')).toEqual({ address: 'ada@example.com', name: 'Ada Lovelace' })
    expect(parseMailbox('"Lovelace, Ada" <ada@example.com>')).toEqual({ address: 'ada@example.com', name: 'Lovelace, Ada' })
    expect(parseMailbox('o\'brien+tag@mail.example.co.uk')).toEqual({ address: 'o\'brien+tag@mail.example.co.uk', name: '' })
    expect(parseMailbox('a`b{c}|d~@example.com').address).toBe('a`b{c}|d~@example.com')
  })

  it('refuses a line break or control character anywhere, so no argument can add a header', () => {
    for (const raw of ['ada@example.com\r\nBcc: spy@evil.example', 'Ada\n <ada@example.com>', 'ada@exam\u0000ple.com']) {
      expect(() => parseMailbox(raw)).toThrow(AddressProblem)
      expect(() => parseMailbox(raw)).toThrow('holds a line break or a control character')
    }
  })

  it('refuses text that is not one plain address: no domain dot, a quoted local part, two addresses, or over 254 characters', () => {
    for (const raw of ['ada', 'ada@localhost', '"ada lovelace"@example.com', 'ada@example.com bob@example.com', `${'a'.repeat(250)}@example.com`]) {
      expect(() => parseMailbox(raw)).toThrow('is not an email address')
    }
  })

  it('refuses a display name holding <, ", or a backslash', () => {
    for (const raw of ['a<b <ada@example.com>', 'Ada "the" L <ada@example.com>', 'Ada\\L <ada@example.com>']) {
      expect(() => parseMailbox(raw)).toThrow('holds <, >, ", or \\')
    }
  })

  it('cuts the quoted value in a message to 80 characters', () => {
    const error = (() => {
      try {
        parseMailbox('x'.repeat(200))
      } catch (caught: unknown) {
        return caught
      }
      return undefined
    })()
    expect(error).toBeInstanceOf(AddressProblem)
    expect(error instanceof AddressProblem ? error.message : '').toBe(`"${'x'.repeat(80)}" is not an email address`)
  })
})

describe('recipient lists', () => {
  it('reads nothing from undefined or null', () => {
    expect(parseMailboxes(undefined)).toEqual([])
    expect(parseMailboxes(null)).toEqual([])
  })

  it('splits comma and semicolon lists inside one string or across an array, keeping commas in quoted names', () => {
    expect(parseMailboxes('ada@example.com, "Hopper, Grace" <grace@example.com>; alan@example.org')).toEqual([
      { address: 'ada@example.com', name: '' },
      { address: 'grace@example.com', name: 'Hopper, Grace' },
      { address: 'alan@example.org', name: '' },
    ])
    expect(parseMailboxes(['ada@example.com,  ,', 'Alan <alan@example.org>']).map(box => box.address)).toEqual(['ada@example.com', 'alan@example.org'])
  })

  it('drops a repeated address, compared without case, keeping the first spelling', () => {
    expect(parseMailboxes(['Ada@Example.com', 'ADA@example.COM, ada@example.com'])).toEqual([{ address: 'Ada@Example.com', name: '' }])
  })

  it('refuses a value that is neither a string nor a list of strings', () => {
    for (const value of [42, { to: 'ada@example.com' }, ['ada@example.com', 7]]) {
      expect(() => parseMailboxes(value)).toThrow('recipients are a list of email addresses')
    }
  })

  it('refuses the whole list when one entry carries a header injection', () => {
    expect(() => parseMailboxes(['ada@example.com', 'bob@example.com\nBcc: spy@evil.example'])).toThrow(AddressProblem)
  })
})

describe('addresses in a received header', () => {
  it('lists every address, lower-cased, and skips parts without one', () => {
    expect(addressesIn('"Ada" <Ada@Example.com>, undisclosed-recipients:;, Bob.Smith+x@mail.example.org')).toEqual([
      'ada@example.com', 'bob.smith+x@mail.example.org',
    ])
    expect(addressesIn('')).toEqual([])
  })
})

describe('formatting a mailbox', () => {
  const encode = (text: string): string => `=?UTF-8?B?${Buffer.from(text).toString('base64')}?=`

  it('writes the bare address without a name, a quoted ASCII name, and an encoded non-ASCII name', () => {
    expect(formatMailbox({ address: 'ada@example.com', name: '' }, encode)).toBe('ada@example.com')
    expect(formatMailbox({ address: 'ada@example.com', name: 'Ada L' }, encode)).toBe('"Ada L" <ada@example.com>')
    expect(formatMailbox({ address: 'li@example.com', name: '李雷' }, encode)).toBe(`${encode('李雷')} <li@example.com>`)
  })
})
