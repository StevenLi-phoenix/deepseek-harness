// @vitest-environment jsdom

/** The browser half's entry: dictionaries, the Settings section registration, and the requests it sends to the Host route. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import type { BiliAccountInjected } from '../src/client/BiliAccount.tsx'
import { BiliAccountSection } from '../src/client/BiliAccount.tsx'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'
import { BILI_ROUTE, type BiliView } from '../src/view.ts'

const VIEW: BiliView = {
  account: { account: 'maomao', session: 'ok', checkedAt: 1 },
  gate: null,
  accounts: [],
  speaker: null,
  ledger: null,
  logins: [],
  manage: false,
  manageEnv: 'BILI_SVC_TOKEN_MANAGE',
  manageError: null,
  result: null,
  ownerMid: 0,
  ownerUpdatedAt: null,
  timeZone: 'UTC',
}

interface Spec { name: string; id: string; order: number; label: () => string; locale: string; inject: () => BiliAccountInjected }

/** A client context double that records what the plugin registers. */
function mountEntry() {
  const effects: { run: () => unknown; name: string | undefined }[] = []
  const register = vi.fn(() => () => {})
  const bound = vi.fn((key: string) => `t:${key}`)
  const registered: { spec: Spec; component: unknown }[] = []
  let injection: (() => unknown) | undefined
  const ctx = {
    effect: (run: () => unknown, name?: string) => { effects.push({ run, name }); return () => {} },
    locale: { register, bind: () => bound },
    slots: {
      inject: (slot: string, factory: () => unknown) => { injection = factory; expect(slot).toBe('settings.section') },
      register: (spec: Spec, component: unknown) => { registered.push({ spec, component }); return () => {} },
    },
  }
  apply(ctx as never)
  injection?.()
  return { effects, register, registered }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the browser entry', () => {
  it('needs the slot registry and the locale', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers its eight dictionaries under its own namespace', () => {
    const { effects, register } = mountEntry()
    expect(effects.map(effect => effect.name)).toEqual(['bili: dictionaries'])
    effects[0]!.run()
    expect(register).toHaveBeenCalledWith('bili', { zh, en, ja, es, fr, de, ru, pt })
  })

  it('registers the Settings section after the built-in ones, labelled in the owner\'s language', () => {
    const { registered } = mountEntry()
    expect(registered).toHaveLength(1)
    const { spec, component } = registered[0]!
    expect(spec).toMatchObject({ name: 'settings.section', id: 'bili', order: 45, locale: 'bili' })
    expect(spec.label()).toBe('t:nav')
    expect(component).toBe(BiliAccountSection)
  })

  it('reads the view from the route with the sign-in cookie and the ledger length asked for', async () => {
    const { registered } = mountEntry()
    const injected = registered[0]!.spec.inject()
    const fetchStub = vi.fn(() => Promise.resolve(new Response(JSON.stringify(VIEW), { status: 200 })))
    vi.stubGlobal('fetch', fetchStub)
    injected.refresh()
    await vi.waitFor(() => { expect(injected.hooks.bili.getSnapshot().view).toEqual(VIEW) })
    expect(fetchStub).toHaveBeenCalledWith(`${BILI_ROUTE}?ledger=20`, { credentials: 'same-origin', cache: 'no-store' })
  })

  it('posts an action as JSON and shows the view it answers', async () => {
    const { registered } = mountEntry()
    const injected = registered[0]!.spec.inject()
    const fetchStub = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ...VIEW, ownerMid: 7 }), { status: 200 })))
    vi.stubGlobal('fetch', fetchStub)
    injected.act({ action: 'owner', mid: 7 })
    await vi.waitFor(() => { expect(injected.hooks.bili.getSnapshot().view?.ownerMid).toBe(7) })
    expect(fetchStub).toHaveBeenCalledWith(BILI_ROUTE, {
      credentials: 'same-origin', cache: 'no-store', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'owner', mid: 7 }),
    })
  })

  it('keeps the Host\'s words and code when an action is refused, and falls back to the HTTP status when the body has none', async () => {
    const { registered } = mountEntry()
    const injected = registered[0]!.spec.inject()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: 'the brake is set', code: 'mode_refused' }), { status: 409 }))))
    injected.act({ action: 'gate.mode', mode: 'auto' })
    await vi.waitFor(() => { expect(injected.hooks.bili.getSnapshot().error).toBe('the brake is set') })
    expect(injected.hooks.bili.getSnapshot().errorCode).toBe('mode_refused')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('<html>', { status: 502 }))))
    injected.act({ action: 'brake.release' })
    await vi.waitFor(() => { expect(injected.hooks.bili.getSnapshot().error).toBe('HTTP 502') })
    expect(injected.hooks.bili.getSnapshot().errorCode).toBeNull()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: 5, code: 6 }), { status: 500 }))))
    injected.act({ action: 'brake.release' })
    await vi.waitFor(() => { expect(injected.hooks.bili.getSnapshot().error).toBe('HTTP 500') })
  })

  it('polls a QR sign-in quietly: the view updates and no action shows as busy', async () => {
    const { registered } = mountEntry()
    const injected = registered[0]!.spec.inject()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ...VIEW, ownerMid: 9 }), { status: 200 }))))
    injected.poll({ action: 'login.poll', account: 'maomao' })
    await vi.waitFor(() => { expect(injected.hooks.bili.getSnapshot().view?.ownerMid).toBe(9) })
    expect(injected.hooks.bili.getSnapshot().busy).toBeNull()
  })
})
