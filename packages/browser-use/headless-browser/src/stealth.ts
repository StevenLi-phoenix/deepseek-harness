/**
 * The identity every page of this browser presents: Chrome on macOS on Apple
 * silicon, reported the same way in JavaScript and on the wire.
 *
 * Why this exists. A Chromium that Playwright launches announces itself twice:
 * `navigator.userAgentData.brands` and `navigator.userAgent` say
 * `HeadlessChrome`, `navigator.webdriver` is true, and the product token does
 * not match the `Sec-CH-UA*` request headers. A site whose bot check keys on
 * any of those refuses the page — a refusal that says nothing about the request
 * itself or the address it came from, and that the same Chromium does not get
 * once the surface is aligned.
 *
 * What it changes, in both places the surface lives:
 *
 * - launch flags and context settings: the full Chromium build rather than the
 *   headless shell, `--disable-blink-features=AutomationControlled`, the
 *   `--lang` switch, the user-agent string, and the locale and time zone;
 * - a document-start script on every page and frame: `navigator.userAgentData`
 *   with `getHighEntropyValues`, `navigator.webdriver`, `navigator.plugins`,
 *   `navigator.languages`, `window.chrome`, and the WebGL vendor and renderer
 *   strings;
 * - a CDP `Emulation.setUserAgentOverride` per page, so the client hints the
 *   browser sends at navigation (`Sec-CH-UA`, the full version list,
 *   architecture, bitness, platform version) match that same identity.
 *
 * What it does not do, deliberately: no invented font list, no certificate or
 * TLS spoofing, no challenge or CAPTCHA handling, and no change to what the
 * page's own content may contain. A site that still refuses the page is the
 * owner's to take over from the take-over view, which keeps working either way.
 *
 * Scope: this is for reading pages the owner has a right to read with the
 * browser the owner already runs.
 *
 * @module @deepseek-ai/dsh-headless-browser/stealth
 */

import type { Context } from '@deepseek-ai/cordis'
import { firstLine } from './error.ts'

/**
 * Version of the Chromium build the pinned `playwright-core` installs. Its
 * revision is fixed by that dependency, so the identity below is a fact about
 * this package's browser rather than a machine setting; revisit it when the
 * dependency moves.
 */
export const STEALTH_FULL_VERSION = '153.0.8010.12'

/** Major version, which is what a user-agent brand and the user-agent string carry. */
const STEALTH_MAJOR_VERSION = STEALTH_FULL_VERSION.slice(0, STEALTH_FULL_VERSION.indexOf('.'))

