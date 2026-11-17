/**
 * Launch, profile, and live-view settings. Every default path is derived from
 * the Harness home, so a profile directory or snapshot tree never becomes a
 * machine-specific absolute path in a composition.
 *
 * @module @deepseek-ai/dsh-headless-browser/config
 */

import { dshPath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'

/** Persistent profile, viewport, live-view, and screenshot settings. */
export interface Config {
  /**
   * Chromium profile directory; cookies, sign-ins, and local storage live here,
   * so they survive a host restart.
   * @default $DSH_HOME/data/headless-browser/profile
   */
  profileDir: string
  /** Run the browser without a visible window. @default true */
  headless: boolean
  /**
   * Report a macOS Chrome identity on every page and every new tab, so a site
   * that refuses a browser announcing itself as headless answers normally; see
   * `src/stealth.ts`. Turn it off to keep the browser's own surface.
   * @default true
   */
  stealth: boolean
  /** Page viewport width in CSS pixels; live-view frames are scaled to it. @default 1280 */
  viewportWidth: number
  /** Page viewport height in CSS pixels. @default 800 */
  viewportHeight: number
  /** JPEG quality of live-view frames, 1 through 100. @default 60 */
  jpegQuality: number
  /** Directory that receives `headless_browser_snapshot` PNG files. @default $DSH_HOME/cache/headless-browser/snapshots */
  snapshotDir: string
  /**
   * JSON file that keeps the registered keepalives across a restart, so their
   * timers are re-armed instead of the owner registering them again.
   * @default $DSH_HOME/data/headless-browser/keepalive.json
   */
  keepalivePath: string
  /**
   * Consecutive interactive sign-in challenges after which a keepalive says a
   * person has to sign in; earlier failures are retried on their own.
   * @default 3
   */
  keepaliveEscalateAfter: number
}

/** Validate {@link Config} before the browser is constructed. */
export const Config: z<Config> = z.object({
  profileDir: z.string().default(dshPath('data', 'headless-browser', 'profile')),
  headless: z.boolean().default(true),
  stealth: z.boolean().default(true),
  viewportWidth: z.natural().min(320).default(1280),
  viewportHeight: z.natural().min(240).default(800),
  jpegQuality: z.natural().min(1).max(100).default(60),
  snapshotDir: z.string().default(dshPath('cache', 'headless-browser', 'snapshots')),
  keepalivePath: z.string().default(dshPath('data', 'headless-browser', 'keepalive.json')),
  keepaliveEscalateAfter: z.natural().min(1).default(3),
})
