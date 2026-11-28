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
import { dshPath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { mkdir } from 'node:fs/promises'
import { Config } from './config.ts'
import { CredentialVault } from './credentials.ts'
import { firstLine } from './error.ts'
import { registerFormTools } from './form-tools.ts'
import { ActionGuard, type SecurityEvent } from './guard.ts'
import { mountJobApplyBrowser } from './job-apply.ts'
import { KeepaliveService, type KeepaliveEvent } from './keepalive.ts'
import { LiveView } from './live-view.ts'
import { PAGE_PATH, mountTakeoverRoutes } from './routes.ts'
import { HeadlessBrowserSession } from './session.ts'
import { TabStore } from './tab-store.ts'
import { TakeoverState } from './takeover.ts'
import { registerBrowserTools } from './tools.ts'
import { UploadPolicy } from './uploads.ts'

export { Config } from './config.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-only shared profile operations for the restricted preset mount. */
    headlessBrowserJobBridge: {
      readonly browser: HeadlessBrowserSession
      readonly takeover: TakeoverState
      readonly credentials: CredentialVault
    }
    /** Trusted current-tab context for the verification-code tool in the job-apply scope. */
    jobApplyBrowser: {
      currentHost(sessionId: string, signal?: AbortSignal): Promise<string | null>
      /** Link hostnames of the caller's current job page, for an ATS page that vouches for its employer's mail domain. */
      linkedHosts(sessionId: string, signal?: AbortSignal): Promise<readonly string[]>
      registrableDomain(host: string): string | null
    }
  }
  interface Events {
    /**
     * One action-guard decision, published so a host can watch what the browser is asked to do.
     * @param event - the refusal, explicit allow, unrequested move, or coordinate click that was recorded.
     * @mode emit
     */
    'headless-browser/security'(event: SecurityEvent): void
    /**
     * One keepalive transition — `recovering`, `needs-human`, `error`, or
     * `recovered` — and at most one `reminder` an hour while a keepalive stays
     * `needs-human`. Exactly one event per transition, so a host can count them.
     * @param event - the entry, its new state, and what the last attempt saw.
     * @mode emit
     */
    'headless-browser/keepalive'(event: KeepaliveEvent): void
  }
}

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
  const restriction = config.jobApply
  if (restriction !== undefined) {
    ctx.inject(['headlessBrowserJobBridge'], (scoped) => {
      mountJobApplyBrowser(scoped, config, restriction, scoped.headlessBrowserJobBridge)
    })
    return
  }
  // One guard for the whole plugin: the tools consult it, and the status route
  // reads the same event list, so a refusal cannot be logged twice or lost.
  const guard = new ActionGuard({
    onEvent: (event) => { ctx.emit('headless-browser/security', event) },
    sensitiveActions: config.sensitiveActions,
  })
  const browser = new HeadlessBrowserSession(config, ctx.logger, guard, {
    tabStore: new TabStore(dshPath('data', 'headless-browser', 'tabs.json'), ctx.logger),
  })
  void browser.reconcileTabsOnBoot().catch((error: unknown) => {
    ctx.logger.warn('headless-browser: reconciling tabs on browser startup failed: %s', firstLine(error))
  })
  const keepalives = new KeepaliveService({
    path: config.keepalivePath,
    create: async () => await browser.keepalivePage(),
    log: ctx.logger,
    escalateAfter: config.keepaliveEscalateAfter,
    ...config.keepaliveExpect === undefined ? {} : { expectById: config.keepaliveExpect },
    emit: (event) => { ctx.emit('headless-browser/keepalive', event) },
  })
  const takeover = new TakeoverState()
  const credentials = new CredentialVault(config.credentialsPath)
  ctx.provide('headlessBrowserJobBridge', { browser, takeover, credentials })
  const uploads = new UploadPolicy(config.uploadDirs, config.maxUploadMB)
  // The first upload directory is where the owner drops a task's files, so it exists from the first mount.
  const firstUploadDir = config.uploadDirs[0]
  if (firstUploadDir !== undefined) {
    void mkdir(firstUploadDir, { recursive: true, mode: 0o700 }).catch((error: unknown) => {
      ctx.logger.warn('headless-browser: creating the upload directory %s failed: %s', firstUploadDir, firstLine(error))
    })
  }
  const view = new LiveView(() => browser.castTarget(), {
    jpegQuality: config.jpegQuality,
    maxWidth: config.viewportWidth,
    maxHeight: config.viewportHeight,
  }, ctx.logger)

  // Re-armed from the file at mount: a session that matters does not wait for
  // someone to open its page before it is visited again.
  void keepalives.load().catch((error: unknown) => {
    ctx.logger.warn('headless-browser: arming the keepalives failed: %s', firstLine(error))
  })

  // A recovery replaces the context, so every keepalive timer and every page
  // pool entry that pointed at the old one has to move to the new one.
  const detachRelaunch = browser.onRelaunch(() => {
    void keepalives.rearm().catch((error: unknown) => {
      ctx.logger.warn('headless-browser: re-arming the keepalives after a recovery failed: %s', firstLine(error))
    })
  })

  ctx.effect(() => async () => {
    detachRelaunch()
    await keepalives.close()
    await view.close()
    await browser.close()
  }, 'headless-browser: close the browser')

  registerBrowserTools(ctx, {
    browser,
    keepalives,
    takeover,
    pageUrl: () => {
      const server = ctx.get('webServer')
      return server === undefined ? PAGE_PATH : `${server.getOrigin()}${PAGE_PATH}`
    },
  })

  registerFormTools(ctx, { browser, takeover, credentials, uploads, log: ctx.logger })

  // A composition without a Web server still gives the agent a browser; it just
  // has no page to hand over to.
  ctx.inject(['webServer'], (web) => {
    web.effect(
      () => mountTakeoverRoutes(web.webServer, {
        browser,
        takeover,
        view,
        security: guard.log,
        keepalives: () => keepalives.snapshot(),
        log: ctx.logger,
        credentials,
      }),
      'headless-browser: take-over routes',
    )
  })
}