/** The reduced user-agent string a Chrome of this version sends on macOS. */
const STEALTH_USER_AGENT = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${STEALTH_MAJOR_VERSION}.0.0.0 Safari/537.36`

/**
 * Chromium flags of the identity. `--no-sandbox` lets the browser start under a
 * service account, and the blink switch removes the automation feature that
 * reports `navigator.webdriver`.
 */
export const STEALTH_LAUNCH_ARGS: readonly string[] = [
  '--no-sandbox',
  '--disable-blink-features=AutomationControlled',
  '--lang=en-US',
]

/**
 * Playwright channel of the identity: the full Chromium build, whose new
 * headless mode is the browser a person runs, not the separate headless shell.
 */
export const STEALTH_CHANNEL = 'chromium'

/** One entry of `navigator.userAgentData.brands`. */
export interface UserAgentBrand {
  /** Brand name, such as `Google Chrome`. */
  readonly brand: string
  /** Brand version, which is the major version, or a GREASE value. */
  readonly version: string
}

/** Everything one page can read about the browser it runs in. */
export interface StealthIdentity {
  /** The `navigator.userAgent` and request `user-agent` value. */
  readonly userAgent: string
  /** `navigator.language`. */
  readonly language: string
  /** `navigator.languages`. */
  readonly languages: readonly string[]
  /** `navigator.userAgentData.platform`, and the `Sec-CH-UA-Platform` value. */
  readonly platform: string
  /** `Sec-CH-UA-Platform-Version`, a high-entropy hint. */
  readonly platformVersion: string
  /** `Sec-CH-UA-Arch`, a high-entropy hint. */
  readonly architecture: string
  /** `Sec-CH-UA-Bitness`, a high-entropy hint. */
  readonly bitness: string
  /** `WEBGL_debug_renderer_info` vendor string of the GPU. */
  readonly vendor: string
  /** `WEBGL_debug_renderer_info` renderer string of the GPU. */
  readonly renderer: string
  /** Brand list the page reads and the low-entropy client hints carry. */
  readonly brands: readonly UserAgentBrand[]
  /** Full brand list of the high-entropy hints, with patch versions. */
  readonly fullVersionList: readonly UserAgentBrand[]
  /** Exact browser version, the `uaFullVersion` hint. */
  readonly fullVersion: string
  /** Time zone the browser reports, which is the host's own. */
  readonly timeZone: string
}

/** The configuration one launch applies to reach that identity. */
export interface StealthLaunch {
  /** Playwright channel: the full Chromium build. */
  readonly channel: string
  /** Chromium command-line flags. */
  readonly args: string[]
  /** User-agent string of the context, used before any page override lands. */
  readonly userAgent: string
  /** Context locale, which sets `Accept-Language` and `Intl`. */
  readonly locale: string
  /** Context time zone, which sets `Date` and `Intl`. */
  readonly timeZone: string
}

/** Arguments of one `Emulation.setUserAgentOverride`. */
export interface UserAgentOverride {
  /** Overridden user-agent string. */
  readonly userAgent: string
  /** Overridden `Accept-Language`, without the quality weights. */
  readonly acceptLanguage: string
  /** Overridden `navigator.platform`. */
  readonly platform: string
  /** Client hints the browser sends on the next navigation. */
  readonly userAgentMetadata: {
    readonly brands: UserAgentBrand[]
    readonly fullVersionList: UserAgentBrand[]
    readonly fullVersion: string
    readonly platform: string
    readonly platformVersion: string
    readonly architecture: string
    readonly bitness: string
    readonly model: string
    readonly mobile: boolean
    readonly wow64: boolean
  }
}

let identity: StealthIdentity | undefined

/**
 * The identity this deployment presents: one coherent macOS arm64 Chrome of the
 * pinned build. The time zone is read from the host, so a page's clock agrees
 * with the machine's.
 * @returns the identity every page and context is given.
 */
export function stealthIdentity(): StealthIdentity {
  identity ??= Object.freeze({
    userAgent: STEALTH_USER_AGENT,
    language: 'en-US',
    languages: ['en-US', 'en'] as const,
    platform: 'macOS',
    platformVersion: '15.5.0',
    architecture: 'arm64',
    bitness: '64',
    vendor: 'Apple M4',
    renderer: 'Apple GPU',
    brands: Object.freeze([
      { brand: 'Google Chrome', version: STEALTH_MAJOR_VERSION },
      { brand: 'Chromium', version: STEALTH_MAJOR_VERSION },
      // The GREASE brand: a deliberately meaningless name and version every
      // Chromium sends, so a parser cannot assume a fixed brand list.
      { brand: 'Not_A Brand', version: '24' },
    ]),
    fullVersionList: Object.freeze([
      { brand: 'Google Chrome', version: STEALTH_FULL_VERSION },
      { brand: 'Chromium', version: STEALTH_FULL_VERSION },
      { brand: 'Not_A Brand', version: '24.0.0.0' },
    ]),
    fullVersion: STEALTH_FULL_VERSION,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
  return identity
}

/**
 * The launch settings that reach the identity.
 * @param target - identity to launch; defaults to {@link stealthIdentity}.
 * @returns channel, flags, and the context settings that carry the identity.
 */
export function stealthLaunch(target: StealthIdentity = stealthIdentity()): StealthLaunch {
  return {
    channel: STEALTH_CHANNEL,
    args: [...STEALTH_LAUNCH_ARGS],
    userAgent: target.userAgent,
    locale: target.language,
    timeZone: target.timeZone,
  }
}

/**
 * The arguments of the per-page CDP override, which is what fixes the client
 * hints sent at navigation.
 * @param target - identity to report; defaults to {@link stealthIdentity}.
 * @returns the exact `Emulation.setUserAgentOverride` parameters.
 */
export function userAgentOverride(target: StealthIdentity = stealthIdentity()): UserAgentOverride {
  return {
    userAgent: target.userAgent,
    acceptLanguage: target.languages.join(','),
    platform: 'MacIntel',
    userAgentMetadata: {
      brands: [...target.brands],
      fullVersionList: [...target.fullVersionList],
      fullVersion: target.fullVersion,
      platform: target.platform,
      platformVersion: target.platformVersion,
      architecture: target.architecture,
      bitness: target.bitness,
      model: '',
      mobile: false,
      wow64: false,
    },
  }
}

/**
 * The script that runs before any page script in every document: it replaces the
 * JavaScript surface a bot check reads. Values come from the identity, so the
 * script and the client hints cannot drift apart.
 * @param target - identity to report; defaults to {@link stealthIdentity}.
 * @returns the source text for `addInitScript`.
 */
export function stealthInitScript(target: StealthIdentity = stealthIdentity()): string {
  const brands = JSON.stringify(target.brands)
  const fullVersionList = JSON.stringify(target.fullVersionList)
  const languages = JSON.stringify(target.languages)
  return `(() => {
  const brands = ${brands}
  const fullVersionList = ${fullVersionList}
  const language = ${JSON.stringify(target.language)}
  const languages = ${languages}
  const platform = ${JSON.stringify(target.platform)}
  // The high-entropy hints, by the names a page may ask for. Chrome resolves
  // only the hints it was asked for, plus the low-entropy fields.
  const highEntropy = {
    fullVersionList,
    platformVersion: ${JSON.stringify(target.platformVersion)},
    architecture: ${JSON.stringify(target.architecture)},
    bitness: ${JSON.stringify(target.bitness)},
    model: '',
    uaFullVersion: ${JSON.stringify(target.fullVersion)},
    wow64: false,
  }
  const userAgentData = {
    brands,
    mobile: false,
    platform,
    getHighEntropyValues(hints) {
      const values = { brands, mobile: false, platform }
      for (const hint of hints === undefined ? [] : hints) {
        if (hint in highEntropy) values[hint] = highEntropy[hint]
      }
      return Promise.resolve(values)
    },
    toJSON() { return { brands, mobile: false, platform } },
  }
  const define = (target, name, value) => {
    try {
      Object.defineProperty(target, name, { configurable: true, get: () => value })
    } catch (error) {
      // A frozen prototype keeps its own value; the other replacements still apply.
      void error
    }
  }
  define(Navigator.prototype, 'userAgentData', userAgentData)
  // Chromium reports undefined here, and a page reads the difference.
  define(Navigator.prototype, 'webdriver', undefined)
  define(Navigator.prototype, 'language', language)
  define(Navigator.prototype, 'languages', languages)
  const plugin = name => {
    const entry = Object.create(typeof Plugin === 'function' ? Plugin.prototype : Object.prototype)
    Object.defineProperties(entry, {
      name: { value: name, enumerable: true },
      filename: { value: 'internal-pdf-viewer', enumerable: true },
      description: { value: 'Portable Document Format', enumerable: true },
      length: { value: 1, enumerable: true },
    })
    return entry
  }
  // A real PluginArray reports itself as one in Object.prototype.toString and
  // in an instanceof check, so the entries live on its prototype rather than on
  // a plain array.
  const plugins = Object.create(typeof PluginArray === 'function' ? PluginArray.prototype : Object.prototype)
  const pluginNames = ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer']
  pluginNames.forEach((name, index) => {
    Object.defineProperty(plugins, index, { value: plugin(name), enumerable: true })
  })
  Object.defineProperty(plugins, 'length', { value: pluginNames.length })
  plugins.item = index => plugins[index] ?? null
  plugins.namedItem = name => (pluginNames.includes(name) ? plugin(name) : null)
  plugins.refresh = () => undefined
  define(Navigator.prototype, 'plugins', plugins)
  const chrome = window.chrome ?? {}
  chrome.runtime ??= {}
  chrome.app ??= {
    isInstalled: false,
    InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
    RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
  }
  chrome.csi ??= () => ({ onloadT: Date.now(), startE: Date.now(), pageT: performance.now(), tran: 15 })
  chrome.loadTimes ??= () => ({ commitLoadTime: Date.now() / 1000, startLoadTime: Date.now() / 1000 })
  window.chrome = chrome
  for (const constructor of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    const getParameter = constructor?.prototype?.getParameter
    if (typeof getParameter !== 'function') continue
    constructor.prototype.getParameter = function (parameter) {
      if (parameter === 37445) return ${JSON.stringify(target.vendor)}
      if (parameter === 37446) return ${JSON.stringify(target.renderer)}
      return getParameter.call(this, parameter)
    }
  }
})()`
}

/** One page the override can be sent for; a Playwright `Page` satisfies it. */
export interface StealthPage {
  isClosed(): boolean
}

/** One CDP session; the part of a Playwright `CDPSession` this module uses. */
export interface StealthCdp {
  send(method: 'Emulation.setUserAgentOverride', params: UserAgentOverride): Promise<unknown>
  detach(): Promise<void>
}

/** The context operations stealth needs; a Playwright `BrowserContext` satisfies them. */
export interface StealthContext<Page extends StealthPage> {
  addInitScript(script: { content: string }): Promise<unknown>
  pages(): readonly Page[]
  newCDPSession(page: Page): Promise<StealthCdp>
  on(event: 'page', listener: (page: Page) => void): unknown
  off(event: 'page', listener: (page: Page) => void): unknown
}

/**
 * Give every page of one context the identity: the document-start script, plus
 * the CDP override on each page that exists now and on each page the context
 * opens later, which is what covers new tabs, popups, and a page restored from
 * the persistent profile.
 * @param context - the context every page is created in.
 * @param log - plugin logger for a page whose override could not be sent.
 * @param target - identity to report; defaults to {@link stealthIdentity}.
 * @returns the disposer that stops watching for new pages.
 */
export async function applyStealth<Page extends StealthPage>(
  context: StealthContext<Page>,
  log: Context['logger'],
  target: StealthIdentity = stealthIdentity(),
): Promise<() => void> {
  try {
    await context.addInitScript({ content: stealthInitScript(target) })
  } catch (error: unknown) {
    // The page overrides below still fix the client hints; a browser that
    // launches is worth more to the caller than a failed launch without them.
    log.warn('headless-browser: the stealth script for the context failed: %s', firstLine(error))
  }
  // The override lives on the page's session, so the session must outlive this
  // call. Holding it weakly keeps it alive for exactly as long as its page.
  const sessions = new WeakMap<Page, StealthCdp>()
  const override = async (page: Page): Promise<void> => {
    if (page.isClosed()) return
    try {
      const cdp = await context.newCDPSession(page)
      await cdp.send('Emulation.setUserAgentOverride', userAgentOverride(target))
      sessions.set(page, cdp)
    } catch (error: unknown) {
      // The document-start script still applies; a page without client hints is
      // closer to the browser's own surface than a failed launch would be.
      log.warn('headless-browser: the user-agent override for a page failed: %s', firstLine(error))
    }
  }
  const onPage = (page: Page): void => { void override(page) }
  context.on('page', onPage)
  await Promise.all(context.pages().filter(page => !page.isClosed()).map(override))
  return () => {
    context.off('page', onPage)
  }
}
