import type { LookupAddress, LookupAllOptions } from 'node:dns'
import type { LookupFunction } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { HttpFetchProvider } from '../src/provider.ts'

const mocks = vi.hoisted(() => ({
  lookup: vi.fn<(host: string, options: LookupAllOptions) => Promise<LookupAddress[]>>(),
  request: vi.fn<(url: URL) => Response>(),
  destroy: vi.fn<() => Promise<void>>(),
  pinned: vi.fn<(addresses: string | LookupAddress[]) => void>(),
}))

vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }))
vi.mock('undici', () => ({
  Agent: class {
    constructor(readonly options: { connect: { lookup: LookupFunction } }) {}
    destroy = mocks.destroy
  },
  fetch: async (url: URL, init: { dispatcher: { options: { connect: { lookup: LookupFunction } } }; redirect: string }) => {
    expect(init.redirect).toBe('manual')
    if (!/^[\d.]+$|^\[/u.test(url.hostname)) {
      await new Promise<void>((resolve, reject) => {
        init.dispatcher.options.connect.lookup(url.hostname, { all: true }, (error, addresses) => {
          if (error !== null) reject(new TypeError('fetch failed', { cause: error }))
          else { mocks.pinned(addresses); resolve() }
        })
      })
    }
    return mocks.request(url)
  },
}))

afterEach(() => vi.resetAllMocks())

const provider = new HttpFetchProvider({
  maxResponseBytes: 1024, maxBodyChars: 1024, maxRedirects: 3, timeoutMs: 5000, userAgent: 'test',
})
const publicAddresses = [
  { address: '93.184.216.34', family: 4 },
  { address: '2606:4700::1111', family: 6 },
]
const response = () => new Response('posting', { headers: { 'content-type': 'text/plain' } })

it.each([
  'http://localhost/', 'http://corp.local./', 'http://intranet/', 'http://127.0.0.1/',
  'http://10.0.0.1/', 'http://100.64.0.1/', 'http://169.254.169.254/', 'http://192.168.1.1/',
  'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fd12::1]/', 'http://[fe80::1]/',
  'http://[2001:db8::1]/',
])('refuses the non-public destination %s before DNS or transport', async (url) => {
  await expect(provider.fetchPublic({ url })).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
  expect(mocks.lookup).not.toHaveBeenCalled()
  expect(mocks.request).not.toHaveBeenCalled()
})

it('hands the connector only the checked addresses and retains the original URL', async () => {
  mocks.lookup.mockResolvedValue(publicAddresses)
  mocks.request.mockImplementation(response)
  const result = await provider.fetchPublic({ url: 'https://jobs.example.com/posting' })
  expect(result.body.content).toBe('posting')
  expect(mocks.lookup).toHaveBeenCalledExactlyOnceWith('jobs.example.com.', { all: true })
  expect(mocks.pinned).toHaveBeenCalledExactlyOnceWith(publicAddresses)
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith(new URL('https://jobs.example.com/posting'))
  expect(mocks.destroy).toHaveBeenCalledOnce()
})

it('rejects a hostname with mixed public and private DNS addresses before connecting', async () => {
  mocks.lookup.mockResolvedValue([...publicAddresses, { address: '192.168.0.1', family: 4 }])
  await expect(provider.fetchPublic({ url: 'https://jobs.example.com/' })).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
  expect(mocks.pinned).not.toHaveBeenCalled()
  expect(mocks.request).not.toHaveBeenCalled()
  expect(mocks.destroy).toHaveBeenCalledOnce()
})

it('revalidates DNS for a same-origin redirect before sending its request', async () => {
  mocks.lookup
    .mockResolvedValueOnce(publicAddresses)
    .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }])
  mocks.request.mockReturnValueOnce(new Response(null, { status: 302, headers: { location: '/next' } }))
  await expect(provider.fetchPublic({ url: 'https://jobs.example.com/posting' })).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
  expect(mocks.lookup).toHaveBeenCalledTimes(2)
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith(new URL('https://jobs.example.com/posting'))
  expect(mocks.destroy).toHaveBeenCalledTimes(2)
})

it('does not follow a redirect to another origin', async () => {
  mocks.lookup.mockResolvedValue(publicAddresses)
  mocks.request.mockReturnValueOnce(new Response(null, { status: 302, headers: { location: 'https://corp.local/next' } }))
  await expect(provider.fetchPublic({ url: 'https://jobs.example.com/posting' })).rejects.toMatchObject({ code: 'WEB_REDIRECT_BLOCKED' })
  expect(mocks.lookup).toHaveBeenCalledOnce()
  expect(mocks.request).toHaveBeenCalledOnce()
})
