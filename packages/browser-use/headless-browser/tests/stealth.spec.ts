// @vitest-environment node

/**
 * The stealth identity: what the document-start script changes in a page, the
 * client-hint arguments the per-page CDP override carries, and that turning the
 * option off leaves the browser's own headless surface alone. The last block
 * needs a Chromium binary and skips without one.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { JSDOM } from 'jsdom'
import { chromium } from 'playwright-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config } from '../src/config.ts'
import { HeadlessBrowserSession } from '../src/session.ts'
import {
  applyStealth,
  STEALTH_CHANNEL,
  STEALTH_FULL_VERSION,
  STEALTH_LAUNCH_ARGS,
  stealthIdentity,
  stealthInitScript,
  stealthLaunch,
  userAgentOverride,
  type StealthCdp,
  type StealthContext,
  type StealthPage,
  type UserAgentOverride,
} from '../src/stealth.ts'

const AVAILABLE = existsSync(chromium.executablePath())
const temporary: string[] = []

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function temporaryProfile(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-stealth-'))
  temporary.push(root)
  return join(root, 'profile')
}

function browserConfig(profileDir: string, stealth: boolean): Config {
  return {
    profileDir,
    headless: true,
    stealth,
    viewportWidth: 1280,
    viewportHeight: 800,
    jpegQuality: 50,
    snapshotDir: join(profileDir, 'snapshots'),
  }
}

/** Run the init script in a page of its own and hand back its window. */
function pageOf(): JSDOM {
  const dom = new JSDOM('<!doctype html><title>probe</title>', { runScripts: 'outside-only' })
  dom.window.eval(stealthInitScript())
  return dom
}

describe('the stealth identity', () => {
  it('reports Chrome of the pinned build and never HeadlessChrome', () => {
    const identity = stealthIdentity()
    expect(identity.userAgent).toContain('Chrome/153.0.0.0')
    expect(identity.userAgent).not.toContain('HeadlessChrome')
    expect(identity.brands.map(brand => brand.brand)).toEqual(['Google Chrome', 'Chromium', 'Not_A Brand'])
    expect(identity.fullVersionList[0]).toEqual({ brand: 'Google Chrome', version: STEALTH_FULL_VERSION })
    expect(identity.fullVersion).toBe(STEALTH_FULL_VERSION)
    expect(identity.languages).toEqual(['en-US', 'en'])
    expect(identity.platform).toBe('macOS')
    expect(identity.platformVersion).toBe('15.5.0')
    expect(identity.architecture).toBe('arm64')
    expect(identity.vendor).toBe('Apple M4')
    expect(identity.renderer).toBe('Apple GPU')
    expect(identity.timeZone).not.toBe('')
  })

  it('launches the full Chromium build with the automation flag off', () => {
    expect(stealthLaunch()).toEqual({
      channel: STEALTH_CHANNEL,
      args: [...STEALTH_LAUNCH_ARGS],
      userAgent: stealthIdentity().userAgent,
      locale: 'en-US',
      timeZone: stealthIdentity().timeZone,
    })
    expect(STEALTH_LAUNCH_ARGS).toContain('--disable-blink-features=AutomationControlled')
    expect(STEALTH_LAUNCH_ARGS).toContain('--lang=en-US')
    expect(STEALTH_CHANNEL).toBe('chromium')
    // The flags are a copy, so a launch mutating its settings cannot change the
    // flags the next launch sends.
    const launch = stealthLaunch()
    launch.args.push('--inspect')
    expect(stealthLaunch().args).not.toContain('--inspect')
  })

  it('describes the same browser in the client-hint override', () => {
    const identity = stealthIdentity()
    expect(userAgentOverride()).toEqual({
      userAgent: identity.userAgent,
      acceptLanguage: 'en-US,en',
      platform: 'MacIntel',
      userAgentMetadata: {
        brands: [...identity.brands],
        fullVersionList: [...identity.fullVersionList],
        fullVersion: STEALTH_FULL_VERSION,
        platform: 'macOS',
        platformVersion: '15.5.0',
        architecture: 'arm64',
        bitness: '64',
        model: '',
        mobile: false,
        wow64: false,
      },
    })
  })
})

