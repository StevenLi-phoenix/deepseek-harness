/**
 * QQ settings section, node half: `GET /api/fork.qq` answers the QQ observer's connection, NapCat's login state,
 * and, when QQ was signed out, the login QR code as a module matrix; `POST /api/fork.qq.refresh` asks NapCat for a
 * fresh code. Both routes sit under `/api`, so the connection's sign-in check (owner Peers only, Host/Origin fence)
 * guards them. The data comes from `ctx.forkQq`, which reads NapCat's login through the login door and never hands
 * out the WebUI token. Nothing about the code is logged here.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the QQ observer's Context merge (ctx.forkQq).
import type {} from '@deepseek-ai/dsh-fork-qq'
import { buildPanel, buildRefresh, type QqSource } from './panel.ts'
import { QQ_PATH, QQ_REFRESH_PATH } from './view.ts'

/** Required Host services. */
export const inject = ['connection', 'forkQq']

/** The slice of the connection service this plugin uses. */
interface QqConnectionRoutes {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'POST')[]
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/**
 * Register the QQ status and refresh routes.
 * @param ctx - Host context with the connection service and the QQ observer.
 */
export function apply(ctx: Context): void {
  const connection = Reflect.get(ctx, 'connection') as QqConnectionRoutes
  const source = (): QqSource => ctx.forkQq
  ctx.effect(() => connection.fetch.register({
    path: QQ_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async request => Response.json(
      await buildPanel(source(), { fresh: new URL(request.url).searchParams.get('fresh') === '1' }),
      { headers: { 'cache-control': 'no-store' } },
    ),
  }), `fork-qq-login: ${QQ_PATH}`)
  ctx.effect(() => connection.fetch.register({
    path: QQ_REFRESH_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => Response.json(await buildRefresh(source()), { headers: { 'cache-control': 'no-store' } }),
  }), `fork-qq-login: ${QQ_REFRESH_PATH}`)
}
