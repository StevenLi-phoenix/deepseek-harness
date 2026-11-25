/**
 * The owner's Google OAuth client in the credential store: read for each sign-in and refresh, shown to Settings
 * without its secret, and stored from the JSON file Google Cloud gives out.
 */

import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { z as zod } from 'zod'
import { GmailError } from './errors.ts'
import type { OAuthClient } from './oauth.ts'
import type { ClientInfo } from './types.ts'

/** A Google OAuth client JSON file (`web` or `installed`), or its inner object. */
const clientFileSchema = zod.union([
  zod.object({ web: zod.object({ client_id: zod.string(), client_secret: zod.string() }) }).transform(file => file.web),
  zod.object({ installed: zod.object({ client_id: zod.string(), client_secret: zod.string() }) }).transform(file => file.installed),
  zod.object({ client_id: zod.string(), client_secret: zod.string() }),
])

/** What {@link OAuthClientStore} reads and writes. */
export interface OAuthClientDeps {
  readonly credentials: Pick<CredentialProvider, 'resolve' | 'describe' | 'set'>
  /** Name of the client id in the credential store. */
  readonly clientIdEnv: string
  /** Name of the client secret in the credential store. */
  readonly clientSecretEnv: string
  readonly logger: { info(message: string): void }
}

/** The OAuth client's id and secret, under the configured credential names. */
export class OAuthClientStore {
  /** @param deps - the credential store, the credential names, and the logger. */
  constructor(private readonly deps: OAuthClientDeps) {}

  /**
   * The client for a sign-in or a refresh.
   * @returns the client id and secret.
   * @throws GmailError `not-configured` when either is missing.
   */
  async client(): Promise<OAuthClient> {
    const [id, secret] = await Promise.all([
      this.deps.credentials.resolve(credentialRef(this.deps.clientIdEnv)),
      this.deps.credentials.resolve(credentialRef(this.deps.clientSecretEnv)),
    ])
    if (id === undefined || secret === undefined) throw new GmailError('not-configured', 'the Google OAuth client is not set up; the owner pastes its JSON in Settings → 邮箱')
    return { clientId: id.value, clientSecret: secret.value }
  }

  /**
   * The client's state.
   * @returns whether it is set, and its id (not secret).
   */
  async info(): Promise<ClientInfo> {
    const [id, secret] = await Promise.all([
      this.deps.credentials.resolve(credentialRef(this.deps.clientIdEnv)),
      this.deps.credentials.describe(credentialRef(this.deps.clientSecretEnv)),
    ])
    return { configured: id !== undefined && secret.configured, clientId: id?.value ?? null, secretConfigured: secret.configured }
  }

  /**
   * Store the client from Google's downloaded JSON.
   * @param text - the JSON file's text.
   * @returns the client as Settings shows it.
   * @throws GmailError `invalid` when the text is not a client file.
   */
  async set(text: string): Promise<ClientInfo> {
    let parsed: { client_id: string; client_secret: string }
    try {
      const result = clientFileSchema.safeParse(JSON.parse(text))
      if (!result.success) throw new GmailError('invalid', 'the JSON has no client_id and client_secret (download it from Google Cloud → Credentials → OAuth client)')
      parsed = result.data
    } catch (error: unknown) {
      if (error instanceof GmailError) throw error
      throw new GmailError('invalid', 'that is not JSON; paste the whole client file Google gave you')
    }
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/u.test(parsed.client_id) || parsed.client_secret.trim() === '') {
      throw new GmailError('invalid', 'the client id must end in .apps.googleusercontent.com and the secret must not be empty')
    }
    await this.deps.credentials.set(credentialRef(this.deps.clientIdEnv), parsed.client_id)
    await this.deps.credentials.set(credentialRef(this.deps.clientSecretEnv), parsed.client_secret.trim())
    this.deps.logger.info(`gmail: OAuth client stored (${parsed.client_id.slice(0, 12)}…)`)
    return this.info()
  }
}
