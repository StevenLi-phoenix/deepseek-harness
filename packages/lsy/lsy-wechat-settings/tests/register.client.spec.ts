import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/client/index.ts'
import type { PresenceInjected } from '../src/client/presence/index.ts'
import { startPolling as startPresencePolling } from '../src/client/presence/presence.ts'
import { PresenceSection } from '../src/client/presence/PresenceSection.tsx'
import type { WechatInjected } from '../src/client/wechat/index.ts'
import { startPolling as startWechatPolling } from '../src/client/wechat/wechat.ts'
import { WechatSection } from '../src/client/wechat/WechatSection.tsx'
import type { PresenceView } from '../src/presence-view.ts'
import type { LoginSnapshot, WechatView } from '../src/wechat-view.ts'

const WECHAT: WechatView = {
  binding: { state: 'unbound' },
  channel: { link: 'idle', lastPollAt: null, failures: 0, lastError: null, lastInboundAt: null, lastOutboundAt: null, lastOutboundKind: null },
  window: { open: false, closed: 'no-account', repliesLeft: null, repliesPerToken: 10, expiresAt: null },
  outbox: { count: 0, limit: 50, oldestAt: null },
  loginActive: false,
  timeZone: 'America/New_York',
}
const LOGIN: LoginSnapshot = { key: 'k1', phase: 'waiting', qr: null, codeRetry: false, failure: null }
const PRESENCE: PresenceView = {
  asleep: false,
  source: 'window',
  since: null,
  until: null,
  manual: null,
  lastFocus: null,
  window: { enabled: true, start: '03:30', end: '10:30' },
  deferred: 0,
  urgentKinds: [],
  signalSilent: true,
  focusFreshHours: 2,
  timeZone: 'America/New_York',
}

const GET = { credentials: 'same-origin', cache: 'no-store' }
const postOf = (action: unknown) => ({ ...GET, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) })

interface Registration<Injected> {
  descriptor: { name: string; id: string; order: number; label: () => string; locale: string; inject: () => Injected }
  component: unknown
}

const contexts: Context[] = []

async function mount() {
  const ctx = new Context()
  contexts.push(ctx)
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('en')
  ctx.provide('locale', locale)
  const registered: Array<Registration<never>> = []
  const slots = {
    inject: vi.fn((_slot: string, factory: () => unknown) => { factory() }),
    register: vi.fn((descriptor: Registration<never>['descriptor'], component: unknown) => { registered.push({ descriptor, component }) }),
  }
  ctx.provide('slots', slots as never)
  await ctx.plugin(plugin)
  const wechat: Registration<WechatInjected> = registered[0]!
  const presence: Registration<PresenceInjected> = registered[1]!
  return { locale, slots, wechat, presence }
}