describe('the document-start script', () => {
  it('replaces the JavaScript surface a headless check reads', async () => {
    const dom = pageOf()
    const probe = dom.window.eval(`JSON.stringify({
      brands: navigator.userAgentData.brands,
      platform: navigator.userAgentData.platform,
      mobile: navigator.userAgentData.mobile,
      toJSON: navigator.userAgentData.toJSON(),
      webdriver: navigator.webdriver === undefined,
      plugins: navigator.plugins.length,
      pluginArray: navigator.plugins instanceof PluginArray,
      pluginTag: Object.prototype.toString.call(navigator.plugins),
      pluginNames: [0, 1, 2].map(index => navigator.plugins.item(index).name),
      named: navigator.plugins.namedItem('Chrome PDF Viewer').name,
      missing: navigator.plugins.namedItem('nope'),
      language: navigator.language,
      languages: navigator.languages,
      chrome: typeof window.chrome.runtime,
      csi: typeof window.chrome.csi(),
    })`) as string
    expect(JSON.parse(probe)).toEqual({
      brands: [
        { brand: 'Google Chrome', version: '153' },
        { brand: 'Chromium', version: '153' },
        { brand: 'Not_A Brand', version: '24' },
      ],
      platform: 'macOS',
      mobile: false,
      toJSON: {
        brands: [
          { brand: 'Google Chrome', version: '153' },
          { brand: 'Chromium', version: '153' },
          { brand: 'Not_A Brand', version: '24' },
        ],
        mobile: false,
        platform: 'macOS',
      },
      webdriver: true,
      plugins: 3,
      pluginArray: true,
      pluginTag: '[object PluginArray]',
      pluginNames: ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer'],
      named: 'Chrome PDF Viewer',
      missing: null,
      language: 'en-US',
      languages: ['en-US', 'en'],
      chrome: 'object',
      csi: 'object',
    })

    const high = await dom.window.eval(
      'navigator.userAgentData.getHighEntropyValues(["platformVersion","architecture","bitness","uaFullVersion","fullVersionList"]).then(JSON.stringify)',
    ) as string
    expect(JSON.parse(high)).toEqual({
      brands: [
        { brand: 'Google Chrome', version: '153' },
        { brand: 'Chromium', version: '153' },
        { brand: 'Not_A Brand', version: '24' },
      ],
      mobile: false,
      platform: 'macOS',
      platformVersion: '15.5.0',
      architecture: 'arm64',
      bitness: '64',
      uaFullVersion: STEALTH_FULL_VERSION,
      fullVersionList: [
        { brand: 'Google Chrome', version: STEALTH_FULL_VERSION },
        { brand: 'Chromium', version: STEALTH_FULL_VERSION },
        { brand: 'Not_A Brand', version: '24.0.0.0' },
      ],
    })
    // A page learns only what it asked for, as in Chrome.
    const narrow = await dom.window.eval(
      'navigator.userAgentData.getHighEntropyValues(["architecture"]).then(JSON.stringify)',
    ) as string
    expect(JSON.parse(narrow)).toEqual({
      brands: [
        { brand: 'Google Chrome', version: '153' },
        { brand: 'Chromium', version: '153' },
        { brand: 'Not_A Brand', version: '24' },
      ],
      mobile: false,
      platform: 'macOS',
      architecture: 'arm64',
    })
    dom.window.close()
  })

  it('reports the identity GPU and leaves every other WebGL parameter alone', () => {
    const dom = new JSDOM('', { runScripts: 'outside-only' })
    class FakeWebGL {
      getParameter(parameter: number): string {
        return `native:${String(parameter)}`
      }
    }
    Object.defineProperty(dom.window, 'WebGLRenderingContext', { value: FakeWebGL, configurable: true })
    Object.defineProperty(dom.window, 'WebGL2RenderingContext', { value: FakeWebGL, configurable: true })
    dom.window.eval(stealthInitScript())
    const gl = new FakeWebGL()
    expect(gl.getParameter(37445)).toBe('Apple M4')
    expect(gl.getParameter(37446)).toBe('Apple GPU')
    expect(gl.getParameter(7936)).toBe('native:7936')
    dom.window.close()
  })

  it('leaves a prototype it cannot redefine and still replaces the rest', () => {
    const dom = new JSDOM('', { runScripts: 'outside-only' })
    Object.defineProperty(dom.window.Navigator.prototype, 'webdriver', {
      get: () => true,
      configurable: false,
    })
    expect(() => { dom.window.eval(stealthInitScript()) }).not.toThrow()
    expect(dom.window.eval('navigator.webdriver')).toBe(true)
    expect(dom.window.eval('navigator.plugins.length')).toBe(3)
    dom.window.close()
  })
})

