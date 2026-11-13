import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/client/index.ts'
import type { CoursesInjected } from '../src/client/CoursesSection.tsx'
import { CoursesSection } from '../src/client/CoursesSection.tsx'
import type { CoursesView } from '../src/view.ts'

const VIEW: CoursesView = {
  enabled: true, timeZone: 'America/New_York', beforeHours: [24], lateBeforeHours: [6], urgentWithinHours: 2,
  quietHours: { followPresence: false, enabled: false, start: '01:00', end: '09:00' }, quietNow: false,
  lastPoll: null, nextPollAt: null, polling: false, sync: null,
  outage: { failures: 0, since: null, alerted: false }, upcoming: [], notes: [],
}

interface Registration {
  descriptor: { name: string; id: string; order: number; label: () => string; locale: string; inject: () => CoursesInjected }
  component: unknown
}

async function mount() {
  const ctx = new Context()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('en')
  ctx.provide('locale', locale)
  const registered: Registration[] = []
  const slots = {
    inject: vi.fn((_slot: string, factory: () => unknown) => { factory() }),
    register: vi.fn((descriptor: Registration['descriptor'], component: unknown) => { registered.push({ descriptor, component }) }),
  }
  ctx.provide('slots', slots as never)
  await ctx.plugin(plugin)
  const section = (): Registration => registered[0]!
  return { ctx, locale, slots, section }
}

const contexts: Context[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('courses-settings client registration', () => {
  it('registers the Settings section after QQ, labelled from the plugin dictionary, and the dictionaries with the locale', async () => {
    const { ctx, locale, slots, section } = await mount()
    contexts.push(ctx)
    expect(slots.inject).toHaveBeenCalledWith('settings.section', expect.any(Function))
    expect(section().descriptor).toMatchObject({ name: 'settings.section', id: 'courses', order: 47, locale: 'courses' })
    expect(section().component).toBe(CoursesSection)
    expect(section().descriptor.label()).toBe('Course deadlines')
    locale.setLocale('zh')
    expect(section().descriptor.label()).toBe('课程 DDL')
  })

  it('reads the status from the document-relative route with the sign-in cookie and shows it through the shared store', async () => {
    const { ctx, section } = await mount()
    contexts.push(ctx)
    const fetcher = vi.fn(async () => Response.json(VIEW))
    vi.stubGlobal('fetch', fetcher)
    const injected = section().descriptor.inject()
    injected.refresh()
    await vi.waitFor(() => { expect(injected.hooks.courses.getSnapshot().view).toEqual(VIEW) })
    expect(fetcher).toHaveBeenCalledWith('api/courses', { credentials: 'same-origin', cache: 'no-store' })
    expect(section().descriptor.inject().hooks.courses).toBe(injected.hooks.courses)
  })

  it('posts a JSON poll when checking now and shows the answer it returns', async () => {
    const { ctx, section } = await mount()
    contexts.push(ctx)
    const fetcher = vi.fn(async () => Response.json({ ...VIEW, polling: true }))
    vi.stubGlobal('fetch', fetcher)
    const injected = section().descriptor.inject()
    injected.checkNow()
    await vi.waitFor(() => { expect(injected.hooks.courses.getSnapshot()).toMatchObject({ view: { polling: true }, checking: false }) })
    expect(fetcher).toHaveBeenCalledWith('api/courses.poll', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: '{}',
    })
  })

  it('keeps the section stale and warns once when the Host answers an error status', async () => {
    const { ctx, section } = await mount()
    contexts.push(ctx)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 503 })))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const injected = section().descriptor.inject()
    injected.refresh()
    await vi.waitFor(() => { expect(injected.hooks.courses.getSnapshot().stale).toBe(true) })
    expect(warn).toHaveBeenCalledWith('[courses-settings] course deadline status read failed')
  })
})
