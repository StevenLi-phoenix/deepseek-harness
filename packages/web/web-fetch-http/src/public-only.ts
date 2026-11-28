/** Direct, public-address-only dispatch for anonymous HTTP fetch. */
import { lookup } from 'node:dns/promises'
import net, { isIP } from 'node:net'
import { Agent } from 'undici'
import { WebError } from '@deepseek-ai/dsh-web'

const privateIPv4 = new net.BlockList()
for (const [address, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) privateIPv4.addSubnet(address, bits, 'ipv4')

const globalIPv6 = new net.BlockList()
globalIPv6.addSubnet('2000::', 3, 'ipv6')
const specialIPv6 = new net.BlockList()
for (const [address, bits] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] as const) specialIPv6.addSubnet(address, bits, 'ipv6')

const localSuffixes = ['localhost', 'local', 'internal', 'home.arpa', 'onion']

function isPublicAddress(address: string, family: number): boolean {
  if (address.includes('%') || isIP(address) !== family) return false
  if (family === 4) return !privateIPv4.check(address, 'ipv4')
  // Global unicast only; this excludes mapped IPv4, ULA, link-local, and multicast.
  return family === 6 && globalIPv6.check(address, 'ipv6') && !specialIPv6.check(address, 'ipv6')
}

function blocked(hostname: string): WebError {
  return new WebError(`public-only web fetch refused a non-public destination: ${hostname}`, 'WEB_BLOCKED_URL')
}

/**
 * Check the destination and create a fresh dispatcher using only the addresses its connector
 * just verified. DNS validation and socket address selection share the same lookup; URL/Host
 * and TLS identity still use the original name. An explicit dispatcher bypasses ambient proxies,
 * which could otherwise resolve destinations again. Callers destroy it after each hop.
 * @param url - normalized HTTP(S) URL for this hop.
 * @param signal - deadline and caller cancellation for the request.
 * @returns a direct dispatcher that refuses non-public destinations before connecting.
 */
export function publicDispatcher(url: URL, signal: AbortSignal): Agent {
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '').replace(/^\[|\]$/gu, '')
  const family = isIP(hostname)
  if (family !== 0 ? !isPublicAddress(hostname, family) : (
    !hostname.includes('.') || localSuffixes.some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`))
  )) throw blocked(hostname)

  // proxy-exempt: public-only fetch connects only to the addresses this lookup verified, so no ambient proxy may resolve the name again.
  return new Agent({ connect: { lookup: (_name, options, callback) => {
    // An absolute name avoids applying system DNS search suffixes. Check every answer even if
    // the socket requests a single family; never hand a private answer to the connector.
    void lookup(`${hostname}.`, { all: true }).then((addresses) => {
      if (signal.aborted) {
        callback(new WebError('web fetch aborted', 'WEB_ABORTED'), '')
        return
      }
      if (addresses.some(({ address, family }) => !isPublicAddress(address, family))) {
        callback(blocked(hostname), '')
        return
      }
      const wanted = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family
      const eligible = wanted === 4 || wanted === 6 ? addresses.filter(record => record.family === wanted) : addresses
      const first = eligible[0]
      if (first === undefined) {
        callback(new WebError('DNS returned no usable addresses', 'WEB_FETCH_DNS_FAILED'), '')
        return
      }
      if (options.all) callback(null, eligible)
      else callback(null, first.address, first.family)
    }, (error: unknown) => { callback(error instanceof Error ? error : new Error('DNS lookup failed', { cause: error }), '') })
  } } })
}