/** One page of a context that does not need a browser. */
class FakePage implements StealthPage {
  closed = false
  isClosed(): boolean {
    return this.closed
  }
}

/** One scripted CDP session; every override it receives lands in `sent`. */
class FakeCdp implements StealthCdp {
  readonly sent: { method: string; params: UserAgentOverride }[] = []
  detached = false

  async send(method: 'Emulation.setUserAgentOverride', params: UserAgentOverride): Promise<unknown> {
    this.sent.push({ method, params })
    return undefined
  }

  async detach(): Promise<void> {
    this.detached = true
  }
}

/** One scripted context: a page it opens is announced to its listeners. */
class FakeContext implements StealthContext<FakePage> {
  readonly scripts: string[] = []
  readonly opened: FakePage[] = []
  readonly sessions = new Map<FakePage, FakeCdp>()
  readonly listeners = new Set<(page: FakePage) => void>()
  pageEvents = 0
  refuse = false
  refuseScript = false

  async addInitScript(script: { content: string }): Promise<unknown> {
    if (this.refuseScript) throw new Error('the context is gone')
    this.scripts.push(script.content)
    return undefined
  }

  pages(): readonly FakePage[] {
    return this.opened
  }

  async newCDPSession(page: FakePage): Promise<StealthCdp> {
    if (this.refuse) throw new Error('the page has no debugger')
    const cdp = new FakeCdp()
    this.sessions.set(page, cdp)
    return cdp
  }

  on(event: 'page', listener: (page: FakePage) => void): unknown {
    this.pageEvents += event === 'page' ? 1 : 0
    this.listeners.add(listener)
    return undefined
  }

  off(event: 'page', listener: (page: FakePage) => void): unknown {
    this.pageEvents += event === 'page' ? 1 : 0
    this.listeners.delete(listener)
    return undefined
  }

  /** Announce a page the way the context's event does. */
  open(page: FakePage = new FakePage()): FakePage {
    this.opened.push(page)
    for (const listener of [...this.listeners]) listener(page)
    return page
  }
}

