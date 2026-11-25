/**
 * Speaking style settings section, node half: `GET /api/speaking-style` answers the samples, the last collection run, and
 * the trend; `POST /api/speaking-style.edit` applies the owner's delete, keep, or add; `POST /api/speaking-style.collect`
 * starts a run. All three sit under `/api`, so the connection's sign-in check (owner Peers only, Host/Origin fence)
 * guards them. The data comes from `ctx.speakingStyle` (speaking-style); without it the routes answer 503.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: the connection service's Context merge (ctx.connection).
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: the style service's Context merge (ctx.speakingStyle).
import type {} from '@deepseek-ai/dsh-speaking-style'
import { STYLE_COLLECT_PATH, STYLE_EDIT_PATH, STYLE_PATH, type StyleEditAnswer } from './view.ts'

/** Required Host services. */
export const inject = ['connection']

const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

/**
 * Register the style routes.
 * @param ctx - Host context with the connection service; `ctx.speakingStyle` is read per request.
 */
export function apply(ctx: Context): void {
  const { connection } = ctx
  const unavailable = (): Response => json({ error: 'unavailable', message: 'speaking-style is not mounted' }, 503)
  ctx.effect(() => connection.fetch.register({
    path: STYLE_PATH, methods: ['GET'], requestBody: 'buffered',
    fetch: async () => {
      const style = ctx.get('speakingStyle')
      return style === undefined ? unavailable() : json(await style.panel())
    },
  }), `speaking-style-settings: ${STYLE_PATH}`)
  ctx.effect(() => connection.fetch.register({
    path: STYLE_EDIT_PATH, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      const style = ctx.get('speakingStyle')
      if (style === undefined) return unavailable()
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return json({ ok: false, error: 'invalid_input', panel: await style.panel() } satisfies StyleEditAnswer, 400)
      }
      const answer = await style.edit(body)
      return json(answer, answer.ok ? 200 : answer.error === 'not_found' ? 404 : 400)
    },
  }), `speaking-style-settings: ${STYLE_EDIT_PATH}`)
  ctx.effect(() => connection.fetch.register({
    path: STYLE_COLLECT_PATH, methods: ['POST'], requestBody: 'buffered',
    fetch: async () => {
      const style = ctx.get('speakingStyle')
      return style === undefined ? unavailable() : json(await style.collect())
    },
  }), `speaking-style-settings: ${STYLE_COLLECT_PATH}`)
}
