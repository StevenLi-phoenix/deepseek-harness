/**
 * Guard overview route, mounted as its own row (`@deepseek-ai/dsh-lsy-guard/settings`): `GET /api/lsy.guard` answers
 * the counts the Memory settings section shows beside the guard's configuration card. The route sits under `/api`, so
 * the connection's sign-in check guards it. It answers counts and rule names only, never a text, a canary, or a
 * verdict's reason, and registers no tool and no service.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GuardHealth } from './types.ts'

/** Absolute Host registration path of the route. */
export const GUARD_PATH = '/api/lsy.guard'

/** Required Host services: the connection to serve on and the guard to count. */
export const inject = ['connection', 'lsyGuard']

/** The slice of the connection service this plugin uses. */
interface GuardConnection {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly 'GET'[]
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/**
 * Answer the overview.
 * @param health - the guard's counts for the last 24 hours.
 * @returns the JSON response, not cacheable.
 */
export function overview(health: GuardHealth): Response {
  return Response.json({ health }, { headers: { 'cache-control': 'no-store' } })
}

/**
 * Register the overview route.
 * @param ctx - Host context with the connection and the guard.
 */
export function apply(ctx: Context): void {
  const connection = Reflect.get(ctx, 'connection') as GuardConnection
  const guard = ctx.lsyGuard
  ctx.logger.info('lsy-guard-settings: serving %s', GUARD_PATH)
  ctx.effect(() => connection.fetch.register({
    path: GUARD_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => Promise.resolve(overview(guard.health())),
  }), 'lsy-guard-settings: /api/lsy.guard')
}