/** Let the fire-and-forget override of a new page settle. */
async function settled(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('applying the identity to a context', () => {
  it('installs the script and overrides pages that exist and pages opened later', async () => {
    const context = new FakeContext()
    const existing = context.open()
    const stop = await applyStealth(context, new Context().logger)
    expect(context.scripts).toEqual([stealthInitScript()])
    expect(context.pageEvents).toBe(1)
    expect(context.sessions.get(existing)?.sent).toEqual([
      { method: 'Emulation.setUserAgentOverride', params: userAgentOverride() },
    ])

    const later = context.open()
    await settled()
    expect(context.sessions.get(later)?.sent).toHaveLength(1)

    stop()
    expect(context.listeners.size).toBe(0)
    context.open()
    await settled()
    expect(context.sessions.size).toBe(2)
  })

  it('skips a closed page and keeps going when one override is refused', async () => {
    const context = new FakeContext()
    const closed = context.open()
    closed.closed = true
    const log = new Context().logger
    const warn = vi.spyOn(log, 'warn')
    context.refuse = true
    const stop = await applyStealth(context, log, stealthIdentity())
    expect(context.sessions.size).toBe(0)
    // A page that closed before the listener ran asks for no override at all.
    const gone = new FakePage()
    gone.closed = true
    context.open(gone)
    await settled()
    expect(context.sessions.has(gone)).toBe(false)
    context.open()
    await settled()
    expect(warn).toHaveBeenCalledWith(
      'headless-browser: the user-agent override for a page failed: %s',
      'the page has no debugger',
    )
    stop()
  })

  it('keeps the page overrides when the context refuses the script', async () => {
    const context = new FakeContext()
    context.refuseScript = true
    const page = context.open()
    const log = new Context().logger
    const warn = vi.spyOn(log, 'warn')
    const stop = await applyStealth(context, log)
    expect(context.scripts).toEqual([])
    expect(warn).toHaveBeenCalledWith(
      'headless-browser: the stealth script for the context failed: %s',
      'the context is gone',
    )
    expect(context.sessions.get(page)?.sent).toHaveLength(1)
    stop()
  })
})

/** Validate an input the way the Loader does, with every unset field defaulted. */
function resolve(input: Partial<Config>): Config {
  return Config(input as Config)
}

describe('the configuration', () => {
  it('turns stealth on unless the composition says otherwise', () => {
    expect(resolve({}).stealth).toBe(true)
    expect(resolve({ stealth: false }).stealth).toBe(false)
  })
})

describe.skipIf(!AVAILABLE)('stealth in a real browser', () => {
  /** One local page that records the request headers it was asked with. */
  async function servedPage(): Promise<{
    url: string
    header: (name: string) => string
    server: Server
  }> {
    let recorded: IncomingHttpHeaders = {}
    const server = createServer((request, response) => {
      recorded = { ...request.headers }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><title>probe</title><body>probe')
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('the probe server has no port')
    return {
      url: `http://127.0.0.1:${String(address.port)}/`,
      header: (name) => {
        const value = recorded[name]
        return Array.isArray(value) ? value.join(',') : value ?? ''
      },
      server,
    }
  }

  it('reports Chrome, not HeadlessChrome, in JavaScript and in the client hints', async () => {
    const probe = await servedPage()
    const browser = new HeadlessBrowserSession(browserConfig(temporaryProfile(), true), new Context().logger)
    try {
      await browser.open(probe.url)
      const page = await browser.page()
      const surface: {
        brands: string[]
        platform: string
        userAgent: string
        automationHidden: boolean
        plugins: number
        languages: string[]
        chrome: string
        vendor: string
      } = JSON.parse(await page.evaluate(`JSON.stringify({
        brands: navigator.userAgentData.brands.map(brand => brand.brand),
        platform: navigator.userAgentData.platform,
        userAgent: navigator.userAgent,
        automationHidden: navigator.webdriver === undefined,
        plugins: navigator.plugins.length,
        languages: navigator.languages,
        chrome: typeof window.chrome,
        vendor: (() => {
          const gl = document.createElement('canvas').getContext('webgl')
          return gl === null ? '' : String(gl.getParameter(37445))
        })(),
      })`) as string)
      expect(surface).toMatchObject({
        brands: ['Google Chrome', 'Chromium', 'Not_A Brand'],
        platform: 'macOS',
        plugins: 3,
        languages: ['en-US', 'en'],
        chrome: 'object',
        vendor: 'Apple M4',
        automationHidden: true,
      })
      expect(surface.userAgent).toContain('Chrome/153.0.0.0')
      expect(probe.header('sec-ch-ua')).toContain('Google Chrome')
      expect(probe.header('sec-ch-ua')).not.toContain('HeadlessChrome')
      expect(probe.header('user-agent')).toContain('Chrome/153.0.0.0')
    } finally {
      await browser.close()
      await new Promise<void>((resolve) => { probe.server.close(() => { resolve() }) })
    }
  }, 120_000)

  it('leaves the browser announcing itself as headless when the option is off', async () => {
    const probe = await servedPage()
    const browser = new HeadlessBrowserSession(browserConfig(temporaryProfile(), false), new Context().logger)
    try {
      await browser.open(probe.url)
      const page = await browser.page()
      const surface: { brands: string[]; webdriver: boolean } = JSON.parse(await page.evaluate(`JSON.stringify({
        brands: navigator.userAgentData.brands.map(brand => brand.brand),
        webdriver: navigator.webdriver,
      })`) as string)
      expect(surface).toEqual({ brands: expect.arrayContaining(['HeadlessChrome']), webdriver: true })
      expect(probe.header('sec-ch-ua')).toContain('HeadlessChrome')
    } finally {
      await browser.close()
      await new Promise<void>((resolve) => { probe.server.close(() => { resolve() }) })
    }
  }, 120_000)
})
