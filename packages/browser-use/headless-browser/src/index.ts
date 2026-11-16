/**
 * One persistent headless Chromium per plugin instance: model tools that drive
 * it, and a Web page under `/headless-browser` where the user watches the live
 * frame and, when they need to, takes the page over. Control passes between the
 * agent and the user instead of both acting at once; the profile directory is
 * the browser's own state, so a sign-in survives a host restart.
 *
 * @module @deepseek-ai/dsh-headless-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Config } from './config.ts'
import { LiveView } from './live-view.ts'
import { PAGE_PATH, mountTakeoverRoutes } from './routes.ts'
import { HeadlessBrowserSession } from './session.ts'
import { TakeoverState } from './takeover.ts'
import { registerBrowserTools } from './tools.ts'

export { Config } from './config.ts'

/** Plugin name registered with the Loader. */
export const name = 'headless-browser'

/** The tool registry; the Web routes attach when a Web server is present. */
export const inject = ['tools']

/**
 * Mount the browser, its tools, and its take-over page.
 * @param ctx - the mounting scope's context.
 * @param config - validated launch, view, and snapshot settings.
 */
export function apply(ctx: Context, config: Config): void {
  const browser = new HeadlessBrowserSession(config, ctx.logger)
  const takeover = new TakeoverState()
  const view = new LiveView(() => browser.castTarget(), {
    jpegQuality: config.jpegQuality,
    maxWidth: config.viewportWidth,
    maxHeight: config.viewportHeight,
  }, ctx.logger)

  ctx.effect(() => async () => {
    await view.close()
    await browser.close()
  }, 'headless-browser: close the browser')

  registerBrowserTools(ctx, {
    browser,
    takeover,
    pageUrl: () => {
      const server = ctx.get('webServer')
      return server === undefined ? PAGE_PATH : `${server.getOrigin()}${PAGE_PATH}`
    },
  })

  // A composition without a Web server still gives the agent a browser; it just
  // has no page to hand over to.
  ctx.inject(['webServer'], (web) => {
    web.effect(
      () => mountTakeoverRoutes(web.webServer, { browser, takeover, view, log: ctx.logger }),
      'headless-browser: take-over routes',
    )
  })
}
