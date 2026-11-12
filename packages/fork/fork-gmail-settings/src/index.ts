/**
 * Settings → 邮箱, node half. `GET /api/fork.gmail` answers the OAuth client, the accounts, the held and latest
 * resolved messages, and the activity from `ctx.forkGmail`; `POST /api/fork.gmail` (JSON only) stores the client,
 * starts a sign-in, changes a policy, removes an account, or confirms or discards a held message, and answers the new
 * status. Both sit under `/api`, so the connection's sign-in check guards them.
 *
 * `GET /fork.gmail.oauth` is the page Google's sign-in returns to. It lies outside `/api` because the DSH sign-in
 * cookie is `SameSite=Strict` and Google's cross-site redirect arrives without it; the one-use `state` that only an
 * open sign-in started from Settings holds authenticates the request.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { GmailError, OAUTH_PATH, type GmailStatus, type ForkGmail } from '@deepseek-ai/dsh-fork-gmail'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { PAGE_HEADERS, signInPage } from './page.ts'
import { GMAIL_PATH, POLICIES, type GmailAction, type GmailAnswer, type GmailView } from './view.ts'

export * from './view.ts'
export { escapeHtml, signInPage } from './page.ts'

/** Plugin name. */
export const name = 'fork-gmail-settings'

/** Required Host services; the sign-in page also needs `webServer`, which only a served Host has. */
export const inject = ['connection', 'forkGmail']

/** The slice of the connection service this plugin uses. */
interface GmailConnection {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'POST')[]
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

const NO_STORE = { 'cache-control': 'no-store' }

/** The actions, validated at the wire. */
const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('client'), json: z.string().min(1).max(20_000) }).strict(),
  z.object({ action: z.literal('sign-in'), account: z.string().max(64), policy: z.enum(POLICIES).optional(), loginHint: z.string().max(320).optional() }).strict(),
  z.object({ action: z.literal('policy'), account: z.string().max(64), policy: z.enum(POLICIES) }).strict(),
  z.object({ action: z.literal('remove'), account: z.string().max(64) }).strict(),
  z.object({ action: z.literal('confirm'), code: z.string().max(32) }).strict(),
  z.object({ action: z.literal('discard'), code: z.string().max(32) }).strict(),
])

/**
 * The status as the page reads it.
 * @param status - from `ctx.forkGmail.status()`.
 * @returns the wire view, field by field, so a new service field never reaches the browser unreviewed.
 */
export function toView(status: GmailStatus): GmailView {
  return {
    client: { configured: status.client.configured, clientId: status.client.clientId, secretConfigured: status.client.secretConfigured },
    redirectUri: status.redirectUri,
    accounts: status.accounts.map(account => ({
      id: account.id, email: account.email, name: account.name, policy: account.policy, addedAt: account.addedAt,
      lastOkAt: account.lastOkAt, lastError: account.lastError, needsReconnect: account.needsReconnect, sentToday: account.sentToday,
    })),
    pending: status.pending.map(row => ({
      code: row.code, account: row.account, from: row.from, to: row.to, cc: row.cc, bcc: row.bcc, subject: row.subject,
      preview: row.preview, attachments: row.attachments, createdAt: row.createdAt, origin: row.origin, reason: row.reason,
      status: row.status, resolvedAt: row.resolvedAt, resolvedBy: row.resolvedBy, noticeSent: row.noticeSent,
    })),
    activity: status.activity.map(row => ({ seq: row.seq, at: row.at, account: row.account, kind: row.kind, detail: row.detail })),
    maxSendsPerDay: status.maxSendsPerDay,
    confirmTtlHours: status.confirmTtlHours,
    trustedRecipients: status.trustedRecipients,
  }
}

/** Human-readable error text. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run one action.
 * @param gmail - the Gmail service.
 * @param action - the validated action.
 * @param origin - the page's origin, for a sign-in's redirect URI.
 * @returns the Google page to open, for `sign-in`.
 */
