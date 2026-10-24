/**
 * Web sign-in and cookie refresh. The QR code is the "personal" web login
 * (scanned with the Bilibili app, including the international app whose
 * account signed in with Google), not the TV client. The refresh flow proves
 * possession of the session to `www.bilibili.com/correspond`, exchanges the
 * refresh token for new cookies, and then retires the old token.
 */
import { constants, publicEncrypt } from 'node:crypto'
import { z } from 'zod'
import type { BiliClient } from './client.ts'
import { cookiesFromUrl, mergeSetCookies, isSignedIn, type CookieJar } from './cookies.ts'

/** Public key Bilibili's web client uses to encrypt the refresh path (RSA-OAEP, SHA-256). */
export const REFRESH_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg
Uc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71
nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40
JNrRuoEUXpabUzGB8QIDAQAB
-----END PUBLIC KEY-----`

/** `source` the web header's login sends. */
const QR_SOURCE = 'main-fe-header'
/**
 * bilibili.com serves two web versions, mainland (`web_cn`) and international (`web_i`, under
 * language paths such as `/en/`). An account registered overseas (the international app's Google
 * sign-in) is refused on the mainland version with code 48007, and the official login popup then
 * moves to the international one. These are the page and the request metadata that popup sends
 * there (`x-bili-device-req-json` from its METADATA middleware, `x-bili-locale-json` from its
 * locale middleware); mainland accounts sign in through it as well.
 */
const INTERNATIONAL_PAGE = 'https://www.bilibili.com/en/'
const INTERNATIONAL_PARAMS: Readonly<Record<string, string>> = {
  'x-bili-device-req-json': JSON.stringify({ platform: 'web', device: 'pc', spmid: '333.42', mobi_app: 'web_i' }),
  'x-bili-locale-json': JSON.stringify({ c_locale: { language: 'en' } }),
}
/** QR poll codes. */
const QR_DONE = 0
const QR_EXPIRED = 86038
const QR_SCANNED = 86090
const QR_WAITING = 86101

/** The credential record's payload: everything a signed-in web session needs. Never logged. */
export interface BiliGrant {
  readonly version: 1
  /** `DedeUserID`, the account's user id. */
  readonly mid: number
  readonly cookies: CookieJar
  /** Token that buys new cookies through the refresh flow. */
  readonly refreshToken: string
  readonly loggedInAt: number
  readonly refreshedAt: number
}

const grantSchema = z.object({
  version: z.literal(1),
  mid: z.number().int().positive(),
  cookies: z.record(z.string(), z.string()),
  refreshToken: z.string().min(1),
  loggedInAt: z.number(),
  refreshedAt: z.number(),
})

/**
 * Read a stored payload, or undefined when it is not one this package wrote.
 * The reason never quotes the payload.
 * @param payload - `GrantRecord.payload`.
 */
export function parseGrant(payload: unknown): BiliGrant | undefined {
  const parsed = grantSchema.safeParse(payload)
  if (!parsed.success || !isSignedIn(parsed.data.cookies)) return undefined
  return parsed.data
}

/** A started QR login. */
export interface QrCode {
  /** What the code encodes; it carries the login key, so it is shown only to the signed-in owner. */
  readonly url: string
  readonly key: string
}

/** One poll of a QR login. */
export type QrPoll =
  | { readonly state: 'waiting' | 'scanned' | 'expired' }
  | { readonly state: 'failed'; readonly reason: string }
  | { readonly state: 'done'; readonly cookies: CookieJar; readonly refreshToken: string; readonly mid: number }

/**
 * Ask for a QR login code.
 * @param client - Bilibili client.
 */
export async function startQr(client: BiliClient): Promise<QrCode> {
  const { data } = await client.call('qrGenerate', {
    query: { source: QR_SOURCE, go_url: INTERNATIONAL_PAGE, ...INTERNATIONAL_PARAMS },
    referer: INTERNATIONAL_PAGE,
  })
  const fields = data as { url?: unknown; qrcode_key?: unknown } | undefined
  if (typeof fields?.url !== 'string' || typeof fields.qrcode_key !== 'string') throw new Error('qrcode/generate answered without a code')
  return { url: fields.url, key: fields.qrcode_key }
}

/**
 * Poll a QR login once. A confirmed login answers its cookies in `Set-Cookie`
 * and in the redirect URL; both are read.
 * @param client - Bilibili client.
 * @param key - `qrcode_key`.
 */
export async function pollQr(client: BiliClient, key: string): Promise<QrPoll> {
  const { data, setCookies } = await client.call('qrPoll', {
    query: { qrcode_key: key, source: QR_SOURCE, ...INTERNATIONAL_PARAMS },
    referer: INTERNATIONAL_PAGE,
  })
  const fields = data as { code?: unknown; url?: unknown; refresh_token?: unknown; message?: unknown } | undefined
  switch (fields?.code) {
    case QR_WAITING:
      return { state: 'waiting' }
    case QR_SCANNED:
      return { state: 'scanned' }
    case QR_EXPIRED:
      return { state: 'expired' }
    case QR_DONE: {
      const cookies = mergeSetCookies(typeof fields.url === 'string' ? cookiesFromUrl(fields.url) : {}, setCookies)
      const mid = Number(cookies.DedeUserID)
      if (!isSignedIn(cookies) || !Number.isSafeInteger(mid) || mid <= 0) return { state: 'failed', reason: 'the login answer carried no session cookies' }
      if (typeof fields.refresh_token !== 'string' || fields.refresh_token === '') return { state: 'failed', reason: 'the login answer carried no refresh token' }
      return { state: 'done', cookies, refreshToken: fields.refresh_token, mid }
    }
    default:
      return { state: 'failed', reason: `unexpected poll code ${String(fields?.code)}` }
  }
}

/**
 * Device cookies (`buvid3`, `buvid4`) a browser would carry; search and some
 * feeds refuse requests without them.
 * @param client - Bilibili client.
 */
export async function deviceCookies(client: BiliClient): Promise<CookieJar> {
  const { data } = await client.call('fingerSpi')
  const fields = data as { b_3?: unknown; b_4?: unknown } | undefined
  const jar: CookieJar = {}
  if (typeof fields?.b_3 === 'string' && fields.b_3 !== '') jar.buvid3 = fields.b_3
  if (typeof fields?.b_4 === 'string' && fields.b_4 !== '') jar.buvid4 = fields.b_4
  return jar
}

/** Digits bilibili.com's own script draws `_uuid` from; `10` is one of them. */
const UUID_DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F', '10']
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * The ids a browser makes on its first visit, as bilibili.com's script does: `_uuid` (five groups
 * of random digits, the time's last five milliseconds digits, `infoc`) and `b_nut` (Unix seconds).
 * @param now - Unix epoch milliseconds.
 * @param random - uniform source in [0, 1).
 */
export function newDeviceIds(now: number, random: () => number): { _uuid: string; b_nut: string } {
  const group = (length: number): string => Array.from({ length }, () => UUID_DIGITS[Math.floor(random() * UUID_DIGITS.length)]).join('')
  return { _uuid: `${[8, 4, 4, 4, 12].map(group).join('-')}${String(now % 100_000).padStart(5, '0')}infoc`, b_nut: String(Math.floor(now / 1000)) }
}

/**
 * Enroll the device the way a browser's first page does: one ExClimbWuzhi report carrying `_uuid`
 * and a canvas fingerprint tail (a PNG data URL ends in its IEND chunk), sent with the jar's
 * buvid3, `_uuid`, and `b_nut`. Without it Bilibili answers likes and shares with -403 账号异常.
 * @param client - Bilibili client; the jar must already hold `_uuid` and `b_nut`.
 * @param uuid - the jar's `_uuid`.
 * @param now - Unix epoch milliseconds.
 * @param random - uniform source in [0, 1).
 * @throws whatever the client throws for a non-zero answer.
 */
export async function enrollDevice(client: BiliClient, uuid: string, now: number, random: () => number): Promise<void> {
  const canvas = `${Array.from({ length: 34 }, () => BASE64[Math.floor(random() * BASE64.length)]).join('')}AAAAAElFTkSuQmCC`
  const payload = {
    '3064': 1,
    '5062': String(now),
    '03bf': encodeURIComponent('https://www.bilibili.com/'),
    '39c8': '333.1007.fp.risk',
    '3c43': { adca: 'MacIntel', bfe9: canvas },
    'df35': uuid,
    '07a4': 'zh-CN',
  }
  await client.call('exClimbWuzhi', { json: { payload: JSON.stringify(payload) } })
}

/**
 * The `correspond` path for a refresh: RSA-OAEP (SHA-256) of `refresh_<ms>`, hex.
 * @param publicKey - PEM public key.
 * @param timestamp - Unix epoch milliseconds from `cookie/info`.
 */
export function correspondPath(publicKey: string, timestamp: number): string {
  return publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(`refresh_${timestamp}`)).toString('hex')
}

/**
 * The `refresh_csrf` a correspond page carries in its `1-name` element.
 * @param html - the page.
 */
export function refreshCsrf(html: string): string | undefined {
  return /<div\s+id="1-name">\s*([0-9a-zA-Z]+)\s*<\/div>/.exec(html)?.[1]
}

/** Whether the session needs a refresh, with the server time the path must use. */
export async function refreshNeeded(client: BiliClient): Promise<{ refresh: boolean; timestamp: number }> {
  const { data } = await client.call('cookieInfo')
  const fields = data as { refresh?: unknown; timestamp?: unknown } | undefined
  if (typeof fields?.refresh !== 'boolean' || typeof fields.timestamp !== 'number') throw new Error('cookie/info answered without refresh facts')
  return { refresh: fields.refresh, timestamp: fields.timestamp }
}

/** New cookies and token from one refresh exchange. */
export interface RefreshedSession {
  readonly cookies: CookieJar
  readonly refreshToken: string
}

/**
 * Exchange the refresh token for new cookies. The caller stores the result
 * before {@link confirmRefresh}, so a crash between the two keeps the new session.
 * @param client - Bilibili client, still sending the old cookies.
 * @param grant - the stored session.
 * @param publicKey - PEM key for the correspond path.
 * @param timestamp - server time from {@link refreshNeeded}.
 */
export async function exchangeRefresh(
  client: BiliClient, grant: BiliGrant, publicKey: string, timestamp: number,
): Promise<RefreshedSession> {
  const page = await client.call('correspond', { path: `/correspond/1/${correspondPath(publicKey, timestamp)}` })
  const csrf = refreshCsrf(String(page.data))
  if (csrf === undefined) throw new Error('the correspond page carried no refresh_csrf')
  const { data, setCookies } = await client.call('cookieRefresh', {
    form: { refresh_csrf: csrf, source: 'main_web', refresh_token: grant.refreshToken },
  })
  const token = (data as { refresh_token?: unknown } | undefined)?.refresh_token
  if (typeof token !== 'string' || token === '') throw new Error('cookie/refresh answered without a refresh token')
  const cookies = mergeSetCookies(grant.cookies, setCookies)
  if (!isSignedIn(cookies) || cookies.SESSDATA === grant.cookies.SESSDATA) throw new Error('cookie/refresh answered without new session cookies')
  return { cookies, refreshToken: token }
}

/**
 * Retire the old refresh token once the new cookies are stored.
 * @param client - Bilibili client, now sending the new cookies (and csrf).
 * @param oldToken - the refresh token that was exchanged.
 */
export async function confirmRefresh(client: BiliClient, oldToken: string): Promise<void> {
  await client.call('confirmRefresh', { form: { refresh_token: oldToken } })
}
