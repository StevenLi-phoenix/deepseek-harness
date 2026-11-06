/**
 * Settings console, Host half: three routes under `/api` for the browser half's Settings sections. `GET /api/lsy.overview`
 * answers one health card per integrated service, `GET`/`POST /api/lsy.subscriptions` list and change the bus subscriptions and
 * schedule reminders, and `GET`/`POST /api/lsy.agents` show the service account's Claude Code sessions and the voice service,
 * start and stop sessions, and synthesize a preview. The connection's sign-in check guards every route, a POST must be
 * `application/json`, every body is validated, and every action is logged by name, target, outcome, and duration. Probes run
 * in parallel under a deadline, so a service that is down turns its card red and nothing else.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-schedule'
import { readAgents, runAgentsAction } from './agents.ts'
import { Config } from './config.ts'
import { collectOverview } from './overview.ts'
import { Refusal, readJson } from './request.ts'
import { listSubscriptions, runSubscriptionAction } from './subscriptions.ts'
import { collectActivity } from './activity.ts'
import { AGENTS_PATH, FLOW_PATH, OVERVIEW_PATH, SUBSCRIPTIONS_PATH, type ActionError, type ActionErrorCode } from './views.ts'

export { Config } from './config.ts'
export type { HealthReport } from './overview.ts'

/** Plugin name registered with the Loader. */
export const name = 'lsy-console'

/** Required Host services. */
export const inject = ['connection']

/** HTTP status of each refusal code. */
const STATUS: Record<ActionErrorCode, number> = {
  invalid_request: 400,
  unavailable: 503,
  not_found: 404,
  config_owned: 409,
  duplicate_id: 409,
  invalid_subscription: 422,
  limit_reached: 429,
  start_failed: 502,
  stop_failed: 502,
  speech_failed: 502,
  speech_off: 409,
  internal_error: 500,
}

/** The slice of the connection service this plugin uses. */
interface ConsoleConnection {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'POST')[]
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

const NO_STORE = { 'cache-control': 'no-store' } as const

function refusalResponse(refusal: Refusal): Response {
  const body: ActionError = refusal.detail === undefined ? { error: refusal.code } : { error: refusal.code, detail: refusal.detail }
  return Response.json(body, { status: STATUS[refusal.code], headers: NO_STORE })
}

/**
 * Register the four routes.
 * @param ctx - Host context with the connection service.
 * @param config - resolved configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const connection = Reflect.get(ctx, 'connection') as ConsoleConnection
  const log = ctx.logger

  /** Answer a GET with JSON, a POST through `post`; unexpected failures are logged by class and answered as `internal_error`. */
  const handle = (
    read: () => Promise<unknown>,
    post: ((body: unknown) => Promise<Response>) | undefined,
  ) => async (request: Request): Promise<Response> => {
    try {
      if (request.method === 'GET') return Response.json(await read(), { headers: NO_STORE })
      if (post === undefined) return Response.json({ error: 'invalid_request' } satisfies ActionError, { status: 405, headers: NO_STORE })
      return await post(await readJson(request))
    } catch (error: unknown) {
      if (error instanceof Refusal) return refusalResponse(error)
      log.warn(`lsy-console: ${request.method} ${new URL(request.url).pathname} failed: ${error instanceof Error ? error.name : 'error'}`)
      return Response.json({ error: 'internal_error' } satisfies ActionError, { status: 500, headers: NO_STORE })
    }
  }

  const register = (path: string, methods: readonly ('GET' | 'POST')[], fetch: (request: Request) => Promise<Response>): void => {
    ctx.effect(() => connection.fetch.register({ path, methods, requestBody: 'buffered', fetch }), `lsy-console: ${path}`)
  }

  register(OVERVIEW_PATH, ['GET'], handle(() => collectOverview({ ctx, config }), undefined))
  register(FLOW_PATH, ['GET'], handle(() => Promise.resolve(collectActivity(ctx, Date.now())), undefined))
  register(SUBSCRIPTIONS_PATH, ['GET', 'POST'], handle(
    () => listSubscriptions(ctx, config),
    async (body) => {
      await runSubscriptionAction(ctx, config, log, body)
      return Response.json({ ok: true, ...await listSubscriptions(ctx, config) }, { headers: NO_STORE })
    },
  ))
  register(AGENTS_PATH, ['GET', 'POST'], handle(
    () => readAgents(ctx, config),
    async (body) => {
      const result = await runAgentsAction(ctx, config, log, body)
      if (result.kind === 'audio') return new Response(result.bytes as BodyInit, { headers: { 'content-type': result.type, ...NO_STORE } })
      return Response.json({ ok: true, ...await readAgents(ctx, config) }, { headers: NO_STORE })
    },
  ))
}
