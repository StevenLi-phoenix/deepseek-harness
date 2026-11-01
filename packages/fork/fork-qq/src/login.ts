/**
 * Client of the login door (`fork/deploy/napcat/login-door.py`): the narrow window onto NapCat's WebUI that tells
 * whether QQ is logged in and, when a scan is needed, which code to scan. The door speaks to NapCat with the WebUI
 * token, which this process never holds; callers present the OneBot token they already have. Everything the door
 * answers is checked field by field again here.
 */

import type { QqLoginState } from './status.ts'

/** What asking the door came to. */
export type DoorResult =
  | { kind: 'ok'; login: QqLoginState; uin: string | null; nickname: string | null; error: string | null; qrUrl: string | null }
  | { kind: 'napcat-down' }
  | { kind: 'unreachable' }
  | { kind: 'unauthorized' }
  | { kind: 'invalid' }

const LOGIN_STATES: ReadonlySet<string> = new Set<QqLoginState>(['online', 'offline', 'qr', 'scanned', 'logging-in', 'preparing', 'restarting', 'unknown'])

/** A short single-line string, or null. */
function text(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit)
  return clean === '' ? null : clean
}

/**
 * Whether a string is the kind of link the door passes on: https on a qq.com host.
 * @param value - the candidate.
 * @returns the link, or null.
 */
export function qrLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 600 || /\s/.test(value)) return null
  const url = URL.parse(value)
  if (url === null || url.protocol !== 'https:') return null
  return url.hostname === 'qq.com' || url.hostname.endsWith('.qq.com') ? value : null
}

/**
 * Check one door answer's shape.
 * @param body - the parsed JSON.
 * @returns the typed result; `invalid` for anything that is not the door's contract.
 */
export function parseDoorAnswer(body: unknown): DoorResult {
  if (typeof body !== 'object' || body === null) return { kind: 'invalid' }
  const fields = body as Record<string, unknown>
  if (fields['v'] !== 1) return { kind: 'invalid' }
  if (fields['napcat'] === 'down') return { kind: 'napcat-down' }
  const login = fields['login']
  if (fields['napcat'] !== 'up' || typeof login !== 'string' || !LOGIN_STATES.has(login)) return { kind: 'invalid' }
  const uin = typeof fields['uin'] === 'string' && /^[0-9]{1,20}$/.test(fields['uin']) ? fields['uin'] : null
  return {
    kind: 'ok',
    login: login as QqLoginState,
    uin,
    nickname: text(fields['nickname'], 64),
    error: text(fields['error'], 200),
    qrUrl: login === 'qr' ? qrLink(fields['qrUrl']) : null,
  }
}

/** Options of {@link LoginDoor}. */
export interface LoginDoorOptions {
  /** The door's address, such as `http://127.0.0.1:3002`. */
  url: string
  /** Deadline of one call, in milliseconds. */
  timeoutMs: number
  /** Replaced by tests. */
  fetch?: typeof fetch
}

/** The login door's HTTP client. */
export class LoginDoor {
  private readonly base: string
  private readonly request: typeof fetch

  /** @param options - the door's address, deadline, and (for tests) fetch. */
  constructor(private readonly options: LoginDoorOptions) {
    this.base = options.url.replace(/\/+$/, '')
    this.request = options.fetch ?? fetch
  }

  /**
   * @param token - the OneBot access token.
   * @returns NapCat's login state as the door reports it.
   */
  status(token: string): Promise<DoorResult> {
    return this.send('GET', '/v1/login', token).then(answer => answer.result)
  }

  /**
   * Ask NapCat for a fresh QR code.
   * @param token - the OneBot access token.
   * @returns the state after the request, and whether the door passed the request on (it declines a second one within seconds).
   */
  refresh(token: string): Promise<{ result: DoorResult; refreshed: boolean }> {
    return this.send('POST', '/v1/login/refresh', token)
  }

  private async send(method: 'GET' | 'POST', path: string, token: string): Promise<{ result: DoorResult; refreshed: boolean }> {
    let response: Response
    try {
      response = await this.request(this.base + path, {
        method,
        headers: { authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs),
      })
    } catch {
      return { result: { kind: 'unreachable' }, refreshed: false }
    }
    if (response.status === 401 || response.status === 503) return { result: { kind: 'unauthorized' }, refreshed: false }
    if (!response.ok) return { result: { kind: 'invalid' }, refreshed: false }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      return { result: { kind: 'invalid' }, refreshed: false }
    }
    const refreshed = typeof body === 'object' && body !== null && (body as Record<string, unknown>)['refreshed'] === true
    return { result: parseDoorAnswer(body), refreshed }
  }
}
