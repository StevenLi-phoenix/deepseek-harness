import type { LookupAddress, LookupAllOptions, LookupOptions } from 'node:dns'
import type { LookupFunction } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { HttpFetchProvider } from '../src/provider.ts'
import { publicDispatcher } from '../src/public-only.ts'

const mocks = vi.hoisted(() => ({
  lookup: vi.fn<(host: string, options: LookupAllOptions) => Promise<LookupAddress[]>>(),
  request: vi.fn<(url: URL) => Response>(),
  destroy: vi.fn<() => Promise<void>>(),
  pinned: vi.fn<(addresses: string | LookupAddress[]) => void>(),
  connector: vi.fn<(lookup: LookupFunction) => void>(),
}))

vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }))
vi.mock('undici', () => ({
  Agent: class {
    constructor(readonly options: { connect: { lookup: LookupFunction } }) { mocks.connector(options.connect.lookup) }
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

/** The connector lookup of a fresh public dispatcher for `https://jobs.example.com/`, answering what it hands the socket. */
async function connect(options: LookupOptions, signal = new AbortController().signal) {
  publicDispatcher(new URL('https://jobs.example.com/'), signal)
  const lookup = mocks.connector.mock.calls.at(-1)?.[0]
  if (lookup === undefined) throw new Error('no dispatcher was created')
  return await new Promise<{ error: NodeJS.ErrnoException | null; address: string | LookupAddress[]; family?: number }>((resolve) => {
    lookup('jobs.example.com', options, (error, address, family) => { resolve({ error, address, family }) })
  })
}

it('hands a socket that asks for one address the first checked one of the family it names', async () => {
  mocks.lookup.mockResolvedValue(publicAddresses)
  expect(await connect({})).toEqual({ error: null, address: '93.184.216.34', family: 4 })
  expect(await connect({ family: 'IPv6' })).toEqual({ error: null, address: '2606:4700::1111', family: 6 })
  expect(await connect({ family: 'IPv4' })).toEqual({ error: null, address: '93.184.216.34', family: 4 })
  expect(await connect({ family: 6, all: true })).toEqual({ error: null, address: [publicAddresses[1]], family: undefined })
})

it('refuses a scoped or mislabelled answer, and answers no address for a family DNS did not return', async () => {
  for (const answer of [{ address: 'fe80::1%en0', family: 6 }, { address: '93.184.216.34', family: 6 }]) {
    mocks.lookup.mockResolvedValueOnce([answer])
    expect((await connect({})).error).toMatchObject({ code: 'WEB_BLOCKED_URL' })
  }
  mocks.lookup.mockResolvedValueOnce([publicAddresses[0]!])
  expect((await connect({ family: 6 })).error).toMatchObject({ code: 'WEB_FETCH_DNS_FAILED' })
})

it('answers an aborted request, and passes a DNS failure on as an Error', async () => {
  const aborted = new AbortController()
  aborted.abort()
  mocks.lookup.mockResolvedValueOnce(publicAddresses)
  expect((await connect({}, aborted.signal)).error).toMatchObject({ code: 'WEB_ABORTED' })
  const failure = new Error('getaddrinfo ENOTFOUND jobs.example.com')
  mocks.lookup.mockRejectedValueOnce(failure)
  expect((await connect({})).error).toBe(failure)
  mocks.lookup.mockRejectedValueOnce('resolver down')
  expect((await connect({})).error).toMatchObject({ message: 'DNS lookup failed', cause: 'resolver down' })
})
