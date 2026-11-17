// @vitest-environment node

/**
 * The generic sign-in test: which structural signals mean a page is still a
 * sign-in page, which one it is, and that a page cannot hand the host a value
 * that is not a measurement. The probe runs in a jsdom document, so the same
 * source a real page evaluates is what these cases cover.
 */

import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  classifyChallenge,
  probeChallenge,
  readChallengeFacts,
  type ChallengeFacts,
} from '../src/challenge.ts'

/** Facts of a signed-in page, before a test adds a signal. */
function facts(overrides: Partial<ChallengeFacts> = {}): ChallengeFacts {
  return { passwordField: false, oneTimeCode: false, accountLinks: 0, ...overrides }
}

/**
 * Run the page-side probe over one document. jsdom reports no layout, so the
 * probe's box test is fixed at a visible size, as a real page would.
 * @param body - the document's body markup.
 * @returns the facts the probe measured.
 */
function probe(body: string): ChallengeFacts {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { runScripts: 'outside-only' })
  dom.window.eval(`Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, width: 200, height: 40, top: 0, left: 0, right: 200, bottom: 40, toJSON: () => ({}) }
  }`)
  return dom.window.eval(`(${probeChallenge.toString()})()`) as ChallengeFacts
}

describe('the sign-in probe', () => {
  it('finds a password field', () => {
    expect(probe('<form><input type="text" name="user"><input type="PASSWORD" name="pw"></form>').passwordField).toBe(true)
    expect(probe('<input type="text" name="q">').passwordField).toBe(false)
  })

  it('ignores a password field a person cannot see', () => {
    expect(probe('<input type="password" style="display:none">').passwordField).toBe(false)
    expect(probe('<input type="password" style="visibility:hidden">').passwordField).toBe(false)
    expect(probe('<input type="password" style="opacity:0">').passwordField).toBe(false)
    expect(probe('<input type="password" aria-hidden="true">').passwordField).toBe(false)
  })

  it('finds a one-time-code field by its autocomplete or by its label', () => {
    expect(probe('<input autocomplete="one-time-code">').oneTimeCode).toBe(true)
    expect(probe('<input name="verification_code">').oneTimeCode).toBe(true)
    expect(probe('<input placeholder="验证码">').oneTimeCode).toBe(true)
    expect(probe('<input name="q" placeholder="Search">').oneTimeCode).toBe(false)
    // A password field is a password step, never an MFA field.
    const both = probe('<input type="password" autocomplete="one-time-code">')
    expect(both.passwordField).toBe(true)
    expect(both.oneTimeCode).toBe(false)
  })

  it('counts the account links a chooser lists, and stops at five', () => {
    expect(probe('<a href="/a">someone@example.com</a><button>other@example.com</button>').accountLinks).toBe(2)
    expect(probe('<a href="/a">Sign in</a>').accountLinks).toBe(0)
    expect(probe('<div aria-hidden="true"><a>someone@example.com</a></div>').accountLinks).toBe(0)
    const many = Array.from({ length: 9 }, (_, index) => `<a>user${String(index)}@example.com</a>`).join('')
    expect(probe(many).accountLinks).toBe(5)
  })
})

describe('reading facts across the page boundary', () => {
  it('accepts the probe\'s own answer', () => {
    expect(readChallengeFacts({ passwordField: true, oneTimeCode: false, accountLinks: 3 }))
      .toEqual({ passwordField: true, oneTimeCode: false, accountLinks: 3 })
  })

  it('refuses a value that is not a measurement', () => {
    expect(() => { readChallengeFacts(null) }).toThrow('no object')
    expect(() => { readChallengeFacts({ oneTimeCode: false, accountLinks: 0 }) }).toThrow('no passwordField')
    expect(() => { readChallengeFacts({ passwordField: false, accountLinks: 0 }) }).toThrow('no oneTimeCode')
    expect(() => { readChallengeFacts({ passwordField: false, oneTimeCode: false }) }).toThrow('no accountLinks')
    expect(() => { readChallengeFacts({ passwordField: false, oneTimeCode: false, accountLinks: Number.NaN }) }).toThrow('no accountLinks')
    expect(() => { readChallengeFacts({ passwordField: false, oneTimeCode: false, accountLinks: -1 }) }).toThrow('no accountLinks')
  })
})

describe('classifying what stopped a visit', () => {
  const TARGET = 'https://example.com/assignments'

  it('passes the signed-in page on the same origin', () => {
    expect(classifyChallenge({ requestedUrl: TARGET, finalUrl: 'https://example.com/assignments', facts: facts() }))
      .toBeUndefined()
  })

  it('names the password field first, then the one-time code', () => {
    expect(classifyChallenge({ requestedUrl: TARGET, finalUrl: TARGET, facts: facts({ passwordField: true }) }))
      .toEqual({ step: 'password', reason: 'the page shows a password field' })
    expect(classifyChallenge({ requestedUrl: TARGET, finalUrl: TARGET, facts: facts({ oneTimeCode: true }) }))
      .toEqual({ step: 'mfa', reason: 'the page asks for a one-time code' })
  })

  it('reports a move to another site as a redirect', () => {
    expect(classifyChallenge({
      requestedUrl: TARGET,
      finalUrl: 'https://login.elsewhere.test/authorize?client=1',
      facts: facts(),
    })).toEqual({ step: 'redirect', reason: 'the page moved to https://login.elsewhere.test' })
  })

  it('reports a move that lists accounts as an account chooser', () => {
    expect(classifyChallenge({
      requestedUrl: TARGET,
      finalUrl: 'https://accounts.elsewhere.test/chooser',
      facts: facts({ accountLinks: 2 }),
    })).toEqual({
      step: 'account-chooser',
      reason: 'the page moved to https://accounts.elsewhere.test and lists accounts to choose from',
    })
  })

  it('treats a host below the named domain as the same site', () => {
    expect(classifyChallenge({
      requestedUrl: TARGET,
      finalUrl: 'https://sso.example.com/login',
      facts: facts(),
      domain: 'example.com',
    })).toBeUndefined()
    expect(classifyChallenge({
      requestedUrl: TARGET,
      finalUrl: 'https://elsewhere.test/login',
      facts: facts(),
      domain: 'example.com',
    })?.step).toBe('redirect')
  })

  it('fails a page whose URL and requested URL do not parse', () => {
    expect(classifyChallenge({ requestedUrl: 'not a url', finalUrl: 'https://example.com/', facts: facts() })?.step).toBe('redirect')
    expect(classifyChallenge({ requestedUrl: TARGET, finalUrl: '', facts: facts() })).toEqual({
      step: 'redirect',
      reason: 'the page moved to another page',
    })
  })

  it('keeps a lookalike domain apart from the site it imitates', () => {
    expect(classifyChallenge({
      requestedUrl: TARGET,
      finalUrl: 'https://notexample.com/',
      facts: facts(),
      domain: 'example.com',
    })?.step).toBe('redirect')
  })
})
