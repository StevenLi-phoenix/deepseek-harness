/**
 * The cookies one caller can hand to a plain HTTP fetch: the domain filter
 * with its dot and URL forms, the order a Cookie header sends them in, and the
 * rule that a log line names a value's length instead of the value.
 */

import { describe, expect, it } from 'vitest'
import {
  cookieHeader,
  cookieSnapshot,
  cookieSummary,
  domainFilter,
  filterCookies,
  redactSecret,
  type RawCookie,
} from '../src/cookies.ts'

/** One cookie of a host, before a test changes a field. */
function cookie(overrides: Partial<RawCookie> = {}): RawCookie {
  return {
    name: 'session',
    value: 's3cr3t-value',
    domain: '.example.com',
    path: '/',
    expires: 1_800_000_000,
    httpOnly: true,
    secure: true,
    ...overrides,
  }
}

describe('domain filter', () => {
  it('accepts a bare suffix, a dotted suffix, and a whole URL', () => {
    expect(domainFilter(undefined)).toBeUndefined()
    expect(domainFilter('')).toBeUndefined()
    expect(domainFilter('   ')).toBeUndefined()
    expect(domainFilter('example.com')).toBe('example.com')
    expect(domainFilter('.Example.COM')).toBe('example.com')
    expect(domainFilter('https://mail.example.com/inbox')).toBe('mail.example.com')
    expect(domainFilter('example.com:8443')).toBe('example.com')
    expect(domainFilter('example.com/')).toBe('example.com')
    expect(domainFilter('.')).toBeUndefined()
  })
})

describe('filtering', () => {
  it('keeps a cookie the suffix covers and drops one it does not', () => {
    const cookies = [
      cookie({ name: 'host', domain: 'example.com' }),
      cookie({ name: 'domain', domain: '.example.com' }),
      cookie({ name: 'sub', domain: 'mail.example.com' }),
      cookie({ name: 'other', domain: '.example.org' }),
      cookie({ name: 'lookalike', domain: 'notexample.com' }),
    ]
    expect(filterCookies(cookies, 'example.com').map(entry => entry.name)).toEqual(['domain', 'host', 'sub'])
    expect(filterCookies(cookies, 'mail.example.com').map(entry => entry.name)).toEqual(['sub'])
    expect(filterCookies(cookies).map(entry => entry.name)).toEqual(['domain', 'host', 'lookalike', 'other', 'sub'])
    expect(filterCookies(cookies, 'nothing.test')).toEqual([])
  })

  it('reports exactly the fields a caller needs and nothing else', () => {
    const [view] = filterCookies([{ ...cookie(), sameSite: 'Lax', priority: 'High' } as RawCookie], 'example.com')
    expect(view).toEqual({
      name: 'session',
      value: 's3cr3t-value',
      domain: '.example.com',
      path: '/',
      expires: 1_800_000_000,
      httpOnly: true,
      secure: true,
    })
  })

  it('sends the most specific path first, then by name', () => {
    const cookies = [
      cookie({ name: 'b', path: '/' }),
      cookie({ name: 'a', path: '/' }),
      cookie({ name: 'deep', path: '/app/settings' }),
    ]
    expect(filterCookies(cookies, 'example.com').map(entry => entry.name)).toEqual(['deep', 'a', 'b'])
  })
})

describe('header building', () => {
  it('joins the kept cookies as a request sends them', () => {
    const cookies = filterCookies([
      cookie({ name: 'a', value: '1', path: '/app' }),
      cookie({ name: 'b', value: '2', path: '/' }),
    ], 'example.com')
    expect(cookieHeader(cookies)).toBe('a=1; b=2')
    expect(cookieHeader([])).toBe('')
    expect(cookieSnapshot([cookie()], 'example.com')).toEqual({
      cookies: [{ name: 'session', value: 's3cr3t-value', domain: '.example.com', path: '/', expires: 1_800_000_000, httpOnly: true, secure: true }],
      toHeader: 'session=s3cr3t-value',
    })
  })

  it('answers an empty header and no cookies when the domain matches nothing', () => {
    const result = cookieSnapshot([cookie()], 'nothing.test')
    expect(result.cookies).toEqual([])
    expect(result.toHeader).toBe('')
  })
})

describe('redaction', () => {
  it('keeps a value out of every log-safe string it builds', () => {
    const value = 'ya29.a0AfH6SMB-super-secret-token'
    expect(redactSecret(value)).toBe(`‹${String(value.length)} chars›`)
    expect(redactSecret(value)).not.toContain('secret')
    expect(redactSecret('')).toBe('‹empty›')
    const summary = cookieSummary([cookie({ value }), cookie({ name: 'theme', value: 'dark' })], 'example.com')
    expect(summary).not.toContain(value)
    expect(summary).not.toContain('super-secret-token')
    expect(summary).toContain('session')
  })

  it('names the count, the scope, and each value length, and says so when empty', () => {
    const summary = cookieSummary([cookie({ name: 'a', value: '12' }), cookie({ name: 'b', value: '' })], 'example.com')
    expect(summary).toBe('2 cookie(s) for example.com: a ‹2 chars›, b ‹empty›')
    expect(cookieSummary([], 'example.com')).toBe('no cookies for example.com')
    expect(cookieSummary([], undefined)).toBe('no cookies for the whole context')
  })

  it('truncates a name that is too long for one log line', () => {
    const summary = cookieSummary([cookie({ name: 'n'.repeat(60), value: 'v' })], undefined)
    expect(summary).not.toContain('n'.repeat(60))
    expect(summary).toContain('…')
  })
})
