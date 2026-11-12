/** What the browser half registers, how it talks to the Host route, and that it all leaves with the fiber. */

import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/client/index.ts'
import type { GmailInjected } from '../src/client/GmailSection.tsx'
import { GmailSection } from '../src/client/GmailSection.tsx'
import type { GmailView } from '../src/view.ts'

const VIEW: GmailView = {
  client: { configured: true, clientId: 'abc.apps.googleusercontent.com', secretConfigured: true },
  redirectUri: null, accounts: [], pending: [], activity: [], maxSendsPerDay: 50, confirmTtlHours: 72, trustedRecipients: [],
}
const GET = { credentials: 'same-origin', cache: 'no-store' }

const fibers: Array<{ dispose: () => Promise<unknown> }> = []

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('en')
  ctx.provide('locale', locale)
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
  const fiber = ctx.plugin(plugin)
  fibers.push(fiber)
  await fiber.await()
  const section = () => slots.entries('settings.section')[0]!
  // The registry erases the inject face to a record; the mapped `Pick` names it again.
  const injected = () => (section().inject as () => Pick<GmailInjected, keyof GmailInjected>)()
  return { locale, slots, fiber, section, injected }
}

function stubBrowser(respond: (init?: RequestInit) => Response | Promise<Response>) {
  const fetcher = vi.fn(async (_route: string, init?: RequestInit) => respond(init))
  const assign = vi.fn()
  const writeText = vi.fn(async (_text: string) => {})
  vi.stubGlobal('fetch', fetcher)
  vi.stubGlobal('window', { location: { origin: 'https://dsh.example.com', assign } })
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  return { fetcher, assign, writeText }
}

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await Promise.all(fibers.splice(0).map(fiber => fiber.dispose()))
})

describe('fork-gmail-settings client registration', () => {
  it('registers the 邮箱 section after 课程 DDL, labelled from its dictionaries in the current locale', async () => {
    const { locale, section } = await bench()
    expect(plugin.inject).toEqual(['slots', 'locale'])
    expect(section().options).toMatchObject({ id: 'fork-gmail', order: 48 })
    expect(section().locale).toBe('fork.gmail')
    expect(section().component).toBe(GmailSection)
    expect(resolveSlotLabel(section().options.label)).toBe('Email')
    locale.setLocale('zh')
    expect(resolveSlotLabel(section().options.label)).toBe('邮箱')
  })

  it('reads the status from the document-relative route with the sign-in cookie into one shared store', async () => {
    const { injected } = await bench()
    const { fetcher } = stubBrowser(() => Response.json({ status: VIEW }))
    const face = injected()
    face.refresh()
    await vi.waitFor(() => { expect(face.hooks.gmail.getSnapshot().view).toEqual(VIEW) })
    expect(fetcher).toHaveBeenCalledWith('api/fork.gmail', GET)
    expect(injected().hooks.gmail).toBe(face.hooks.gmail)
    expect(face.origin).toBe('https://dsh.example.com')
  })

  it('posts an action as JSON and opens the sign-in page the answer names in this tab', async () => {
    const { injected } = await bench()
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    const { fetcher, assign } = stubBrowser(() => Response.json({ status: VIEW, signInUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' }))
    const action = { action: 'sign-in', account: 'work', policy: 'confirm-untrusted' } as const
    expect(await injected().act(action)).toBe(true)
    expect(fetcher).toHaveBeenCalledWith('api/fork.gmail', {
      ...GET, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action),
    })
    expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?state=s')
  })

  it('shows a 400 refusal in the Host\'s words, and a 500, a 400 without words, or a lost connection as generic failures', async () => {
    const { injected } = await bench()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let answer: () => Response | Promise<Response> = () => Response.json({ error: 'unknown account work' }, { status: 400 })
    stubBrowser(() => answer())
    const face = injected()
    const remove = { action: 'remove', account: 'work' } as const
    expect(await face.act(remove)).toBe(false)
    expect(face.hooks.gmail.getSnapshot().failure).toEqual({ control: 'remove:work', kind: 'refused', message: 'unknown account work' })
    answer = () => Response.json({ error: 'the action failed; the DSH log has the details' }, { status: 500 })
    await face.act(remove)
    expect(face.hooks.gmail.getSnapshot().failure).toEqual({ control: 'remove:work', kind: 'failed' })
    answer = () => new Response('not json', { status: 400 })
    await face.act(remove)
    expect(face.hooks.gmail.getSnapshot().failure).toEqual({ control: 'remove:work', kind: 'failed' })
    answer = () => Promise.reject(new TypeError('Failed to fetch'))
    await face.act(remove)
    expect(face.hooks.gmail.getSnapshot().failure).toEqual({ control: 'remove:work', kind: 'offline' })
  })

  it('keeps the section stale when the status read answers an error', async () => {
    const { injected } = await bench()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubBrowser(() => new Response('no', { status: 503 }))
    const face = injected()
    face.refresh()
    await vi.waitFor(() => { expect(face.hooks.gmail.getSnapshot().stale).toBe(true) })
  })

  it('writes the redirect URI to the clipboard', async () => {
    const { injected } = await bench()
    const { writeText } = stubBrowser(() => Response.json({ status: VIEW }))
    await injected().copy('https://dsh.example.com/fork.gmail.oauth')
    expect(writeText).toHaveBeenCalledWith('https://dsh.example.com/fork.gmail.oauth')
  })

  it('removes the section and its dictionaries when the plugin is disposed', async () => {
    const { locale, slots, fiber } = await bench()
    expect(slots.entries('settings.section')).toHaveLength(1)
    expect(locale.bind('fork.gmail')('nav')).toBe('Email')
    await fiber.dispose()
    expect(slots.entries('settings.section')).toHaveLength(0)
    expect(locale.bind('fork.gmail')('nav')).toBe('nav')
  })
})
