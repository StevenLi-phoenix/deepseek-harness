/** Drawing a QR code the Host sent as module rows: one SVG path, no scripts and no HTML from the Host. */
import type { LoginQr } from '../../wechat-view.ts'

/** Light modules around the code that scanners need. */
export const QUIET_ZONE = 3

/**
 * The SVG path of the dark modules: one rectangle per horizontal run, shifted by the quiet zone.
 * @param qr - the code.
 * @returns path data for a `viewBox` of `qrViewSize(qr)` modules per side.
 */
export function qrPath(qr: LoginQr): string {
  const runs: string[] = []
  qr.rows.forEach((row, y) => {
    for (const run of row.matchAll(/1+/gu)) runs.push(`M${run.index + QUIET_ZONE} ${y + QUIET_ZONE}h${run[0].length}v1h-${run[0].length}z`)
  })
  return runs.join('')
}

/**
 * The drawing's size.
 * @param qr - the code.
 * @returns modules per side of the drawing, quiet zone included.
 */
export function qrViewSize(qr: LoginQr): number {
  return qr.size + QUIET_ZONE * 2
}

/**
 * Whether a link is safe to offer as a clickable fallback: the Host takes it from WeChat's answer, so only
 * an HTTPS link on a WeChat domain is.
 * @param url - the link the code encodes.
 * @returns whether the link may be shown as a clickable link.
 */
export function isWeixinLink(url: string): boolean {
  if (!URL.canParse(url)) return false
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  return host === 'weixin.qq.com' || host.endsWith('.weixin.qq.com') || host === 'wechat.com' || host.endsWith('.wechat.com')
}
