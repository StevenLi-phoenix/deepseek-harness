/**
 * The take-over routes' paths. Both halves of the package read them: the Host
 * registers its routes here, and the browser half of the take-over page
 * connects to the same live socket and status route from inside the app shell,
 * so the two never drift apart.
 *
 * @module @deepseek-ai/dsh-headless-browser/paths
 */

/** Page path of the standalone take-over page; the mountable route prefix of this plugin. */
export const PAGE_PATH = '/headless-browser'
/** Status path behind the page and the in-app view. */
export const STATUS_PATH = '/headless-browser/status'
/** {@link STATUS_PATH} relative to the app document, so the in-app view reads it under any mount. */
export const STATUS_ROUTE = STATUS_PATH.slice(1)
/** Upgrade path of the live view socket. */
export const LIVE_PATH = '/headless-browser/live'
/** Owner-only JSON list of the saved site accounts, without passwords. */
export const CREDENTIALS_PATH = '/headless-browser/credentials'
/** Owner-only CSV of the saved site accounts with passwords, in the layout Chrome's password manager imports. */
export const CREDENTIALS_CSV_PATH = '/headless-browser/credentials.csv'