async function perform(gmail: ForkGmail, action: GmailAction, origin: string): Promise<string | undefined> {
  switch (action.action) {
    case 'client':
      await gmail.setClient(action.json)
      return undefined
    case 'sign-in':
      return (await gmail.beginSignIn({ account: action.account.trim(), policy: action.policy, loginHint: action.loginHint, origin })).url
    case 'policy':
      await gmail.setPolicy(action.account, action.policy)
      return undefined
    case 'remove':
      await gmail.removeAccount(action.account)
      return undefined
    case 'confirm':
      await gmail.confirm(action.code.trim().toUpperCase(), { by: 'settings' })
      return undefined
    case 'discard':
      await gmail.discard(action.code.trim().toUpperCase())
      return undefined
    /* v8 ignore next 2 -- GmailAction is a closed union; the default only makes a new action a compile error. */
    default:
      return assertNever(action, 'fork-gmail-settings action')
  }
}

/**
 * Register the status and action routes, and the sign-in page once the web server is mounted.
 * @param ctx - Host context with the connection service and the Gmail service.
 */
export function apply(ctx: Context): void {
  const connection = Reflect.get(ctx, 'connection') as GmailConnection
  const gmail = (): ForkGmail => ctx.forkGmail
  const answer = async (extra: Partial<GmailAnswer> = {}): Promise<Response> => {
    const body: GmailAnswer = { status: toView(await gmail().status()), ...extra }
    return Response.json(body, { headers: NO_STORE })
  }
  ctx.effect(() => connection.fetch.register({
    path: GMAIL_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'GET') return answer()
      // A cross-site form cannot send JSON, so only a same-origin page script reaches an action.
      if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return Response.json({ error: 'send application/json' }, { status: 415 })
      let parsed: GmailAction
      try {
        const result = actionSchema.safeParse(await request.json())
        if (!result.success) return Response.json({ error: `not an action: ${result.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}` }, { status: 400 })
        parsed = result.data
      } catch {
        // SyntaxError: the body is not JSON.
        return Response.json({ error: 'the body is not JSON' }, { status: 400 })
      }
      const origin = request.headers.get('origin') ?? new URL(request.url).origin
      const started = Date.now()
      try {
        const signInUrl = await perform(gmail(), parsed, origin)
        ctx.logger.info(`fork-gmail-settings: ${parsed.action} done in ${Date.now() - started} ms`)
        return await answer(signInUrl === undefined ? {} : { signInUrl })
      } catch (error: unknown) {
        if (error instanceof GmailError) {
          ctx.logger.info(`fork-gmail-settings: ${parsed.action} refused (${error.failure}): ${error.message}`)
          return Response.json({ error: error.message }, { status: 400, headers: NO_STORE })
        }
        ctx.logger.warn(`fork-gmail-settings: ${parsed.action} failed: ${errorText(error)}`)
        return Response.json({ error: 'the action failed; the DSH log has the details' }, { status: 500, headers: NO_STORE })
      }
    },
  }), `fork-gmail-settings: ${GMAIL_PATH}`)

  ctx.inject(['webServer'], (web) => {
    web.effect(() => web.webServer.register({
      kind: 'exact',
      path: OAUTH_PATH,
      resource: async (request) => {
        const query = new URL(request.url).searchParams
        const state = query.get('state') ?? ''
        if (state === '') return new Response(signInPage('failed', '没有连接', '这个地址缺少登录状态，请回到设置 → 邮箱重新连接。'), { status: 400, headers: PAGE_HEADERS })
        try {
          const account = await gmail().completeSignIn({ state, code: query.get('code') ?? undefined, error: query.get('error') ?? undefined })
          ctx.logger.info(`fork-gmail-settings: sign-in page connected ${account.id}`)
          return new Response(signInPage('ok', `已连接 ${account.id}`, `${account.email} 已连接，发信规则为 ${account.policy}。这个页面可以关掉了。`), { status: 200, headers: PAGE_HEADERS })
        } catch (error: unknown) {
          const known = error instanceof GmailError
          ctx.logger.warn(`fork-gmail-settings: sign-in page failed: ${errorText(error)}`)
          const detail = known ? error.message : '连接时出了错，DSH 日志里有详情。'
          return new Response(signInPage('failed', '没有连接', detail), { status: known ? 400 : 500, headers: PAGE_HEADERS })
        }
      },
    }), `fork-gmail-settings: ${OAUTH_PATH}`)
  })
}
