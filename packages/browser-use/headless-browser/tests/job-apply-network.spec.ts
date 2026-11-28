/**
 * The network guard of a job-apply tab over a fake page and DevTools session:
 * which navigations close the tab, which paused requests fail or continue, and
 * which WebSockets connect. A real Chromium runs the same guard in
 * `job-apply.spec.ts`.
 */

import type { Page } from 'playwright-core'
import { describe, expect, it, vi } from 'vitest'
import { deniedJobUrl, JobNavigationRefused, protectJobPage, safeHost } from '../src/job-apply-network.ts'

/** One `Fetch.requestPaused` event, with the fields the guard reads. */
interface Paused {
  readonly requestId: string
  readonly request: { readonly url: string }
  readonly resourceType: string
  readonly frameId: string
  readonly responseStatusCode?: number
  readonly responseHeaders?: readonly { readonly name: string; readonly value: string }[]
}

/** One routed WebSocket, recording what the guard did with it. */
interface Socket {
  readonly url: string
  closed: boolean
  connected: boolean
}

/** A page and DevTools session that record what the guard asks of them. */
function fakePage(options: { readonly url?: string; readonly failing?: ReadonlySet<string>; readonly closeFails?: boolean } = {}) {
  let url = options.url ?? 'about:blank'
  const sent: [string, unknown][] = []
  const refused: [string, boolean][] = []
  let navigated: ((frame: { parentFrame(): object | null; url(): string }) => void) | undefined
  let paused: ((event: Paused) => void) | undefined
  let socketRoute: ((socket: { url(): string; close(): Promise<void>; connectToServer(): void }) => void) | undefined
  const close = vi.fn(async () => { if (options.closeFails === true) throw new Error('Target page, context or browser has been closed') })
  const cdp = {
    send: async (method: string, params?: unknown) => {
      sent.push([method, params])
      if (options.failing?.has(method) === true) throw new Error(`${method}: Target closed`)
      return method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main' } } } : {}
    },
    on: (_event: 'Fetch.requestPaused', listener: (event: Paused) => void) => { paused = listener },
  }
  const page = {
    url: () => url,
    on: (_event: 'framenavigated', listener: typeof navigated) => { navigated = listener },
    context: () => ({ newCDPSession: async () => cdp }),
    routeWebSocket: async (_pattern: string, handler: typeof socketRoute) => { socketRoute = handler },
    close,
  }
  return {
    page: page as never as Page,
    sent,
    refused,
    close,
    report: (denied: string, closing: boolean) => { refused.push([denied, closing]) },
    land: (next: string) => { url = next },
    navigate: (next: string, main = true) => { navigated?.({ parentFrame: () => main ? null : {}, url: () => next }) },
    pause: async (event: Paused) => {
      paused?.(event)
      const answered = (): boolean => sent.some(([, params]) => (params as { requestId?: string } | undefined)?.requestId
        === event.requestId)
      await vi.waitFor(() => { expect(answered()).toBe(true) })
      await new Promise(resolve => setImmediate(resolve))
    },
    socket: (target: string): Socket => {
      const socket: Socket = { url: target, closed: false, connected: false }
      socketRoute?.({ url: () => target, close: async () => { socket.closed = true }, connectToServer: () => { socket.connected = true } })
      return socket
    },
  }
}

describe('the host a job-apply log names', () => {
  it('names no host for a URL that does not parse or has none', () => {
    expect(safeHost('not a url')).toBe('[invalid URL]')
    expect(safeHost('file:///etc/passwd')).toBe('[invalid URL]')
    expect(safeHost('https://Jobs.Example.COM./apply')).toBe('jobs.example.com')
  })
})

describe('a mail path behind a malformed escape', () => {
  it('compares the raw path when its escapes do not decode', () => {
    expect(deniedJobUrl('https://www.yahoo.com/mail/%E0%A4%A')).toBe(true)
    expect(deniedJobUrl('https://www.yahoo.com/jobs/%E0%A4%A')).toBe(false)
  })
})

