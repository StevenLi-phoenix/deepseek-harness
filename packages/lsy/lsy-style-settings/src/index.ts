/**
 * Speaking style settings section, node half: `GET /api/lsy.style` answers the samples, the last collection run, and
 * the trend; `POST /api/lsy.style.edit` applies the owner's delete, keep, or add; `POST /api/lsy.style.collect`
 * starts a run. All three sit under `/api`, so the connection's sign-in check (owner Peers only, Host/Origin fence)
 * guards them. The data comes from `ctx.lsyStyle` (lsy-style); without it the routes answer 503.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: the style service's Context merge (ctx.lsyStyle) and its answers.
import type { StyleEditAnswer as ServiceEditAnswer, StylePanel as ServicePanel } from '@deepseek-ai/dsh-lsy-style'
import { STYLE_COLLECT_PATH, STYLE_EDIT_PATH, STYLE_PATH, type StyleEditAnswer, type StylePanel } from './view.ts'

/** Required Host services. */
export const inject = ['connection']

/** The service's answers fit the fields the browser half reads. */
type Fits<Source extends Target, Target> = Source
export type PanelFits = Fits<ServicePanel, StylePanel>
export type EditAnswerFits = Fits<ServiceEditAnswer, StyleEditAnswer>

/** The slice of the connection service this plugin uses. */
interface StyleConnection {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'POST')[]
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

/**
 * Register the style routes.
 * @param ctx - Host context with the connection service; `ctx.lsyStyle` is read per request.
 */
export function apply(ctx: Context): void {
  const connection = Reflect.get(ctx, 'connection') as StyleConnection
  const unavailable = (): Response => json({ error: 'unavailable', message: 'lsy-style is not mounted' }, 503)
  ctx.effect(() => connection.fetch.register({
    path: STYLE_PATH, methods: ['GET'], requestBody: 'buffered',
    fetch: async () => {
      const style = ctx.get('lsyStyle')
      return style === undefined ? unavailable() : json(await style.panel())
    },
  }), `lsy-style-settings: ${STYLE_PATH}`)
  ctx.effect(() => connection.fetch.register({
    path: STYLE_EDIT_PATH, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      const style = ctx.get('lsyStyle')
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
  }), `lsy-style-settings: ${STYLE_EDIT_PATH}`)
  ctx.effect(() => connection.fetch.register({
    path: STYLE_COLLECT_PATH, methods: ['POST'], requestBody: 'buffered',
    fetch: async () => {
      const style = ctx.get('lsyStyle')
      return style === undefined ? unavailable() : json(await style.collect())
    },
  }), `lsy-style-settings: ${STYLE_COLLECT_PATH}`)
}
