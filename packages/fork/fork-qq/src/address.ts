/**
 * Which addresses the QQ channel may be pointed at: this machine and the tailnet only. Shared by DSH (which refuses a
 * bad configuration at load) and the recorder (which refuses a pushed one); neither imports the other's modules for it.
 */

/** Whether the URL points at this machine or the tailnet, the only places the protocol end may live. */
export function isPrivateUrl(raw: string): boolean {
  return isPrivateAddress(raw, ['ws:', 'wss:'])
}

/**
 * Whether a URL of one of the given schemes points at this machine or the tailnet: the same rule as
 * {@link isPrivateUrl}, for the login door's HTTP address.
 * @param raw - the address.
 * @param protocols - accepted schemes, with the colon.
 * @returns true for localhost, loopback, a tailnet address (100.64.0.0/10), or a `*.ts.net` name.
 */
export function isPrivateAddress(raw: string, protocols: readonly string[]): boolean {
  const url = URL.parse(raw)
  if (url === null || !protocols.includes(url.protocol)) return false
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1') return true
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return host.endsWith('.ts.net')
  const [first = 0, second = 0] = parts
  return first === 127 || (first === 100 && second >= 64 && second <= 127)
}

/** Hosts QQ serves message media from; a link anywhere else is not followed. */
export const DEFAULT_MEDIA_HOST_SUFFIXES: readonly string[] = [
  '.qq.com', '.qpic.cn', '.gtimg.cn', '.qlogo.cn', '.qfile.qq.com', '.myqcloud.com', '.nt.qq.com.cn',
]