describe('guarding a job-apply tab', () => {
  it('refuses a tab that already stands on a denied URL, closing it once', async () => {
    const fake = fakePage({ url: 'https://mail.google.com/mail/u/0', closeFails: true })
    await expect(protectJobPage(fake.page, fake.report)).rejects.toThrow(new JobNavigationRefused('https://mail.google.com/'))
    expect(fake.refused).toEqual([['https://mail.google.com/mail/u/0', true]])
    expect(fake.close).toHaveBeenCalledTimes(1)
    expect(fake.sent).toEqual([])
  })

  it('refuses a tab that lands on a denied URL while its guard is being installed', async () => {
    const fake = fakePage()
    const guarding = protectJobPage(fake.page, fake.report)
    fake.land('https://github.com/settings')
    await expect(guarding).rejects.toThrow('navigation_refused: github.com')
    expect(fake.sent.map(([method]) => method)).toEqual(['Network.setBypassServiceWorker', 'Page.getFrameTree', 'Fetch.enable'])
  })

  it('closes the tab when its main frame navigates somewhere denied, and ignores frames and blank pages', async () => {
    const fake = fakePage()
    await protectJobPage(fake.page, fake.report)
    fake.navigate('https://github.com/', false)
    fake.navigate('about:blank')
    fake.navigate('https://jobs.example.com/apply')
    expect(fake.close).not.toHaveBeenCalled()
    fake.navigate('https://github.com/login')
    fake.navigate('https://claude.ai/')
    expect(fake.refused).toEqual([['https://github.com/login', true]])
    expect(fake.close).toHaveBeenCalledTimes(1)
  })

  it('fails a denied document or subresource request and continues an allowed one', async () => {
    const fake = fakePage()
    await protectJobPage(fake.page, fake.report)
    await fake.pause({ requestId: 'r1', request: { url: 'https://jobs.example.com/apply' }, resourceType: 'Document', frameId: 'main' })
    await fake.pause({ requestId: 'r2', request: { url: 'https://api.github.com/user' }, resourceType: 'XHR', frameId: 'main' })
    await fake.pause({ requestId: 'r3', request: { url: 'https://github.com/embed' }, resourceType: 'Document', frameId: 'child' })
    await fake.pause({ requestId: 'r4', request: { url: 'https://mail.google.com/' }, resourceType: 'Document', frameId: 'main' })
    expect(fake.sent.slice(3)).toEqual([
      ['Fetch.continueRequest', { requestId: 'r1' }],
      ['Fetch.failRequest', { requestId: 'r2', errorReason: 'BlockedByClient' }],
      ['Fetch.failRequest', { requestId: 'r3', errorReason: 'BlockedByClient' }],
      ['Fetch.failRequest', { requestId: 'r4', errorReason: 'BlockedByClient' }],
    ])
    expect(fake.refused).toEqual([['https://api.github.com/user', false], ['https://github.com/embed', false], ['https://mail.google.com/', true]])
  })

  it('judges a redirect by where it leads, and a location that does not parse as denied', async () => {
    const fake = fakePage()
    await protectJobPage(fake.page, fake.report)
    const response = (requestId: string, status: number, location: string): Paused => ({
      requestId, request: { url: 'https://jobs.example.com/apply' }, resourceType: 'Script', frameId: 'main',
      responseStatusCode: status, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }, { name: 'Location', value: location }],
    })
    await fake.pause(response('r1', 302, 'https://mail.google.com/mail'))
    await fake.pause(response('r2', 301, '/next'))
    await fake.pause(response('r3', 200, 'https://mail.google.com/mail'))
    await fake.pause(response('r4', 399, 'http://['))
    await fake.pause({ ...response('r5', 500, ''), responseHeaders: [] })
    await fake.pause({ requestId: 'r6', request: { url: 'https://jobs.example.com/' }, resourceType: 'Script', frameId: 'main', responseStatusCode: 302 })
    expect(fake.sent.slice(3).map(([method]) => method)).toEqual([
      'Fetch.failRequest', 'Fetch.continueRequest', 'Fetch.continueRequest', 'Fetch.failRequest', 'Fetch.continueRequest', 'Fetch.continueRequest',
    ])
    expect(fake.refused).toEqual([['https://mail.google.com/mail', false], ['', false]])
  })

  it('fails a paused request it could not resolve, and tolerates a target that is already gone', async () => {
    const fake = fakePage({ failing: new Set(['Fetch.continueRequest']) })
    await protectJobPage(fake.page, fake.report)
    await fake.pause({ requestId: 'r1', request: { url: 'https://jobs.example.com/' }, resourceType: 'Document', frameId: 'main' })
    await vi.waitFor(() => { expect(fake.sent.at(-1)).toEqual(['Fetch.failRequest', { requestId: 'r1', errorReason: 'BlockedByClient' }]) })
    const gone = fakePage({ failing: new Set(['Fetch.continueRequest', 'Fetch.failRequest']) })
    await protectJobPage(gone.page, gone.report)
    await gone.pause({ requestId: 'r1', request: { url: 'https://jobs.example.com/' }, resourceType: 'Document', frameId: 'main' })
    await vi.waitFor(() => { expect(gone.sent.at(-1)).toEqual(['Fetch.failRequest', { requestId: 'r1', errorReason: 'BlockedByClient' }]) })
  })

  it('connects an employer’s secure WebSocket and closes an unencrypted one or one to a denied or career-only host', async () => {
    const fake = fakePage()
    await protectJobPage(fake.page, fake.report)
    const employer = fake.socket('wss://jobs.example.com/live')
    const plain = fake.socket('ws://ats.example.com/live')
    const mail = fake.socket('wss://mail.google.com/sync')
    const careers = fake.socket('wss://stripe.com/jobs/live')
    expect([employer, plain, mail, careers].map(socket => [socket.connected, socket.closed])).toEqual([
      [true, false], [false, true], [false, true], [false, true],
    ])
    expect(fake.refused).toEqual([['ws://ats.example.com/live', false], ['https://mail.google.com/sync', false], ['https://stripe.com/jobs/live', false]])
  })
})