function stubFetch(respond: () => Response) {
  const fetcher = vi.fn(async (_route: string, _init: RequestInit) => respond())
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('lsy-wechat-settings entries', () => {
  it('needs no more than the slots and locale in the browser', () => {
    expect(plugin.inject).toEqual(['slots', 'locale'])
  })

  it('registers both sections after the built-in ones, labelled from their dictionaries', async () => {
    const { locale, slots, wechat, presence } = await mount()
    expect(slots.inject.mock.calls.map(call => call[0])).toEqual(['settings.section', 'settings.section'])
    expect(wechat.descriptor).toMatchObject({ name: 'settings.section', id: 'lsy-wechat', order: 52, locale: 'lsy.wechat' })
    expect(wechat.component).toBe(WechatSection)
    expect(presence.descriptor).toMatchObject({ name: 'settings.section', id: 'lsy-presence', order: 53, locale: 'lsy.presence' })
    expect(presence.component).toBe(PresenceSection)
    expect(wechat.descriptor.label()).toBe('WeChat')
    expect(presence.descriptor.label()).toBe('Quiet hours')
    locale.setLocale('zh')
    expect(wechat.descriptor.label()).toBe('微信')
    expect(presence.descriptor.label()).toBe('勿扰')
  })
})

describe('WeChat section requests', () => {
  /** Run one action and wait until the store has settled it. */
  async function settle(injected: WechatInjected, run: () => void) {
    run()
    await vi.waitFor(() => { expect(injected.hooks.wechat.getSnapshot().busy).toBeNull() })
  }

  it('reads the status from the document-relative route with the sign-in cookie, into a store shared across renders', async () => {
    const { wechat } = await mount()
    const fetcher = stubFetch(() => Response.json({ view: WECHAT, login: null }))
    const injected = wechat.descriptor.inject()
    injected.refresh()
    await vi.waitFor(() => { expect(injected.hooks.wechat.getSnapshot().view).toEqual(WECHAT) })
    expect(fetcher).toHaveBeenCalledWith('api/lsy.wechat', GET)
    expect(wechat.descriptor.inject()).toBe(injected)
  })

  it('posts each action as JSON and follows the login through the panel', async () => {
    const { wechat } = await mount()
    let login = LOGIN
    const fetcher = stubFetch(() => Response.json({ view: WECHAT, login }))
    const injected = wechat.descriptor.inject()
    const snapshot = () => injected.hooks.wechat.getSnapshot()
    await settle(injected, () => { injected.startLogin() })
    expect(fetcher).toHaveBeenLastCalledWith('api/lsy.wechat', postOf({ action: 'login.start' }))
    expect(snapshot().login).toEqual(LOGIN)
    login = { ...LOGIN, phase: 'needs-code' }
    injected.pollLogin()
    expect(fetcher).toHaveBeenLastCalledWith('api/lsy.wechat', postOf({ action: 'login.poll', key: 'k1' }))
    await vi.waitFor(() => { expect(snapshot().login?.phase).toBe('needs-code') })
    login = { ...LOGIN, phase: 'scanned' }
    await settle(injected, () => { injected.submitCode('4821') })
    expect(fetcher).toHaveBeenLastCalledWith('api/lsy.wechat', postOf({ action: 'login.code', key: 'k1', code: '4821' }))
    expect(snapshot().login?.phase).toBe('scanned')
    injected.cancelLogin()
    expect(fetcher).toHaveBeenLastCalledWith('api/lsy.wechat', postOf({ action: 'login.cancel', key: 'k1' }))
    expect(snapshot().login).toBeNull()
    await settle(injected, () => { injected.unbind() })
    expect(fetcher).toHaveBeenLastCalledWith('api/lsy.wechat', postOf({ action: 'unbind', confirm: 'unbind' }))
    expect(fetcher).toHaveBeenCalledTimes(5)
  })

  it('closes a finished panel without asking the Host', async () => {
    const { wechat } = await mount()
    const fetcher = stubFetch(() => Response.json({ view: WECHAT, login: { ...LOGIN, phase: 'done' } }))
    const injected = wechat.descriptor.inject()
    await settle(injected, () => { injected.startLogin() })
    expect(injected.hooks.wechat.getSnapshot().login?.phase).toBe('done')
    injected.dismissLogin()
    expect(injected.hooks.wechat.getSnapshot().login).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('shows the route\'s error text, or the HTTP status when the body has none', async () => {
    const { wechat } = await mount()
    const injected = wechat.descriptor.inject()
    const snapshot = () => injected.hooks.wechat.getSnapshot()
    stubFetch(() => Response.json({ error: 'no bot is bound' }, { status: 409 }))
    await settle(injected, () => { injected.unbind() })
    expect(snapshot().error).toBe('no bot is bound')
    stubFetch(() => Response.json({ error: { code: 7 } }, { status: 502 }))
    await settle(injected, () => { injected.unbind() })
    expect(snapshot().error).toBe('HTTP 502')
    stubFetch(() => new Response('<html>down</html>', { status: 503 }))
    await settle(injected, () => { injected.unbind() })
    expect(snapshot().error).toBe('HTTP 503')
    stubFetch(() => Response.json({ view: null }))
    await settle(injected, () => { injected.unbind() })
    expect(snapshot().error).toBe('unexpected WeChat answer')
  })

  it('carries the HTTP status, so a login the Host forgot closes its panel', async () => {
    const { wechat } = await mount()
    const injected = wechat.descriptor.inject()
    stubFetch(() => Response.json({ view: WECHAT, login: LOGIN }))
    await settle(injected, () => { injected.startLogin() })
    const fetcher = stubFetch(() => Response.json({ error: 'that login is gone' }, { status: 404 }))
    injected.pollLogin()
    await vi.waitFor(() => { expect(injected.hooks.wechat.getSnapshot().login).toBeNull() })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe('Quiet-hours section requests', () => {
  async function settle(injected: PresenceInjected, run: () => void) {
    run()
    await vi.waitFor(() => { expect(injected.hooks.presence.getSnapshot().busy).toBeNull() })
  }

  it('reads the status from the document-relative route with the sign-in cookie, into a store shared across renders', async () => {
    const { presence } = await mount()
    const fetcher = stubFetch(() => Response.json({ view: PRESENCE, flushed: null }))
    const injected = presence.descriptor.inject()
    injected.refresh()
    await vi.waitFor(() => { expect(injected.hooks.presence.getSnapshot().view).toEqual(PRESENCE) })
    expect(fetcher).toHaveBeenCalledWith('api/lsy.presence', GET)
    expect(presence.descriptor.inject()).toBe(injected)
  })

  it('posts a button as JSON and shows the answer', async () => {
    const { presence } = await mount()
    const fetcher = stubFetch(() => Response.json({ view: PRESENCE, flushed: 2 }))
    const injected = presence.descriptor.inject()
    await settle(injected, () => { injected.act({ action: 'flush' }) })
    expect(fetcher).toHaveBeenCalledWith('api/lsy.presence', postOf({ action: 'flush' }))
    expect(injected.hooks.presence.getSnapshot()).toMatchObject({ view: PRESENCE, flushed: 2, error: null })
  })

  it('shows the route\'s error text, or the HTTP status when the body has none', async () => {
    const { presence } = await mount()
    const injected = presence.descriptor.inject()
    const snapshot = () => injected.hooks.presence.getSnapshot()
    stubFetch(() => Response.json({ error: 'the window must not be empty' }, { status: 400 }))
    await settle(injected, () => { injected.act({ action: 'sleep.now' }) })
    expect(snapshot().error).toBe('the window must not be empty')
    stubFetch(() => Response.json({ error: 7 }, { status: 502 }))
    await settle(injected, () => { injected.act({ action: 'sleep.now' }) })
    expect(snapshot().error).toBe('HTTP 502')
    stubFetch(() => new Response('<html>down</html>', { status: 503 }))
    await settle(injected, () => { injected.act({ action: 'sleep.now' }) })
    expect(snapshot().error).toBe('HTTP 503')
    stubFetch(() => Response.json({ view: null }))
    await settle(injected, () => { injected.act({ action: 'sleep.now' }) })
    expect(snapshot().error).toBe('unexpected quiet-hours answer')
  })
})

describe('polling outside a browser', () => {
  it.each([
    ['WeChat', startWechatPolling],
    ['quiet hours', startPresencePolling],
  ])('%s polls on its timer with no document to watch', (_name, startPolling) => {
    expect('document' in globalThis).toBe(false)
    vi.useFakeTimers()
    const refresh = vi.fn()
    const stop = startPolling(refresh, 1000)
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2000)
    expect(refresh).toHaveBeenCalledTimes(3)
    stop()
    vi.advanceTimersByTime(2000)
    expect(refresh).toHaveBeenCalledTimes(3)
  })
})
