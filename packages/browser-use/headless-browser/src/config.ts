/**
 * Launch, profile, and live-view settings. Every default path is derived from
 * the Harness home, so a profile directory or snapshot tree never becomes a
 * machine-specific absolute path in a composition.
 *
 * @module @deepseek-ai/dsh-headless-browser/config
 */

import { dshPath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { ExpectationList, type KeepaliveExpectation } from './keepalive-expect.ts'

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
  /**
   * Whether the action guard refuses a click or type whose target's accessible
   * name or value matches the sensitive table: submit, pay, delete, and the rest
   * of `SENSITIVE_ACTIONS`. Off, that action runs and the skip is still recorded
   * as a security event with `rule: 'sensitive-name'` and `skipped: true`, so the
   * audit trail keeps every target the rule would have refused. Turn it off only
   * for a task the owner supervises directly, such as pressing submit on a form
   * the owner read; the visibility and origin rules stay on either way.
   * @default true
   */
  sensitiveActions: boolean
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
  /** Landing checks to override on named keepalive ids. */
  keepaliveExpect?: Record<string, KeepaliveExpectation[]>
  /**
   * Directory that receives the files the browser downloads, one owner-only
   * file each; see `src/downloads.ts`.
   * @default $DSH_HOME/cache/headless-browser/downloads
   */
  downloadDir: string
  /** Largest download kept, in megabytes; a bigger file is deleted and reported as failed. @default 256 */
  maxDownloadMB: number
  /** Days a downloaded file is kept before it is deleted; 0 keeps every file. @default 7 */
  downloadRetainDays: number
  /**
   * Download a PDF instead of opening it in the browser's viewer. A headless
   * browser's viewer shows the model nothing, so a PDF page reads as empty.
   * @default true
   */
  downloadPdfs: boolean
  /**
   * JSON file of the site accounts the agent created with
   * `headless_browser_credential`, passwords included; mode `0600`. The owner
   * exports it from `GET /headless-browser/credentials.csv`.
   * @default $DSH_HOME/data/headless-browser/credentials.json
   */
  credentialsPath: string
  /**
   * Directories whose files `headless_browser_upload` may attach; a file
   * anywhere else is refused, so a page cannot talk the agent into uploading a
   * key or a config file. The first directory also resolves bare file names.
   * @default [$DSH_HOME/data/headless-browser/uploads]
   */
  uploadDirs: string[]
  /** Largest file `headless_browser_upload` attaches, in megabytes. @default 25 */
  maxUploadMB: number
}

/** Validate {@link Config} before the browser is constructed. */
export const Config: z<Config> = z.object({
  profileDir: z.string().default(dshPath('data', 'headless-browser', 'profile')),
  headless: z.boolean().default(true),
  stealth: z.boolean().default(true),
  sensitiveActions: z.boolean().default(true),
  viewportWidth: z.natural().min(320).default(1280),
  viewportHeight: z.natural().min(240).default(800),
  jpegQuality: z.natural().min(1).max(100).default(60),
  snapshotDir: z.string().default(dshPath('cache', 'headless-browser', 'snapshots')),
  keepalivePath: z.string().default(dshPath('data', 'headless-browser', 'keepalive.json')),
  keepaliveEscalateAfter: z.natural().min(1).default(3),
  keepaliveExpect: z.dict(ExpectationList),
  downloadDir: z.string().default(dshPath('cache', 'headless-browser', 'downloads')),
  maxDownloadMB: z.natural().min(1).default(256),
  downloadRetainDays: z.natural().min(0).default(7),
  downloadPdfs: z.boolean().default(true),
  credentialsPath: z.string().default(dshPath('data', 'headless-browser', 'credentials.json')),
  uploadDirs: z.array(z.string()).default([dshPath('data', 'headless-browser', 'uploads')]),
  maxUploadMB: z.natural().min(1).default(25),
})
