/**
 * Apple Push Notification service client for VoIP pushes, with token-based authentication: an
 * ES256 JWT signed by the owner's `.p8` key over HTTP/2, refreshed well inside Apple's one-hour limit.
 */

import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { connect, constants, type ClientHttp2Session } from 'node:http2'
import type { ApnsEnvironment } from './protocol.ts'

/** Where pushes go, per environment; tests point both at a local server. */
export interface ApnsHosts {
  /** Origin of the development push service, for apps signed for development. */
  sandbox: string
  /** Origin of the production push service, for TestFlight and App Store builds. */
  production: string
}

/** Apple's push endpoints. */
export const APPLE_HOSTS: ApnsHosts = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
}

/** Signing identity and endpoints of one client. */
export interface ApnsOptions {
  /** The key's ten-character id. */
  keyId: string
  /** The Apple Developer team id. */
  teamId: string
  /** The `.p8` key in PEM form. */
  privateKeyPem: string
  /** `apns-topic`: the app's bundle id with `.voip` appended. */
  topic: string
  hosts: ApnsHosts
  /** Deadline of one push, in milliseconds. */
  timeoutMs: number
  /** Clock in milliseconds. */
  now?: () => number
}

/** What APNs answered. */
export type PushResult =
  | { ok: true; apnsId: string | undefined }
  /** `unregistered` means the token is dead and the device should be forgotten. */
  | { ok: false; status: number; reason: string; unregistered: boolean }

/** A JWT is reused this long; Apple refuses tokens older than an hour and throttles refreshes under twenty minutes. */
const TOKEN_TTL_MS = 50 * 60_000

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url')
}

/**
 * Sign the provider authentication token.
 * @param key - the ES256 private key.
 * @param keyId - its id.
 * @param teamId - the team id.
 * @param issuedAtS - `iat` in seconds.
 * @returns the compact JWT.
 */
export function providerToken(key: KeyObject, keyId: string, teamId: string, issuedAtS: number): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }))
  const claims = base64url(JSON.stringify({ iss: teamId, iat: issuedAtS }))
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' })
  return `${header}.${claims}.${base64url(signature)}`
}

/** One HTTP/2 connection per environment, opened on first use and kept until {@link ApnsClient.close}. */
export class ApnsClient {
  private readonly key: KeyObject
  private readonly sessions = new Map<ApnsEnvironment, ClientHttp2Session>()
  private token: { value: string; at: number } | undefined
  private readonly now: () => number

  /**
   * @param options - signing identity and endpoints.
   * @throws when the key is not an EC private key in PEM form.
   */
  constructor(private readonly options: ApnsOptions) {
    this.key = createPrivateKey(options.privateKeyPem)
    if (this.key.asymmetricKeyType !== 'ec') throw new Error('the APNs key must be an EC (ES256) private key')
    this.now = options.now ?? Date.now
  }

  /**
   * Send one VoIP push at the highest priority, never stored for later delivery.
   * @param deviceToken - the PushKit token as hex.
   * @param environment - which endpoint the token belongs to.
   * @param payload - the JSON body.
   * @returns what APNs answered.
   * @throws on a network failure or timeout.
   */
  async send(deviceToken: string, environment: ApnsEnvironment, payload: unknown): Promise<PushResult> {
    const session = this.session(environment)
    const body = JSON.stringify(payload)
    const request = session.request({
      [constants.HTTP2_HEADER_METHOD]: 'POST',
      [constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
      authorization: `bearer ${this.jwt()}`,
      'apns-push-type': 'voip',
      'apns-topic': this.options.topic,
      'apns-priority': '10',
      'apns-expiration': '0',
      'content-type': 'application/json',
    })
    request.setTimeout(this.options.timeoutMs, () => { request.close(constants.NGHTTP2_CANCEL) })
    const answer = await new Promise<{ status: number; apnsId: string | undefined; text: string }>((resolve, reject) => {
      let status = 0
      let apnsId: string | undefined
      const chunks: Buffer[] = []
      request.on('response', (headers) => {
        status = Number(headers[constants.HTTP2_HEADER_STATUS])
        const id = headers['apns-id']
        apnsId = typeof id === 'string' ? id : undefined
      })
      request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      // A cancelled or reset stream also ends its readable side, before any response: only an answered stream resolves.
      request.on('end', () => { if (status !== 0) resolve({ status, apnsId, text: Buffer.concat(chunks).toString('utf8') }) })
      request.on('close', () => { if (status === 0) reject(new Error(`APNs ${environment} request closed without an answer`)) })
      request.on('error', reject)
      request.end(body)
    })
    if (answer.status === 200) return { ok: true, apnsId: answer.apnsId }
    let parsed: { reason?: unknown } | undefined
    try {
      parsed = JSON.parse(answer.text) as { reason?: unknown }
    } catch (error: unknown) {
      // An answer without a JSON body keeps the HTTP status as its reason.
      void error
    }
    const reason = typeof parsed?.reason === 'string' ? parsed.reason : `HTTP ${answer.status}`
    // The cached token is refused once Apple considers it stale or wrong; sign a fresh one next time.
    if (answer.status === 403) this.token = undefined
    return { ok: false, status: answer.status, reason, unregistered: answer.status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered' }
  }

  /** Close every connection. */
  close(): void {
    for (const session of this.sessions.values()) session.close()
    this.sessions.clear()
  }

  private jwt(): string {
    const now = this.now()
    if (this.token === undefined || now - this.token.at >= TOKEN_TTL_MS) {
      this.token = { value: providerToken(this.key, this.options.keyId, this.options.teamId, Math.floor(now / 1000)), at: now }
    }
    return this.token.value
  }

  private session(environment: ApnsEnvironment): ClientHttp2Session {
    const open = this.sessions.get(environment)
    if (open !== undefined && !open.closed && !open.destroyed) return open
    const session = connect(this.options.hosts[environment])
    session.on('error', () => { this.sessions.delete(environment) })
    session.on('close', () => { if (this.sessions.get(environment) === session) this.sessions.delete(environment) })
    session.on('goaway', () => { if (this.sessions.get(environment) === session) this.sessions.delete(environment) })
    // An idle connection must not keep the process alive.
    session.unref()
    this.sessions.set(environment, session)
    return session
  }
}
